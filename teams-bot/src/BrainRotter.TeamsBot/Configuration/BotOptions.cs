namespace BrainRotter.TeamsBot.Configuration;

/// <summary>
/// Everything the bot needs to identify itself and reach the network.
/// <para>
/// Secrets (<see cref="AppSecret"/>) never live in <c>appsettings.json</c>. They come from
/// environment variables (<c>Bot__AppSecret</c>) or .NET user-secrets. See <c>.env.example</c>.
/// </para>
/// </summary>
public sealed class BotOptions
{
    public const string SectionName = "Bot";

    /// <summary>Entra ID application (client) id. Also the Bot Framework app id.</summary>
    public string AppId { get; set; } = string.Empty;

    /// <summary>Entra ID client secret. Supply via environment or user-secrets only.</summary>
    public string AppSecret { get; set; } = string.Empty;

    /// <summary>
    /// Home tenant id. Used for the single-tenant Bot Connector token endpoint and as the
    /// fallback tenant when a join URL does not carry one.
    /// </summary>
    public string TenantId { get; set; } = string.Empty;

    /// <summary>
    /// Public HTTPS base URL Graph calls back on, e.g. <c>https://bot.contoso.com</c>.
    /// Must be a real DNS name with a publicly trusted certificate.
    /// </summary>
    public string BotBaseUrl { get; set; } = string.Empty;

    /// <summary>Graph calling endpoint. Global cloud default; differs for GCC High / DoD.</summary>
    public string PlaceCallEndpointUrl { get; set; } = "https://graph.microsoft.com/v1.0";

    /// <summary>
    /// Public FQDN that resolves to this instance's public IP, used for the media leg.
    /// Usually the same host as <see cref="BotBaseUrl"/>.
    /// </summary>
    public string MediaServiceFqdn { get; set; } = string.Empty;

    /// <summary>Thumbprint of the TLS certificate in LocalMachine\My used for media MTLS.</summary>
    public string CertificateThumbprint { get; set; } = string.Empty;

    /// <summary>Port the media platform listens on inside the VM.</summary>
    public int MediaInstanceInternalPort { get; set; } = 8445;

    /// <summary>Public-facing port that maps to <see cref="MediaInstanceInternalPort"/>.</summary>
    public int MediaInstancePublicPort { get; set; } = 8445;

    /// <summary>Display name used when announcing in meeting chat.</summary>
    public string DisplayName { get; set; } = "Brain Rotter Recorder";

    /// <summary>
    /// Bot Connector service URL used for the meeting-chat announcement.
    /// Global Teams default; regional/sovereign clouds differ.
    /// </summary>
    public string BotConnectorServiceUrl { get; set; } = "https://smba.trafficmanager.net/teams/";

    /// <summary>
    /// <c>true</c> when the Entra app is registered single-tenant. Controls which Bot
    /// Connector token endpoint is used.
    /// </summary>
    public bool SingleTenantBot { get; set; } = true;

    /// <summary>
    /// Ask the media platform for per-participant (unmixed) audio in addition to the mix.
    /// See <see cref="Media.AudioCaptureSink"/> for why we still write the mix to disk.
    /// </summary>
    public bool ReceiveUnmixedAudio { get; set; } = true;

    /// <summary>Post a message to the meeting chat on record start/stop. Not a substitute for
    /// <c>updateRecordingStatus</c> — both happen.</summary>
    public bool AnnounceInMeetingChat { get; set; } = true;

    /// <summary>Give up and leave if the meeting has not admitted the bot from the lobby in time.</summary>
    public int LobbyTimeoutSeconds { get; set; } = 300;

    /// <summary>Hard cap on a single recording. 0 disables the cap.</summary>
    public int MaxCallDurationMinutes { get; set; } = 480;

    /// <summary>
    /// Allow the service to start when the Real-time Media Platform fails to initialize
    /// (e.g. running on Linux or macOS for development). Joining is then refused with 503.
    /// Never enable this in production — it exists so the HTTP surface and the brain-rotter
    /// sink can be exercised off-Windows.
    /// </summary>
    public bool AllowStartWithoutMediaPlatform { get; set; }

    public IReadOnlyList<string> Validate()
    {
        var problems = new List<string>();

        void Require(string value, string name, string hint)
        {
            if (string.IsNullOrWhiteSpace(value)) problems.Add($"{SectionName}:{name} is required. {hint}");
        }

        Require(AppId, nameof(AppId), "The Entra ID application (client) id.");
        Require(AppSecret, nameof(AppSecret), "Set the Bot__AppSecret environment variable or use `dotnet user-secrets set Bot:AppSecret ...`.");
        Require(BotBaseUrl, nameof(BotBaseUrl), "The public HTTPS URL Graph posts call notifications to.");

        if (!string.IsNullOrWhiteSpace(BotBaseUrl) &&
            (!Uri.TryCreate(BotBaseUrl, UriKind.Absolute, out var baseUri) || baseUri.Scheme != Uri.UriSchemeHttps))
        {
            problems.Add($"{SectionName}:{nameof(BotBaseUrl)} must be an absolute https:// URL.");
        }

        if (!AllowStartWithoutMediaPlatform)
        {
            Require(MediaServiceFqdn, nameof(MediaServiceFqdn), "The public DNS name that resolves to this instance's public IP.");
            Require(CertificateThumbprint, nameof(CertificateThumbprint), "Thumbprint of the TLS certificate the media platform presents.");
        }

        return problems;
    }

    public Uri BotBaseUri => new(BotBaseUrl);

    public Uri PlaceCallEndpointUri => new(PlaceCallEndpointUrl);
}
