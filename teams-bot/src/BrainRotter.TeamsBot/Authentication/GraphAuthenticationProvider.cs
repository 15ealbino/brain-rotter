using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using BrainRotter.TeamsBot.Configuration;
using Microsoft.Graph.Communications.Client.Authentication;
using Microsoft.Graph.Communications.Common;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Identity.Client;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Microsoft.IdentityModel.Tokens;

namespace BrainRotter.TeamsBot.Authentication;

/// <summary>
/// Signs outbound Graph calls with an app-only token, and validates the tokens Graph puts on the
/// inbound call-notification webhook.
/// <para>
/// Inbound validation matters: <c>POST /api/calls</c> is a public endpoint. Requests that fail
/// validation are rejected by the SDK with 403 before any call state is touched.
/// </para>
/// </summary>
public sealed class GraphAuthenticationProvider : ObjectRoot, IRequestAuthenticationProvider
{
    /// <summary>
    /// Graph signs its outbound notifications with a private certificate rather than an Entra
    /// key, so the public keys come from the calling platform's own OIDC document.
    /// </summary>
    private const string CallingPlatformOpenIdConfigUrl = "https://api.aps.skype.com/v1/.well-known/OpenIdConfiguration";

    private const string TenantClaimType = "http://schemas.microsoft.com/identity/claims/tenantid";

    private static readonly string[] AcceptedIssuers =
    [
        "https://graph.microsoft.com",
        "https://api.botframework.com",
    ];

    private readonly BotOptions options;
    private readonly IConfidentialClientApplication confidentialClient;
    private readonly SemaphoreSlim openIdLock = new(1, 1);
    private readonly TimeSpan openIdRefreshInterval = TimeSpan.FromHours(2);

    private OpenIdConnectConfiguration? openIdConfiguration;
    private DateTimeOffset openIdFetchedAt = DateTimeOffset.MinValue;

    public GraphAuthenticationProvider(BotOptions options, IGraphLogger logger)
        : base(logger.NotNull(nameof(logger)).CreateShim(nameof(GraphAuthenticationProvider)))
    {
        this.options = options.NotNull(nameof(options));

        // MSAL caches tokens in-process, so building this once (rather than per request) keeps
        // us off the token endpoint for the lifetime of each token.
        this.confidentialClient = ConfidentialClientApplicationBuilder
            .Create(options.AppId.NotNullOrWhitespace(nameof(options.AppId)))
            .WithClientSecret(options.AppSecret.NotNullOrWhitespace(nameof(options.AppSecret)))
            .WithAuthority($"https://login.microsoftonline.com/{ResolveAuthorityTenant(options)}")
            .Build();
    }

    private static string ResolveAuthorityTenant(BotOptions options) =>
        string.IsNullOrWhiteSpace(options.TenantId) ? "common" : options.TenantId;

    /// <inheritdoc />
    public async Task AuthenticateOutboundRequestAsync(HttpRequestMessage request, string tenant)
    {
        // Application permissions are granted per tenant. When the SDK tells us which tenant a
        // call belongs to we mint the token for that tenant.
        var targetTenant = string.IsNullOrWhiteSpace(tenant) ? ResolveAuthorityTenant(this.options) : tenant;

        var result = await this.AcquireWithRetryAsync(targetTenant, ["https://graph.microsoft.com/.default"], attempts: 3)
            .ConfigureAwait(false);

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", result.AccessToken);
    }

    /// <inheritdoc />
    public async Task<RequestValidationResult> ValidateInboundRequestAsync(HttpRequestMessage request)
    {
        var token = request?.Headers?.Authorization?.Parameter;
        if (string.IsNullOrWhiteSpace(token))
        {
            this.GraphLogger.Warn("Rejecting inbound notification: no bearer token.");
            return new RequestValidationResult { IsValid = false };
        }

        OpenIdConnectConfiguration config;
        try
        {
            config = await this.GetOpenIdConfigurationAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.GraphLogger.Error(ex, "Could not fetch the calling platform OpenID configuration; rejecting the request.");
            return new RequestValidationResult { IsValid = false };
        }

        var validationParameters = new TokenValidationParameters
        {
            ValidIssuers = AcceptedIssuers,
            ValidAudience = this.options.AppId,
            IssuerSigningKeys = config.SigningKeys,
        };

        ClaimsPrincipal principal;
        try
        {
            principal = new JwtSecurityTokenHandler().ValidateToken(token, validationParameters, out _);
        }
        catch (Exception ex)
        {
            this.GraphLogger.Error(ex, "Inbound notification token failed validation.");
            return new RequestValidationResult { IsValid = false };
        }

        var tenantId = principal.FindFirst(c => string.Equals(c.Type, TenantClaimType, StringComparison.Ordinal))?.Value;
        if (string.IsNullOrEmpty(tenantId))
        {
            this.GraphLogger.Warn("Inbound notification token carried no tenant claim; rejecting.");
            return new RequestValidationResult { IsValid = false };
        }

        request!.Options.Set(new HttpRequestOptionsKey<string>(HttpConstants.HeaderNames.Tenant), tenantId);
        return new RequestValidationResult { IsValid = true, TenantId = tenantId };
    }

    private async Task<OpenIdConnectConfiguration> GetOpenIdConfigurationAsync()
    {
        if (this.openIdConfiguration is not null && DateTimeOffset.UtcNow - this.openIdFetchedAt < this.openIdRefreshInterval)
        {
            return this.openIdConfiguration;
        }

        await this.openIdLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (this.openIdConfiguration is not null && DateTimeOffset.UtcNow - this.openIdFetchedAt < this.openIdRefreshInterval)
            {
                return this.openIdConfiguration;
            }

            var manager = new ConfigurationManager<OpenIdConnectConfiguration>(
                CallingPlatformOpenIdConfigUrl,
                new OpenIdConnectConfigurationRetriever());

            this.openIdConfiguration = await manager.GetConfigurationAsync(CancellationToken.None).ConfigureAwait(false);
            this.openIdFetchedAt = DateTimeOffset.UtcNow;
            return this.openIdConfiguration;
        }
        finally
        {
            this.openIdLock.Release();
        }
    }

    private async Task<AuthenticationResult> AcquireWithRetryAsync(string tenantId, string[] scopes, int attempts)
    {
        Exception? last = null;
        for (var i = 0; i < attempts; i++)
        {
            try
            {
                var request = this.confidentialClient.AcquireTokenForClient(scopes);

                // "common" is not a real tenant — leaving it off falls back to the authority the
                // client was built with, which is what we want for the single-tenant case.
                if (!string.Equals(tenantId, "common", StringComparison.OrdinalIgnoreCase))
                {
                    request = request.WithTenantId(tenantId);
                }

                return await request.ExecuteAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                last = ex;
                this.GraphLogger.Warn(ex, $"Token acquisition attempt {i + 1}/{attempts} failed for tenant {tenantId}.");
                if (i < attempts - 1)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1 << i)).ConfigureAwait(false);
                }
            }
        }

        throw new InvalidOperationException(
            $"Could not acquire an app-only Graph token for {this.options.AppId} (tenant {tenantId}). " +
            "Check the client secret and that admin consent has been granted for the Calls.* permissions.",
            last);
    }
}
