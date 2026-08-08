namespace BrainRotter.TeamsBot.Sinks;

/// <summary>Everything known about a finished capture, handed to a sink for persistence.</summary>
public sealed record FinishedRecording
{
    /// <summary>Graph call id — used for correlation only, not as the recording id.</summary>
    public required string CallId { get; init; }

    /// <summary>Human title for the Library row.</summary>
    public required string Title { get; init; }

    public required DateTimeOffset StartedAt { get; init; }

    public required TimeSpan Duration { get; init; }

    /// <summary>
    /// Absolute path to the finished 16 kHz mono WAV. Sinks move or copy this; they do not
    /// assume they own the directory it currently sits in.
    /// </summary>
    public required string AudioPath { get; init; }

    /// <summary>Display names of everyone seen in the roster while recording.</summary>
    public IReadOnlyList<string> Participants { get; init; } = [];

    /// <summary>Per-speaker spans from the unmixed stream. Empty when unmixed audio was off.</summary>
    public IReadOnlyList<SpeakerActivity> SpeakerActivity { get; init; } = [];

    public long FramesReceived { get; init; }

    public long FramesDropped { get; init; }
}

/// <summary>A speaking span attributed to a participant, in seconds from the start of the audio.</summary>
public sealed record SpeakerActivity(string Speaker, double StartSeconds, double EndSeconds);

/// <summary>
/// Where a finished recording goes. Swap the implementation to write somewhere other than
/// brain-rotter's library (a blob store, a different transcription pipeline) without touching the
/// call or media layers.
/// </summary>
public interface IRecordingSink
{
    /// <summary>Short name for logs and the health endpoint.</summary>
    string Name { get; }

    /// <summary>
    /// Working directory the capture should write its WAV into for a given recording. Returning a
    /// path under the sink's final destination lets the sink finish with a rename instead of a copy.
    /// </summary>
    (string RecordingId, string AudioPath) AllocateAsync(DateTimeOffset startedAt);

    /// <summary>Persists the recording. Called once, on teardown, after the WAV is closed.</summary>
    Task<string> CommitAsync(string recordingId, FinishedRecording recording, CancellationToken cancellationToken = default);

    /// <summary>
    /// Removes anything allocated for a recording that never produced usable audio, so a failed
    /// join does not leave a half-written folder behind.
    /// </summary>
    Task AbandonAsync(string recordingId, CancellationToken cancellationToken = default);
}
