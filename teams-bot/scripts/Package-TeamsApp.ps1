#Requires -Version 7.0
<#
.SYNOPSIS
    Builds the sideloadable Teams app package, substituting the manifest placeholders.

.EXAMPLE
    pwsh ./Package-TeamsApp.ps1 -BotAppId 1111... -BotHostname bot.contoso.com

.NOTES
    Writes teams-bot/dist/brain-rotter-recorder.zip. Refuses to produce a zip with unreplaced
    placeholders, because Teams' error message for a bad manifest is not helpful and you will
    spend twenty minutes on it.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BotAppId,
    [Parameter(Mandatory)][string]$BotHostname,

    # Stable across rebuilds. Generate one the first time and keep it; changing it makes Teams
    # treat the upload as a different app rather than an upgrade.
    [string]$TeamsAppId,

    [string]$AppVersion = '1.0.0',
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'appPackage'
$dist = if ($OutputPath) { Split-Path -Parent $OutputPath } else { Join-Path $root 'dist' }
$zipPath = if ($OutputPath) { $OutputPath } else { Join-Path $dist 'brain-rotter-recorder.zip' }

if (-not $TeamsAppId) {
    $TeamsAppId = [guid]::NewGuid().ToString()
    Write-Host "No -TeamsAppId given; generated $TeamsAppId." -ForegroundColor Yellow
    Write-Host 'Save it and pass it on every rebuild, or Teams will treat each upload as a new app.' -ForegroundColor Yellow
}

foreach ($pair in @(@{ n = 'BotAppId'; v = $BotAppId }, @{ n = 'TeamsAppId'; v = $TeamsAppId })) {
    if (-not [guid]::TryParse($pair.v, [ref]([guid]::Empty))) {
        throw "$($pair.n) '$($pair.v)' is not a GUID."
    }
}

$BotHostname = $BotHostname -replace '^https?://', '' -replace '/.*$', ''

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("brainrotter-teamsapp-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
    $manifest = Get-Content (Join-Path $source 'manifest.json') -Raw
    $manifest = $manifest.
        Replace('REPLACE-WITH-TEAMS-APP-GUID', $TeamsAppId).
        Replace('REPLACE-WITH-ENTRA-APP-ID', $BotAppId).
        Replace('REPLACE-WITH-BOT-HOSTNAME', $BotHostname)

    $manifest = [regex]::Replace($manifest, '"version":\s*"[^"]*"', "`"version`": `"$AppVersion`"", 1)

    if ($manifest -match 'REPLACE-WITH-') {
        throw 'The manifest still contains REPLACE-WITH- placeholders after substitution.'
    }

    # Fail here rather than at upload time.
    $null = $manifest | ConvertFrom-Json

    Set-Content -Path (Join-Path $staging 'manifest.json') -Value $manifest -NoNewline -Encoding utf8
    Copy-Item (Join-Path $source 'color.png') $staging
    Copy-Item (Join-Path $source 'outline.png') $staging

    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal

    Write-Host ''
    Write-Host "Built $zipPath" -ForegroundColor Green
    Write-Host "  Teams app id : $TeamsAppId"
    Write-Host "  Bot app id   : $BotAppId"
    Write-Host "  Valid domain : $BotHostname"
    Write-Host "  Version      : $AppVersion"
    Write-Host ''
    Write-Host 'Upload it: Teams -> Apps -> Manage your apps -> Upload an app -> Upload a custom app.'
    Write-Host 'If that option is missing, custom app upload is off for your tenant - see teams-bot/README.md.'
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
