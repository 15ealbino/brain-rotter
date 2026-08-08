using System.Text.Json;
using BrainRotter.TeamsBot.Configuration;
using Microsoft.Extensions.Options;

namespace BrainRotter.TeamsBot.Sinks;

/// <summary>
/// Writes finished meetings into brain-rotter's recordings storage so they appear in the app's
/// Library and can be transcribed by its local whisper.cpp path.
///
/// <para>The on-disk layout is documented at the top of <c>src/main/recordings.ts</c> and this
/// implementation follows it exactly:</para>
/// <code>
/// &lt;storageRoot&gt;/
///   index.json                      list of recordings, newest first
///   &lt;recording-id&gt;/audio.wav     the playable audio
///   &lt;recording-id&gt;/meta.json     a copy of the index row, so a lost index can be rebuilt
///   &lt;recording-id&gt;/transcript.json  written later by the app, not by us
/// </code>
///
/// <para>Two deliberate choices worth knowing:</para>
/// <list type="bullet">
///   <item><c>audioFile</c> is <c>audio.wav</c>, not the app's own <c>audio.webm</c>. The field
///     exists precisely so the extension can vary, and the app resolves playback and transcription
///     through it (<c>audioPath()</c>, <c>transcribeRecording()</c>). Its ffmpeg step
///     (<c>toWhisperWav</c>) re-reads whatever is there, and a 16 kHz mono WAV passes through
///     essentially untouched.</item>
///   <item><c>transcription</c> is <c>"none"</c> — the same value <c>saveRecording()</c> writes for
///     a fresh recording. That is what makes the Library offer to transcribe it rather than
///     treating it as already done.</item>
/// </list>
/// </summary>
public sealed class BrainRotterSink(
    StorageRootResolver storageRootResolver,
    RecordingIndexWriter indexWriter,
    IOptions<BrainRotterOptions> options,
    ILogger<BrainRotterSink> logger) : IRecordingSink
{
    public const string AudioFileName = "audio.wav";
    public const string MetaFileName = "meta.json";
    public const string SpeakersFileName = "speakers.json";

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true };

    private readonly BrainRotterOptions options = options.Value;

    public string Name => "brain-rotter";

    public string StorageRoot => storageRootResolver.Resolve();

    /// <inheritdoc />
    public (string RecordingId, string AudioPath) AllocateAsync(DateTimeOffset startedAt)
    {
        // Lowercase GUID with dashes satisfies recordingDir()'s /^[A-Za-z0-9_-]+$/ guard.
        var recordingId = Guid.NewGuid().ToString("d");
        var directory = Path.Combine(this.StorageRoot, recordingId);
        Directory.CreateDirectory(directory);

        // Capturing straight into the final folder means committing is a metadata write, not a
        // multi-hundred-megabyte copy at the exact moment the meeting ends.
        return (recordingId, Path.Combine(directory, AudioFileName));
    }

    /// <inheritdoc />
    public async Task<string> CommitAsync(
        string recordingId,
        FinishedRecording recording,
        CancellationToken cancellationToken = default)
    {
        var directory = Path.Combine(this.StorageRoot, recordingId);
        Directory.CreateDirectory(directory);

        var audioPath = Path.Combine(directory, AudioFileName);
        if (!string.Equals(Path.GetFullPath(recording.AudioPath), Path.GetFullPath(audioPath), StringComparison.Ordinal))
        {
            File.Move(recording.AudioPath, audioPath, overwrite: true);
        }

        var info = new FileInfo(audioPath);
        if (!info.Exists || info.Length <= 44)
        {
            throw new InvalidOperationException(
                $"The capture for call {recording.CallId} produced no audio ({info.Length} bytes). " +
                "Nothing was added to the library.");
        }

        var meta = new RecordingMeta
        {
            Id = recordingId,
            Title = recording.Title,
            CreatedAt = recording.StartedAt.UtcDateTime.ToString("o"),
            DurationSec = Math.Round(recording.Duration.TotalSeconds, 2),
            AudioFile = AudioFileName,
            SizeBytes = info.Length,
            Transcription = TranscriptionStatus.None,
            CapturedSystemAudio = true,
            CapturedMicrophone = false,
        };

        // meta.json first, always. If the index write then fails or races, the app can still
        // recover this recording via rebuildIndexFromDisk().
        await File.WriteAllTextAsync(
            Path.Combine(directory, MetaFileName),
            JsonSerializer.Serialize(meta, WriteOptions),
            cancellationToken).ConfigureAwait(false);

        if (this.options.WriteSpeakerAttribution && recording.SpeakerActivity.Count > 0)
        {
            await this.WriteSpeakersAsync(directory, recording, cancellationToken).ConfigureAwait(false);
        }

        await indexWriter.UpsertAsync(this.StorageRoot, meta, cancellationToken).ConfigureAwait(false);

        logger.LogInformation(
            "Committed recording {Id} ({Duration}, {Bytes} bytes) to {Root}. Transcription status 'none' — the app will offer to transcribe it.",
            recordingId,
            recording.Duration,
            info.Length,
            this.StorageRoot);

        return recordingId;
    }

    /// <inheritdoc />
    public Task AbandonAsync(string recordingId, CancellationToken cancellationToken = default)
    {
        var directory = Path.Combine(this.StorageRoot, recordingId);

        try
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
                logger.LogInformation("Discarded {Directory}: the recording produced nothing usable.", directory);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not clean up {Directory}.", directory);
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// Speaker attribution alongside the audio. brain-rotter's <c>Transcript</c> type has no
    /// speaker field, so the app ignores this file — it exists so the information is not thrown
    /// away, and so a later version can use it.
    /// </summary>
    private async Task WriteSpeakersAsync(string directory, FinishedRecording recording, CancellationToken cancellationToken)
    {
        var payload = new
        {
            version = 1,
            source = "teams-unmixed-audio",
            note = "Derived from per-participant (unmixed) Teams audio. Not read by brain-rotter.",
            participants = recording.Participants,
            spans = recording.SpeakerActivity.Select(s => new
            {
                speaker = s.Speaker,
                start = Math.Round(s.StartSeconds, 3),
                end = Math.Round(s.EndSeconds, 3),
            }),
        };

        await File.WriteAllTextAsync(
            Path.Combine(directory, SpeakersFileName),
            JsonSerializer.Serialize(payload, WriteOptions),
            cancellationToken).ConfigureAwait(false);
    }
}
