using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using BrainRotter.TeamsBot.Configuration;
using Microsoft.Extensions.Options;

namespace BrainRotter.TeamsBot.Bot;

/// <summary>
/// Posts a visible message into the meeting chat when recording starts and stops.
///
/// <para>This is <b>in addition to</b> <c>updateRecordingStatus</c>, not instead of it. That API
/// drives Teams' own recording banner and is the licence requirement; this is the plain-language
/// notice, so nobody has to notice a banner to know what is happening.</para>
///
/// <para><b>Why the Bot Connector REST API and not Graph.</b> Microsoft Graph only permits an
/// application to POST to <c>/chats/{id}/messages</c> with <c>Teamwork.Migrate.All</c>, which is
/// documented as being for message <i>import/migration</i> and would be the wrong permission to
/// ask an admin for. The supported route for a bot to speak in a conversation it is part of is the
/// Bot Framework Connector, which the bot is already entitled to use as a Teams app. We call its
/// REST surface directly rather than pulling in the Bot Builder SDK, whose transitive
/// Microsoft.IdentityModel versions conflict with the Graph 5.x stack used here.</para>
///
/// <para>Failure to announce never blocks or aborts a recording; the banner is already up by the
/// time this runs. Failures are logged at warning level with the HTTP body, because the usual
/// cause — the Teams app not actually being installed in the meeting — is worth seeing.</para>
/// </summary>
public sealed class MeetingChatAnnouncer(
    IHttpClientFactory httpClientFactory,
    IOptions<BotOptions> options,
    ILogger<MeetingChatAnnouncer> logger)
{
    private const string ConnectorScope = "https://api.botframework.com/.default";

    private readonly BotOptions options = options.Value;
    private readonly SemaphoreSlim tokenLock = new(1, 1);

    private string? cachedToken;
    private DateTimeOffset tokenExpiresAt = DateTimeOffset.MinValue;

    public Task AnnounceRecordingStartedAsync(string threadId, CancellationToken cancellationToken = default) =>
        this.SendAsync(
            threadId,
            $"🔴 **{this.options.DisplayName} is now recording this meeting.** " +
            "Audio is being captured for a local transcript. Remove this app from the meeting to stop.",
            cancellationToken);

    public Task AnnounceRecordingStoppedAsync(string threadId, TimeSpan duration, CancellationToken cancellationToken = default) =>
        this.SendAsync(
            threadId,
            $"⏹️ **{this.options.DisplayName} has stopped recording.** " +
            $"Captured {FormatDuration(duration)} of audio.",
            cancellationToken);

    private static string FormatDuration(TimeSpan duration) =>
        duration.TotalHours >= 1
            ? $"{(int)duration.TotalHours}h {duration.Minutes}m"
            : $"{duration.Minutes}m {duration.Seconds}s";

    private async Task SendAsync(string threadId, string text, CancellationToken cancellationToken)
    {
        if (!this.options.AnnounceInMeetingChat)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(threadId))
        {
            logger.LogWarning("No meeting chat thread id available; skipping the chat announcement. " +
                              "The Teams recording banner is still shown via updateRecordingStatus.");
            return;
        }

        try
        {
            var token = await this.GetConnectorTokenAsync(cancellationToken).ConfigureAwait(false);
            var client = httpClientFactory.CreateClient(nameof(MeetingChatAnnouncer));

            var baseUrl = this.options.BotConnectorServiceUrl.TrimEnd('/');
            var url = $"{baseUrl}/v3/conversations/{Uri.EscapeDataString(threadId)}/activities";

            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = JsonContent.Create(new
                {
                    type = "message",
                    textFormat = "markdown",
                    text,
                }),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                logger.LogWarning(
                    "Meeting-chat announcement failed ({Status}): {Body}. " +
                    "Check that the Teams app is installed in the meeting and that Bot:BotConnectorServiceUrl matches your cloud.",
                    (int)response.StatusCode,
                    body);
                return;
            }

            logger.LogInformation("Announced in meeting chat {ThreadId}.", threadId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not announce in the meeting chat. Recording is unaffected.");
        }
    }

    /// <summary>
    /// Client-credentials token for the Bot Connector. Endpoint and scope per
    /// "Authenticate requests with the Bot Connector API": multi-tenant bots use the
    /// <c>botframework.com</c> authority, single-tenant bots use their own tenant.
    /// </summary>
    private async Task<string> GetConnectorTokenAsync(CancellationToken cancellationToken)
    {
        if (this.cachedToken is not null && DateTimeOffset.UtcNow < this.tokenExpiresAt)
        {
            return this.cachedToken;
        }

        await this.tokenLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (this.cachedToken is not null && DateTimeOffset.UtcNow < this.tokenExpiresAt)
            {
                return this.cachedToken;
            }

            var authority = this.options.SingleTenantBot && !string.IsNullOrWhiteSpace(this.options.TenantId)
                ? this.options.TenantId
                : "botframework.com";

            var client = httpClientFactory.CreateClient(nameof(MeetingChatAnnouncer));
            using var content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "client_credentials",
                ["client_id"] = this.options.AppId,
                ["client_secret"] = this.options.AppSecret,
                ["scope"] = ConnectorScope,
            });

            using var response = await client
                .PostAsync($"https://login.microsoftonline.com/{authority}/oauth2/v2.0/token", content, cancellationToken)
                .ConfigureAwait(false);

            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Bot Connector token request failed ({(int)response.StatusCode}): {body}");
            }

            using var document = JsonDocument.Parse(body);
            var token = document.RootElement.GetProperty("access_token").GetString()
                        ?? throw new InvalidOperationException("Bot Connector token response had no access_token.");
            var expiresIn = document.RootElement.TryGetProperty("expires_in", out var e) ? e.GetInt32() : 3600;

            this.cachedToken = token;
            this.tokenExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn - 300);
            return token;
        }
        finally
        {
            this.tokenLock.Release();
        }
    }
}
