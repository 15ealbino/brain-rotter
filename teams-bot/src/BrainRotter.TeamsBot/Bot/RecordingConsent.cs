using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Models;

namespace BrainRotter.TeamsBot.Bot;

/// <summary>
/// Proof that <c>updateRecordingStatus(recording)</c> was called for a specific call and returned
/// success.
/// <para>
/// This type exists so the compiler can enforce the Media Access API's hard requirement. From the
/// Microsoft Graph docs for <c>call: updateRecordingStatus</c>:
/// </para>
/// <blockquote>
/// You may NOT use the Media Access API to record or otherwise persist media content from calls or
/// meetings that your application accesses, or data derived from that media content, without first
/// calling the updateRecordingStatus API to indicate that recording has begun, and receiving a
/// success reply from that API.
/// </blockquote>
/// <para>
/// There is exactly one way to obtain an instance: <see cref="RecordingConsentGate.RequestAsync"/>,
/// which only returns one after the Graph call has completed without error. Everything that can
/// touch the disk — <see cref="Media.AudioCaptureSink"/> — takes one of these as a constructor
/// argument, so there is no code path that opens a file or subscribes to the audio socket first.
/// </para>
/// </summary>
public sealed class RecordingConsent
{
    private RecordingConsent(string callId, string clientContext, DateTimeOffset grantedAt)
    {
        this.CallId = callId;
        this.ClientContext = clientContext;
        this.GrantedAt = grantedAt;
    }

    public string CallId { get; }

    /// <summary>Correlation string passed to Graph; reused when marking the recording stopped.</summary>
    public string ClientContext { get; }

    public DateTimeOffset GrantedAt { get; }

    /// <summary>
    /// Only <see cref="RecordingConsentGate"/> may call this, and only after a successful
    /// <c>updateRecordingStatus</c>.
    /// </summary>
    internal static RecordingConsent Grant(string callId, string clientContext) =>
        new(callId, clientContext, DateTimeOffset.UtcNow);
}

/// <summary>Raised when the recording status could not be set. The bot must leave and persist nothing.</summary>
public sealed class RecordingConsentDeniedException(string message, Exception? inner = null)
    : Exception(message, inner);

/// <summary>
/// The single place that talks to <c>updateRecordingStatus</c>.
/// </summary>
public static class RecordingConsentGate
{
    /// <summary>
    /// Declares to Teams that this call is being recorded. Teams drives its own recording banner
    /// and the "this meeting is being recorded" notice off this.
    /// </summary>
    /// <exception cref="RecordingConsentDeniedException">
    /// Thrown when Graph rejects, errors, or times out. The caller must tear the call down.
    /// </exception>
    public static async Task<RecordingConsent> RequestAsync(
        ICall call,
        IGraphLogger logger,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(call);

        var clientContext = $"brain-rotter:{call.Id}";

        try
        {
            logger.Info($"[{call.Id}] Calling updateRecordingStatus(recording) before any capture is set up.");

            // ICall.UpdateRecordingStatusAsync returns a bare Task: completion without an
            // exception is the success reply the licence terms require. A non-2xx from Graph
            // surfaces as a thrown ServiceException / GraphResponseException here.
            await call.UpdateRecordingStatusAsync(RecordingStatus.Recording, cancellationToken).ConfigureAwait(false);

            logger.Info($"[{call.Id}] updateRecordingStatus(recording) succeeded. Capture may now be constructed.");
            return RecordingConsent.Grant(call.Id, clientContext);
        }
        catch (Exception ex)
        {
            throw new RecordingConsentDeniedException(
                $"updateRecordingStatus(recording) failed for call {call.Id}. " +
                "The Media Access API terms forbid persisting any media without a success reply from this API, " +
                "so the bot will leave the meeting and write nothing to disk. " +
                "The usual cause is a missing Calls.AccessMedia.All application permission or missing admin consent.",
                ex);
        }
    }

    /// <summary>
    /// Marks the recording stopped. Best-effort on teardown: failing here must not stop us
    /// finalizing an already-written file, but it is logged loudly because Teams' banner state
    /// depends on it.
    /// </summary>
    public static async Task<bool> ReleaseAsync(
        ICall call,
        RecordingConsent consent,
        IGraphLogger logger,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await call.UpdateRecordingStatusAsync(RecordingStatus.NotRecording, cancellationToken).ConfigureAwait(false);
            logger.Info($"[{consent.CallId}] updateRecordingStatus(notRecording) succeeded.");
            return true;
        }
        catch (Exception ex)
        {
            logger.Error(ex, $"[{consent.CallId}] updateRecordingStatus(notRecording) failed. " +
                             "Teams may keep showing the recording indicator until the call ends.");
            return false;
        }
    }
}
