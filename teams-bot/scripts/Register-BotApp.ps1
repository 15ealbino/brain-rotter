#Requires -Version 7.0
<#
.SYNOPSIS
    Registers (or updates) the Entra ID application for the Brain Rotter Teams recording bot,
    adds the Microsoft Graph application permissions it needs, and prints the admin-consent URL.

.DESCRIPTION
    Idempotent. Run it as many times as you like:
      * an existing app with the same display name is reused, never duplicated;
      * permissions already present are left alone;
      * a client secret is only created when -CreateSecret is passed.

    Everything it changes is printed at the end, along with the exact environment variables to set.

    This script does NOT grant admin consent for you. Consent is a deliberate act by a Global
    Administrator, and Calls.AccessMedia.All in particular gives an application the ability to
    receive the audio and video of meetings it is invited to. You get a URL to click.

.PARAMETER DisplayName
    Display name for the Entra application.

.PARAMETER TenantId
    Tenant to register in. Defaults to the tenant of the signed-in account.

.PARAMETER CreateSecret
    Create a new client secret and print it once. Without this, no secret is generated.

.PARAMETER SecretValidDays
    Lifetime of the generated secret. Defaults to 180.

.PARAMETER WhatIfOnly
    Report what would change and exit without writing anything.

.EXAMPLE
    pwsh ./Register-BotApp.ps1 -CreateSecret

.NOTES
    Requires the Microsoft.Graph PowerShell SDK:
        Install-Module Microsoft.Graph -Scope CurrentUser
#>
[CmdletBinding()]
param(
    [string]$DisplayName = 'Brain Rotter Teams Recorder',
    [string]$TenantId,
    [switch]$CreateSecret,
    [int]$SecretValidDays = 180,
    [switch]$WhatIfOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------------------------
# The permissions this bot needs.
#
# Verified against the Microsoft Graph permissions reference and the API pages for
# `POST /communications/calls` and `call: updateRecordingStatus` (checked 2026-08).
# The GUIDs are the well-known Microsoft Graph appRole ids and are stable across tenants.
# --------------------------------------------------------------------------------------------
$GraphAppId = '00000003-0000-0000-c000-000000000000'

$RequiredPermissions = @(
    @{
        Name     = 'Calls.AccessMedia.All'
        Id       = 'a7a681dc-756e-4909-b988-f160edc6655f'
        Why      = 'Receive the raw audio stream, and the least-privileged permission accepted by updateRecordingStatus. Without this there is no recording at all.'
        Required = $true
    },
    @{
        Name     = 'Calls.JoinGroupCall.All'
        Id       = 'f6b49018-60ab-4f81-83bd-22caeabfed2d'
        Why      = 'Join a scheduled meeting as the application identity.'
        Required = $true
    },
    @{
        Name     = 'Calls.JoinGroupCallAsGuest.All'
        Id       = 'fd7ccf6b-3d28-418b-9701-cd10f5cd2fd4'
        Why      = 'Join as an anonymous guest. Only needed if you set a display name on join; the bot does not do this by default. Included because removing it later is easier than adding it during an incident.'
        Required = $false
    },
    @{
        Name     = 'OnlineMeetings.Read.All'
        Id       = 'c1684f21-1984-47fa-9d61-2dc8c296bb70'
        Why      = 'Look a meeting up by its VTC conference id instead of a join URL. Optional for the join-URL flow.'
        Required = $false
    }
)

# Deliberately NOT requested, and why:
#   Calls.Initiate.All / Calls.InitiateGroupCall.All
#       Let an app place outbound calls to people. This bot only ever joins meetings it is
#       pointed at, so granting it the ability to ring users would be strictly more authority
#       than it needs.
#   Teamwork.Migrate.All
#       The only application permission Graph offers for posting a chat message, and it is
#       scoped to message import/migration. The bot announces via the Bot Framework Connector
#       instead, which needs no Graph permission.
#   OnlineMeetingRecording.Read.All / OnlineMeetingTranscript.Read.All
#       For reading Teams' own recordings. This bot makes its own; it does not read anyone else's.

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * $Text.Length) -ForegroundColor DarkGray
}

$changes = [System.Collections.Generic.List[string]]::new()
$noops = [System.Collections.Generic.List[string]]::new()

# --------------------------------------------------------------------------------------------
# Connect
# --------------------------------------------------------------------------------------------
Write-Section 'Connecting to Microsoft Graph'

if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Applications)) {
    throw "The Microsoft.Graph PowerShell SDK is not installed. Run: Install-Module Microsoft.Graph -Scope CurrentUser"
}

Import-Module Microsoft.Graph.Applications -ErrorAction Stop

$connectArgs = @{
    Scopes    = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'Directory.Read.All')
    NoWelcome = $true
}
if ($TenantId) { $connectArgs['TenantId'] = $TenantId }

Connect-MgGraph @connectArgs
$context = Get-MgContext
$TenantId = $context.TenantId
Write-Host "Signed in as $($context.Account) in tenant $TenantId"

# --------------------------------------------------------------------------------------------
# Application
# --------------------------------------------------------------------------------------------
Write-Section 'Application registration'

$escaped = $DisplayName.Replace("'", "''")
$app = Get-MgApplication -Filter "displayName eq '$escaped'" -ConsistencyLevel eventual -CountVariable c -ErrorAction SilentlyContinue | Select-Object -First 1

if ($app) {
    Write-Host "Found existing application '$DisplayName' (appId $($app.AppId))."
    $noops.Add("Application '$DisplayName' already existed - reused, not recreated.")
}
else {
    if ($WhatIfOnly) {
        Write-Host "WOULD CREATE application '$DisplayName'." -ForegroundColor Yellow
        $changes.Add("WOULD create application '$DisplayName'.")
    }
    else {
        # SignInAudience: AzureADMyOrg == single tenant. Matches Bot:SingleTenantBot = true.
        # A calling bot has no sign-in UI, so there are no redirect URIs to configure.
        $app = New-MgApplication -DisplayName $DisplayName -SignInAudience 'AzureADMyOrg'
        Write-Host "Created application '$DisplayName' (appId $($app.AppId))." -ForegroundColor Green
        $changes.Add("Created application '$DisplayName' with appId $($app.AppId).")
    }
}

if (-not $app) {
    Write-Host ''
    Write-Host 'Nothing further to do in -WhatIfOnly mode without an application.' -ForegroundColor Yellow
    return
}

# --------------------------------------------------------------------------------------------
# Permissions
# --------------------------------------------------------------------------------------------
Write-Section 'Microsoft Graph application permissions'

$existingGraph = @()
if ($app.RequiredResourceAccess) {
    $graphEntry = $app.RequiredResourceAccess | Where-Object { $_.ResourceAppId -eq $GraphAppId }
    if ($graphEntry) { $existingGraph = @($graphEntry.ResourceAccess) }
}

$existingIds = @($existingGraph | ForEach-Object { $_.Id })
$desired = [System.Collections.Generic.List[hashtable]]::new()
foreach ($p in $existingGraph) { $desired.Add(@{ Id = $p.Id; Type = $p.Type }) }

$added = $false
foreach ($permission in $RequiredPermissions) {
    if ($existingIds -contains $permission.Id) {
        Write-Host ("  = {0,-34} already present" -f $permission.Name)
        $noops.Add("Permission $($permission.Name) was already present.")
    }
    else {
        Write-Host ("  + {0,-34} adding" -f $permission.Name) -ForegroundColor Green
        Write-Host ("      {0}" -f $permission.Why) -ForegroundColor DarkGray
        # Type 'Role' == application permission (app-only). 'Scope' would be delegated.
        $desired.Add(@{ Id = $permission.Id; Type = 'Role' })
        $changes.Add("Added application permission $($permission.Name).")
        $added = $true
    }
}

if ($added) {
    if ($WhatIfOnly) {
        Write-Host 'WOULD write the permission set to the application.' -ForegroundColor Yellow
    }
    else {
        Update-MgApplication -ApplicationId $app.Id -RequiredResourceAccess @(
            @{ ResourceAppId = $GraphAppId; ResourceAccess = $desired.ToArray() }
        )
        Write-Host 'Permission set written.' -ForegroundColor Green
    }
}
else {
    Write-Host 'No permission changes needed.'
}

# --------------------------------------------------------------------------------------------
# Service principal (needed before consent can be granted)
# --------------------------------------------------------------------------------------------
Write-Section 'Service principal'

$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($sp) {
    Write-Host "Service principal already exists (id $($sp.Id))."
    $noops.Add('Service principal already existed.')
}
elseif ($WhatIfOnly) {
    Write-Host 'WOULD create the service principal.' -ForegroundColor Yellow
}
else {
    $sp = New-MgServicePrincipal -AppId $app.AppId
    Write-Host "Created service principal (id $($sp.Id))." -ForegroundColor Green
    $changes.Add('Created the service principal.')
}

# --------------------------------------------------------------------------------------------
# Secret
# --------------------------------------------------------------------------------------------
$secretValue = $null
Write-Section 'Client secret'

if (-not $CreateSecret) {
    Write-Host 'Skipped (-CreateSecret not passed). Existing secrets are untouched.'
    $noops.Add('No client secret was created.')
}
elseif ($WhatIfOnly) {
    Write-Host 'WOULD create a new client secret.' -ForegroundColor Yellow
}
else {
    $credential = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
        DisplayName = "brain-rotter-bot-$(Get-Date -Format yyyyMMdd)"
        EndDateTime = (Get-Date).AddDays($SecretValidDays)
    }
    $secretValue = $credential.SecretText
    Write-Host "Created a client secret valid for $SecretValidDays days." -ForegroundColor Green
    $changes.Add("Created a client secret (expires $($credential.EndDateTime.ToString('yyyy-MM-dd'))).")
}

# --------------------------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------------------------
Write-Section 'What this run changed'
if ($changes.Count -eq 0) { Write-Host '  (nothing - everything was already in place)' }
else { $changes | ForEach-Object { Write-Host "  * $_" -ForegroundColor Green } }

if ($noops.Count -gt 0) {
    Write-Host ''
    Write-Host 'Left alone:' -ForegroundColor DarkGray
    $noops | ForEach-Object { Write-Host "  - $_" -ForegroundColor DarkGray }
}

$consentUrl = "https://login.microsoftonline.com/$TenantId/adminconsent?client_id=$($app.AppId)"

Write-Section 'NEXT: grant admin consent'
Write-Host 'A Global Administrator must open this URL and approve:'
Write-Host ''
Write-Host "  $consentUrl" -ForegroundColor Yellow
Write-Host ''
Write-Host 'Read the consent screen. Calls.AccessMedia.All lets this application receive the audio'
Write-Host 'and video of any meeting it is invited to in this tenant. Grant it on a tenant you own.'

Write-Section 'Configuration'
Write-Host 'Set these where the bot runs (never commit them):'
Write-Host ''
Write-Host "  Bot__AppId=$($app.AppId)"
Write-Host "  Bot__TenantId=$TenantId"
if ($secretValue) {
    Write-Host "  Bot__AppSecret=$secretValue" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  ^ Shown once. Copy it now; Entra will not show it again.' -ForegroundColor Yellow
}
else {
    Write-Host '  Bot__AppSecret=<re-run with -CreateSecret, or use an existing secret>'
}

Write-Host ''
Write-Host 'For local development, prefer user-secrets over environment variables:'
Write-Host '  cd teams-bot/src/BrainRotter.TeamsBot'
Write-Host "  dotnet user-secrets set Bot:AppId $($app.AppId)"
Write-Host "  dotnet user-secrets set Bot:TenantId $TenantId"
Write-Host '  dotnet user-secrets set Bot:AppSecret <secret>'

Write-Section 'Then'
Write-Host '  1. Register an Azure Bot resource with this same app id and set its messaging'
Write-Host "     endpoint to https://<your-host>/api/calls, then enable the Teams channel with calling."
Write-Host '  2. Build the Teams app package:'
Write-Host "       pwsh ./scripts/Package-TeamsApp.ps1 -BotAppId $($app.AppId) -BotHostname <your-host>"
Write-Host '  3. Upload teams-bot/dist/brain-rotter-recorder.zip in Teams.'
Write-Host ''
Write-Host 'Full walkthrough: teams-bot/README.md'
