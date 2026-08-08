using System.Collections.Concurrent;
using System.Net;
using BrainRotter.TeamsBot.Authentication;
using BrainRotter.TeamsBot.Configuration;
using BrainRotter.TeamsBot.Sinks;
using Microsoft.Extensions.Options;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Client;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Skype.Bots.Media;

namespace BrainRotter.TeamsBot.Bot;

/// <summary>
/// Owns the Graph Communications client and the set of live calls.
///
/// <para><b>Invited only.</b> The bot joins a meeting when a human hands it a join URL
/// (<c>POST /api/join</c>) or when Teams calls it because a user added it to a meeting
/// (<c>POST /api/calls</c>). There is no discovery, no calendar scraping, and no way to make it
/// join a meeting it was not pointed at.</para>
/// </summary>
public sealed class TeamsRecordingBot : IAsyncDisposable
{
    private readonly BotOptions options;
    private readonly IRecordingSink sink;
    private readonly MeetingChatAnnouncer announcer;
    private readonly IGraphLogger logger;
    private readonly ILogger<TeamsRecordingBot> hostLogger;
    private readonly ConcurrentDictionary<string, CallHandler> handlers = new(StringComparer.Ordinal);

    public TeamsRecordingBot(
        IOptions<BotOptions> options,
        IRecordingSink sink,
        MeetingChatAnnouncer announcer,
        IGraphLogger logger,
        ILogger<TeamsRecordingBot> hostLogger)
    {
        this.options = options.Value;
        this.sink = sink;
        this.announcer = announcer;
        this.logger = logger;
        this.hostLogger = hostLogger;

        var name = typeof(TeamsRecordingBot).Assembly.GetName().Name!;

        // SetAuthenticationProvider is marked obsolete in favour of SetAuthentication(appId,
        // ITokenProvider), which wraps the token provider in the SDK's DefaultAuthenticationProvider.
        // We keep our own IRequestAuthenticationProvider because it also owns *inbound* validation
        // of the /api/calls webhook, and that check is worth having explicit and readable in this
        // repo rather than buried in the SDK. IRequestAuthenticationProvider itself is not obsolete.
#pragma warning disable CS0618
        var builder = new CommunicationsClientBuilder(name, this.options.AppId, logger)
            .SetAuthenticationProvider(new GraphAuthenticationProvider(this.options, logger))
#pragma warning restore CS0618
            .SetNotificationUrl(new Uri(this.options.BotBaseUri, "/api/calls"))
            .SetServiceBaseUrl(this.options.PlaceCallEndpointUri);

        this.MediaPlatformStatus = this.TryInitializeMediaPlatform(builder);

        this.Client = builder.Build();
        this.Client.Calls().OnIncoming += this.OnIncomingCall;
        this.Client.Calls().OnUpdated += this.OnCallsUpdated;
    }

    public ICommunicationsClient Client { get; }

    /// <summary>
    /// <c>null</c> when the Real-time Media Platform initialized. Otherwise the reason it did not,
    /// which is surfaced on <c>/healthz</c> and returned by <c>/api/join</c>.
    /// </summary>
    public string? MediaPlatformStatus { get; }

    public bool CanJoin => this.MediaPlatformStatus is null;

    public IReadOnlyCollection<CallStatus> ActiveCalls() =>
        this.handlers.Values.Select(h => h.Snapshot()).ToList();

    /* ------------------------------------------------------------------ *
     * Joining
     * ------------------------------------------------------------------ */

    /// <summary>
    /// Joins a scheduled meeting from its join URL. The bot appears in the roster as itself; if the
    /// meeting admits to lobby it waits there until an organizer lets it in
    /// (see <see cref="CallHandler"/>).
    /// </summary>
    public async Task<ICall> JoinAsync(string joinUrl, string? tenantIdOverride, CancellationToken cancellationToken = default)
    {
        if (!this.CanJoin)
        {
            throw new InvalidOperationException(this.MediaPlatformStatus);
        }

        if (!MeetingJoinUrl.TryParse(joinUrl, out var coordinates, out var error))
        {
            throw new ArgumentException(error, nameof(joinUrl));
        }

        var scenarioId = Guid.NewGuid();
        var tenantId = tenantIdOverride
                       ?? coordinates.TenantId
                       ?? (string.IsNullOrWhiteSpace(this.options.TenantId) ? null : this.options.TenantId);

        this.hostLogger.LogInformation(
            "Joining meeting thread {ThreadId} (organizer {Organizer}, tenant {Tenant}).",
            coordinates.ThreadId,
            coordinates.OrganizerId,
            tenantId);

        // Audio only, receive only. The bot never sends media: its own send direction is inactive,
        // so it contributes nothing to the mix and cannot be heard.
        var mediaSession = this.CreateMediaSession(scenarioId);

        var parameters = new Microsoft.Graph.Communications.Calls.JoinMeetingParameters(
            coordinates.ChatInfo,
            coordinates.MeetingInfo,
            mediaSession)
        {
            TenantId = tenantId,

            // We want per-participant roster detail so speaker attribution and the "everyone has
            // left" teardown work.
            IsParticipantInfoUpdatesEnabled = true,
        };

        var call = await this.Client.Calls().AddAsync(parameters, scenarioId, cancellationToken).ConfigureAwait(false);
        this.hostLogger.LogInformation("Join accepted; call id {CallId}.", call.Id);
        return call;
    }

    public async Task<bool> LeaveAsync(string callId, CancellationToken cancellationToken = default)
    {
        if (!this.handlers.TryGetValue(callId, out var handler))
        {
            return false;
        }

        await handler.LeaveAsync().ConfigureAwait(false);
        return true;
    }

    /* ------------------------------------------------------------------ *
     * SDK events
     * ------------------------------------------------------------------ */

    /// <summary>
    /// Fires when a user adds the bot to a meeting from the Teams client, which arrives as an
    /// incoming call notification on the webhook.
    /// </summary>
    private void OnIncomingCall(ICallCollection sender, CollectionEventArgs<ICall> args)
    {
        foreach (var call in args.AddedResources)
        {
            this.hostLogger.LogInformation("Incoming call {CallId}; answering audio-only.", call.Id);

            var mediaSession = Guid.TryParse(call.Id, out var parsed)
                ? this.CreateMediaSession(parsed)
                : this.CreateMediaSession(Guid.NewGuid());

            _ = Task.Run(async () =>
            {
                try
                {
                    await call.AnswerAsync(mediaSession).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    this.hostLogger.LogError(ex, "Failed to answer call {CallId}.", call.Id);
                }
            });
        }
    }

    private void OnCallsUpdated(ICallCollection sender, CollectionEventArgs<ICall> args)
    {
        foreach (var call in args.AddedResources)
        {
            this.handlers.GetOrAdd(call.Id, _ =>
            {
                var created = new CallHandler(call, this.options, this.sink, this.announcer, this.logger);
                created.Completed += this.OnHandlerCompletedAsync;
                return created;
            });
        }

        foreach (var call in args.RemovedResources)
        {
            if (this.handlers.TryRemove(call.Id, out var handler))
            {
                // The call object is gone, but the recording still has to be closed and committed.
                _ = handler.TeardownAsync("call removed from the collection");
            }
        }
    }

    private Task OnHandlerCompletedAsync(CallHandler handler)
    {
        this.handlers.TryRemove(handler.CallId, out _);
        return Task.CompletedTask;
    }

    /* ------------------------------------------------------------------ *
     * Media
     * ------------------------------------------------------------------ */

    private ILocalMediaSession CreateMediaSession(Guid mediaSessionId)
    {
        var audio = new AudioSocketSettings
        {
            // Receive only. The bot has no microphone and never sends audio.
            StreamDirections = StreamDirection.Recvonly,

            // 16 kHz mono PCM: exactly what brain-rotter's whisper.cpp path consumes, so the
            // capture path does no resampling at all.
            SupportedAudioFormat = AudioFormat.Pcm16K,

            // Per-participant streams, for speaker attribution.
            ReceiveUnmixedMeetingAudio = this.options.ReceiveUnmixedAudio,

            // With unmixed enabled the platform stops sending the mix by default. We need the mix
            // for the playable file, so ask for both. (This also enables audio healing on both.)
            EnableLocalAudioMixingForUnmixed = this.options.ReceiveUnmixedAudio,
        };

        return this.Client.CreateMediaSession(audio, mediaSessionId: mediaSessionId);
    }

    /// <summary>
    /// Initializes the Real-time Media Platform. Returns <c>null</c> on success, or a human
    /// explanation on failure.
    /// <para>
    /// This is where a non-Windows host stops. The managed assemblies compile anywhere, but
    /// <c>Microsoft.Skype.Bots.Media</c> loads x64 Windows native libraries, so on Linux/macOS the
    /// call below throws. With <c>Bot:AllowStartWithoutMediaPlatform=true</c> the service still
    /// starts so the HTTP surface and the brain-rotter sink can be exercised; joining then returns
    /// 503. That flag must be off in production.
    /// </para>
    /// </summary>
    private string? TryInitializeMediaPlatform(ICommunicationsClientBuilder builder)
    {
        try
        {
            var addresses = Dns.GetHostAddresses(this.options.MediaServiceFqdn);
            if (addresses.Length == 0)
            {
                throw new InvalidOperationException(
                    $"'{this.options.MediaServiceFqdn}' did not resolve to any address. Media needs a public DNS " +
                    "name pointing at this instance's instance-level public IP.");
            }

            builder.SetMediaPlatformSettings(new MediaPlatformSettings
            {
                ApplicationId = this.options.AppId,
                MediaPlatformInstanceSettings = new MediaPlatformInstanceSettings
                {
                    CertificateThumbprint = this.options.CertificateThumbprint,
                    InstanceInternalPort = this.options.MediaInstanceInternalPort,
                    InstancePublicIPAddress = addresses[0],
                    InstancePublicPort = this.options.MediaInstancePublicPort,
                    ServiceFqdn = this.options.MediaServiceFqdn,
                },
            });

            this.hostLogger.LogInformation(
                "Real-time Media Platform initialized on {Fqdn} (internal {Internal} / public {Public}).",
                this.options.MediaServiceFqdn,
                this.options.MediaInstanceInternalPort,
                this.options.MediaInstancePublicPort);

            return null;
        }
        catch (Exception ex)
        {
            var reason =
                "The Real-time Media Platform could not be initialized: " + ex.Message +
                (OperatingSystem.IsWindows()
                    ? " Check the certificate thumbprint (LocalMachine\\My), the media ports, and that the FQDN resolves to this instance's public IP."
                    : $" This host is {Environment.OSVersion.Platform}; application-hosted media requires x64 Windows Server. See teams-bot/README.md > Deployment reality.");

            if (!this.options.AllowStartWithoutMediaPlatform)
            {
                throw new InvalidOperationException(
                    reason + " Set Bot:AllowStartWithoutMediaPlatform=true to start anyway for non-media development.",
                    ex);
            }

            this.hostLogger.LogWarning(ex, "{Reason} Starting in NO-MEDIA mode; /api/join will return 503.", reason);
            return reason;
        }
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var handler in this.handlers.Values)
        {
            await handler.TeardownAsync("service shutting down").ConfigureAwait(false);
        }

        this.handlers.Clear();

        try
        {
            await this.Client.TerminateAsync(TimeSpan.FromSeconds(30)).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            this.hostLogger.LogWarning(ex, "Communications client did not terminate cleanly.");
        }
    }
}
