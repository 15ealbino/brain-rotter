using System.Text.Json;
using System.Text.Json.Serialization;

namespace BrainRotter.TeamsBot.Sinks;

/// <summary>
/// The exact shape of one row in brain-rotter's <c>index.json</c> and of each
/// <c>&lt;id&gt;/meta.json</c>.
/// <para>
/// Mirrors <c>RecordingMeta</c> in <c>src/shared/types.ts</c> field for field. If that interface
/// changes, this must change with it — there is no shared schema between the two projects.
/// </para>
/// </summary>
public sealed class RecordingMeta
{
    /// <summary>
    /// Must match <c>/^[A-Za-z0-9_-]+$/</c> — <c>recordingDir()</c> in <c>src/main/recordings.ts</c>
    /// rejects anything else, so a plain lowercase GUID is used.
    /// </summary>
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    /// <summary>ISO-8601. The Library sorts on this descending.</summary>
    [JsonPropertyName("createdAt")]
    public string CreatedAt { get; set; } = string.Empty;

    [JsonPropertyName("durationSec")]
    public double DurationSec { get; set; }

    /// <summary>File name only, not a path. Resolved against <c>&lt;storageRoot&gt;/&lt;id&gt;/</c>.</summary>
    [JsonPropertyName("audioFile")]
    public string AudioFile { get; set; } = string.Empty;

    [JsonPropertyName("sizeBytes")]
    public long SizeBytes { get; set; }

    /// <summary>
    /// One of <c>none | pending | running | done | error</c>. We write <c>none</c>: that is what
    /// <c>saveRecording()</c> sets for a fresh recording, and it is the state the Library treats as
    /// "not transcribed yet", so the user can run local whisper.cpp over it.
    /// </summary>
    [JsonPropertyName("transcription")]
    public string Transcription { get; set; } = TranscriptionStatus.None;

    [JsonPropertyName("transcriptionError")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? TranscriptionError { get; set; }

    /// <summary>
    /// True: the meeting mix is exactly the "what everyone else says" side the app means by
    /// system audio.
    /// </summary>
    [JsonPropertyName("capturedSystemAudio")]
    public bool CapturedSystemAudio { get; set; } = true;

    /// <summary>
    /// False: the bot has no microphone. Its own send stream is inactive and it contributes
    /// nothing to the mix.
    /// </summary>
    [JsonPropertyName("capturedMicrophone")]
    public bool CapturedMicrophone { get; set; }

    /// <summary>
    /// Preserves any fields a newer version of the app added, so a round-trip through this bot
    /// never drops data from someone else's row.
    /// </summary>
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalData { get; set; }
}

public static class TranscriptionStatus
{
    public const string None = "none";
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Done = "done";
    public const string Error = "error";
}

/// <summary>Top-level shape of <c>index.json</c>.</summary>
public sealed class RecordingsIndex
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("recordings")]
    public List<RecordingMeta> Recordings { get; set; } = [];
}
