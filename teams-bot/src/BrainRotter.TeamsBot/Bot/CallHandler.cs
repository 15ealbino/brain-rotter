using System.Collections.Concurrent;
using BrainRotter.TeamsBot.Configuration;
using BrainRotter.TeamsBot.Media;
using BrainRotter.TeamsBot.Sinks;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Graph.Contracts;
using Microsoft.Graph.Models;

namespace BrainRotter.TeamsBot.Bot;

/// <summary>Snapshot of a call for the control API.</summary>
public sealed record CallStatus(
    string CallId,
    string State,
    string? ThreadId,
    bool IsRecording,
    DateTimeOffset JoinedAt,
    TimeSpan CapturedDuration,
    int ParticipantCount,
    long FramesDropped,
    string? RecordingId);

/// <summary>
/// Owns one meeting from join to finalize.
///
/// <para><b>The order matters.</b> Nothing is written to disk until
/// <c>updateRecordingStatus(recording)</c> has returned success:</para>
/// <list type="number">
///   <item>the call reaches <c>Established</c> (i.e. the meeting admitted us out of the lobby);</item>
///   <item><see cref="RecordingConsentGate.RequestAsync"/> runs — if it fails we leave and keep nothing;</item>
///   <item>only then is a recording folder allocated and <see cref="AudioCaptureSink"/> constructed,
///     which is the first moment a file exists and the first moment the audio socket has a
///     subscriber;</item>
///   <item>the chat announcement goes out.</item>
/// </list>
///
/// <para><b>Every exit converges on <see cref="TeardownAsync"/>.</b> Call terminated, bot removed
/// from the meeting, meeting ended, duration cap hit, lobby timeout, process shutdown — all of them
/// stop capture, mark the recording stopped, announce, and commit. A half-written WAV is never left
/// behind: the writer patches its RIFF sizes on close, and a capture that produced no audio is
/// discarded rather than added to the Library as a broken row.</para>
/// </summary>
public sealed class CallHandler : IAsyncDisposable
{
    private readonly ICall call;
    private readonly BotOptions options;
    private readonly IRecordingSink sink;
    private readonly MeetingChatAnnouncer announcer;
    private readonly IGraphLogger logger;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim transition = new(1, 1);
    private readonly ConcurrentDictionary<string, string> roster = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<uint, string> mediaSourceToParticipant = new();

    private RecordingConsent? consent;
    private AudioCaptureSink? capture;
    private string? recordingId;
    private string? committedRecordingId;
    private DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private int tornDown;

    public CallHandler(
        ICall call,
        BotOptions options,
        IRecordingSink sink,
        MeetingChatAnnouncer announcer,
        IGraphLogger logger)
    {
        this.call = call;
        this.options = options;
        this.sink = sink;
        this.announcer = announcer;
        this.logger = logger;

        this.call.OnUpdated += this.OnCallUpdated;

        // Roster changes arrive as collection events: AddedResources when someone joins,
        // RemovedResources when they leave or when the bot itself is removed from the meeting.
        this.call.Participants.OnUpdated += this.OnParticipantsUpdated;

        _ = Task.Run(this.WatchLobbyAsync);
        if (this.options.MaxCallDurationMinutes > 0)
        {
            _ = Task.Run(this.WatchDurationCapAsync);
        }
    }

    public string CallId => this.call.Id;

    public string? ThreadId => this.call.Resource?.ChatInfo?.ThreadId;

    public bool IsRecording => this.capture is not null;

    /// <summary>Raised once teardown has finished, so the owner can drop its reference.</summary>
    public event Func<CallHandler, Task>? Completed;

    public CallStatus Snapshot() => new(
        this.CallId,
        this.call.Resource?.State?.ToString() ?? "unknown",
        this.ThreadId,
        this.IsRecording,
        this.startedAt,
        this.capture?.Duration ?? TimeSpan.Zero,
        this.roster.Count,
        this.capture?.FramesDropped ?? 0,
        this.committedRecordingId);

    /* ------------------------------------------------------------------ *
     * Call lifecycle
     * ------------------------------------------------------------------ */

    private void OnCallUpdated(ICall sender, ResourceEventArgs<Call> args)
    {
        var state = args.NewResource?.State;
        this.logger.Info($"[{this.CallId}] state {args.OldResource?.State} -> {state}");

        switch (state)
        {
            case CallState.Established:
                _ = this.StartRecordingAsync();
                break;

            case CallState.Terminating:
            case CallState.Terminated:
                var reason = args.NewResource?.ResultInfo?.Message;
                _ = this.TeardownAsync(string.IsNullOrWhiteSpace(reason) ? $"call {state}" : $"call {state}: {reason}");
                break;
        }
    }

    private void OnParticipantsUpdated(IParticipantCollection sender, CollectionEventArgs<IParticipant> args)
    {
        foreach (var participant in args.AddedResources)
        {
            var name = DescribeParticipant(participant);
            if (this.roster.TryAdd(participant.Id, name))
            {
                this.logger.Info($"[{this.CallId}] joined: {name}");
            }

            this.MapMediaSources(participant, name);
        }

        foreach (var participant in args.UpdatedResources)
        {
            this.MapMediaSources(participant, DescribeParticipant(participant));
        }

        foreach (var participant in args.RemovedResources)
        {
            this.roster.TryRemove(participant.Id ?? string.Empty, out _);
            this.logger.Info($"[{this.CallId}] left: {DescribeParticipant(participant)}");
        }

        // Human participants all gone -> nothing worth recording. The bot itself is not in this
        // collection, so an empty roster really does mean an empty meeting.
        if (this.IsRecording && sender.Count == 0)
        {
            this.logger.Info($"[{this.CallId}] every participant has left; finishing up.");
            _ = this.TeardownAsync("all participants left");
        }
    }

    private void MapMediaSources(IParticipant participant, string name)
    {
        var streams = participant.Resource?.MediaStreams;
        if (streams is null) return;

        foreach (var stream in streams)
        {
            if (stream.MediaType == Modality.Audio &&
                uint.TryParse(stream.SourceId, out var sourceId) &&
                sourceId != 0)
            {
                this.mediaSourceToParticipant[sourceId] = name;
            }
        }
    }

    private static string DescribeParticipant(IParticipant participant)
    {
        var identity = participant.Resource?.Info?.Identity;
        if (identity is null)
        {
            return participant.Id ?? "unknown";
        }

        // GetPrimaryIdentity()/GetApplicationInstance() are SDK extensions over IdentitySet;
        // application instances (other bots, meeting recorders) live in AdditionalData, not on a
        // first-class property.
        return identity.GetPrimaryIdentity()?.DisplayName
               ?? identity.User?.DisplayName
               ?? identity.GetApplicationInstance()?.DisplayName
               ?? identity.Application?.DisplayName
               ?? participant.Id
               ?? "unknown";
    }

    /* ------------------------------------------------------------------ *
     * Lobby and duration guards
     * ------------------------------------------------------------------ */

    /// <summary>
    /// If the meeting admits to lobby, the call sits in <c>Establishing</c> until an organizer lets
    /// the bot in. We wait, then give up rather than holding a media session open forever.
    /// </summary>
    private async Task WatchLobbyAsync()
    {
        var timeout = TimeSpan.FromSeconds(Math.Max(30, this.options.LobbyTimeoutSeconds));

        try
        {
            await Task.Delay(timeout, this.lifetime.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        if (this.call.Resource?.State == CallState.Established)
        {
            return;
        }

        this.logger.Warn(
            $"[{this.CallId}] still not admitted after {timeout.TotalSeconds:0}s " +
            $"(state {this.call.Resource?.State}). The meeting most likely put the bot in the lobby and " +
            "nobody admitted it. Leaving.");

        await this.TeardownAsync("lobby timeout").ConfigureAwait(false);
    }

    private async Task WatchDurationCapAsync()
    {
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(this.options.MaxCallDurationMinutes), this.lifetime.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        this.logger.Warn($"[{this.CallId}] hit the {this.options.MaxCallDurationMinutes} minute cap; finalizing.");
        await this.TeardownAsync("maximum duration reached").ConfigureAwait(false);
    }

    /* ------------------------------------------------------------------ *
     * The gate
     * ------------------------------------------------------------------ */

    private async Task StartRecordingAsync()
    {
        await this.transition.WaitAsync().ConfigureAwait(false);
        try
        {
            if (this.capture is not null || this.tornDown == 1)
            {
                return;
            }

            // ---- Step 1: consent. Nothing below this line runs if it throws. ----
            try
            {
                this.consent = await RecordingConsentGate
                    .RequestAsync(this.call, this.logger, this.lifetime.Token)
                    .ConfigureAwait(false);
            }
            catch (RecordingConsentDeniedException ex)
            {
                this.logger.Error(ex, $"[{this.CallId}] RECORDING CONSENT DENIED — leaving the meeting, nothing persisted.");

                // Deliberately not calling sink.AllocateAsync: no folder, no file, no index row.
                await this.LeaveCallAsync().ConfigureAwait(false);
                await this.TeardownAsync("recording consent denied").ConfigureAwait(false);
                return;
            }

            // ---- Step 2: only now may bytes exist on disk. ----
            var audioSocket = (this.call.MediaSession as ILocalMediaSession)?.AudioSocket;
            if (audioSocket is null)
            {
                this.logger.Error($"[{this.CallId}] the media session has no audio socket; nothing to capture.");
                await RecordingConsentGate.ReleaseAsync(this.call, this.consent, this.logger).ConfigureAwait(false);
                await this.LeaveCallAsync().ConfigureAwait(false);
                await this.TeardownAsync("no audio socket").ConfigureAwait(false);
                return;
            }

            this.startedAt = DateTimeOffset.UtcNow;
            var (id, audioPath) = this.sink.AllocateAsync(this.startedAt);
            this.recordingId = id;

            this.capture = await AudioCaptureSink.StartAsync(
                this.consent,
                audioSocket,
                audioPath,
                this.logger,
                trackSpeakers: this.options.ReceiveUnmixedAudio,
                this.lifetime.Token).ConfigureAwait(false);

            this.logger.Info($"[{this.CallId}] recording to {audioPath} (recording id {id}).");
        }
        catch (Exception ex)
        {
            this.logger.Error(ex, $"[{this.CallId}] failed to start recording; tearing down.");
            await this.TeardownAsync("failed to start recording").ConfigureAwait(false);
            return;
        }
        finally
        {
            this.transition.Release();
        }

        // ---- Step 3: tell the humans, outside the lock so a slow chat post cannot stall capture. ----
        if (this.ThreadId is { Length: > 0 } threadId)
        {
            await this.announcer.AnnounceRecordingStartedAsync(threadId, this.lifetime.Token).ConfigureAwait(false);
        }
    }

    /* ------------------------------------------------------------------ *
     * Teardown
     * ------------------------------------------------------------------ */

    /// <summary>
    /// Stops capture, marks the recording stopped in Teams, announces, and commits. Runs at most
    /// once no matter how many events fire.
    /// </summary>
    public async Task TeardownAsync(string reason)
    {
        if (Interlocked.Exchange(ref this.tornDown, 1) == 1)
        {
            return;
        }

        this.logger.Info($"[{this.CallId}] tearing down: {reason}");

        try
        {
            this.call.OnUpdated -= this.OnCallUpdated;
            this.call.Participants.OnUpdated -= this.OnParticipantsUpdated;
        }
        catch (Exception ex)
        {
            this.logger.Warn(ex, $"[{this.CallId}] could not detach call event handlers.");
        }

        var capture = this.capture;
        this.capture = null;

        TimeSpan duration = TimeSpan.Zero;
        if (capture is not null)
        {
            duration = capture.Duration;

            // Closes the WAV with correct sizes. After this the file on disk is valid even if
            // everything below fails.
            await capture.DisposeAsync().ConfigureAwait(false);
        }

        if (this.consent is not null)
        {
            await RecordingConsentGate.ReleaseAsync(this.call, this.consent, this.logger).ConfigureAwait(false);

            if (this.ThreadId is { Length: > 0 } threadId)
            {
                await this.announcer.AnnounceRecordingStoppedAsync(threadId, duration).ConfigureAwait(false);
            }
        }

        if (capture is not null && this.recordingId is not null)
        {
            await this.CommitAsync(capture, duration).ConfigureAwait(false);
        }

        await this.lifetime.CancelAsync().ConfigureAwait(false);

        if (this.Completed is { } completed)
        {
            try
            {
                await completed(this).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                this.logger.Warn(ex, $"[{this.CallId}] completion callback threw.");
            }
        }
    }

    private async Task CommitAsync(AudioCaptureSink capture, TimeSpan duration)
    {
        try
        {
            if (capture.BytesWritten == 0)
            {
                this.logger.Warn($"[{this.CallId}] no audio was captured; discarding the recording folder.");
                await this.sink.AbandonAsync(this.recordingId!).ConfigureAwait(false);
                return;
            }

            var finished = new FinishedRecording
            {
                CallId = this.CallId,
                Title = this.BuildTitle(),
                StartedAt = this.startedAt,
                Duration = duration,
                AudioPath = capture.AudioPath,
                Participants = this.roster.Values.Distinct(StringComparer.Ordinal).OrderBy(n => n, StringComparer.Ordinal).ToList(),
                SpeakerActivity = capture.SpeakerSpans()
                    .Select(s => new SpeakerActivity(
                        this.mediaSourceToParticipant.TryGetValue(s.MediaSourceId, out var name) ? name : $"source:{s.MediaSourceId}",
                        s.StartSeconds,
                        s.EndSeconds))
                    .ToList(),
                FramesReceived = capture.FramesReceived,
                FramesDropped = capture.FramesDropped,
            };

            this.committedRecordingId = await this.sink.CommitAsync(this.recordingId!, finished).ConfigureAwait(false);
            this.logger.Info($"[{this.CallId}] committed to the {this.sink.Name} sink as {this.committedRecordingId}.");
        }
        catch (Exception ex)
        {
            // The WAV is already closed and valid, and meta.json may already be written, so the
            // app can still recover the recording from disk. Say so rather than implying loss.
            this.logger.Error(ex,
                $"[{this.CallId}] failed to commit the recording. The audio file itself is intact at " +
                $"{capture.AudioPath}; brain-rotter can pick it up if meta.json was written, otherwise move it in by hand.");
        }
    }

    private string BuildTitle()
    {
        var subject = this.call.Resource?.Subject;
        var local = this.startedAt.ToLocalTime();
        var stamp = $"{local:yyyy-MM-dd HH:mm}";

        return string.IsNullOrWhiteSpace(subject)
            ? $"Teams meeting {stamp}"
            : $"{subject.Trim()} — {stamp}";
    }

    private async Task LeaveCallAsync()
    {
        try
        {
            await this.call.DeleteAsync(handleHttpNotFoundInternally: true).ConfigureAwait(false);
            this.logger.Info($"[{this.CallId}] left the meeting.");
        }
        catch (Exception ex)
        {
            this.logger.Warn(ex, $"[{this.CallId}] could not leave cleanly; the call may already be gone.");
        }
    }

    /// <summary>Leaves the meeting and finalizes. Used by <c>POST /api/leave/{callId}</c>.</summary>
    public async Task LeaveAsync(string reason = "requested via API")
    {
        await this.LeaveCallAsync().ConfigureAwait(false);
        await this.TeardownAsync(reason).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await this.TeardownAsync("handler disposed").ConfigureAwait(false);
        this.transition.Dispose();
        this.lifetime.Dispose();
    }
}
