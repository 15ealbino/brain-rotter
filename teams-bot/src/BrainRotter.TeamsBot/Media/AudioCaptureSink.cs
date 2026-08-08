using System.Buffers;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading.Channels;
using BrainRotter.TeamsBot.Bot;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Skype.Bots.Media;

namespace BrainRotter.TeamsBot.Media;

/// <summary>One participant's speaking span, derived from the unmixed audio stream.</summary>
public sealed record SpeakerSpan(uint MediaSourceId, double StartSeconds, double EndSeconds);

/// <summary>
/// Pulls PCM off the Teams audio socket and streams it to a WAV file.
///
/// <para><b>This type cannot exist before recording consent.</b> Its constructor is private and
/// <see cref="StartAsync"/> demands a <see cref="RecordingConsent"/>, which only
/// <see cref="RecordingConsentGate"/> can mint and only after <c>updateRecordingStatus(recording)</c>
/// returned success. The file handle is opened and the <c>AudioMediaReceived</c> handler is
/// subscribed inside <see cref="StartAsync"/> — so before consent there is no file, no subscription,
/// and no reference to any media buffer.</para>
///
/// <para><b>Backpressure.</b> <c>AudioMediaReceived</c> fires on a media platform thread roughly
/// 50×/second (20 ms frames). Blocking it stalls the media stack, so the handler only copies the
/// unmanaged buffer into a pooled array and drops it in a bounded channel; a single background task
/// does the file I/O. When the channel is full — a stalled disk, a paused VM — frames are dropped
/// and counted rather than queued, which keeps memory flat on an eight-hour meeting. A dropped
/// frame is 20 ms of silence in the transcript; an OOM is the whole recording.</para>
///
/// <para><b>Mixed vs unmixed.</b> We request unmixed (per-participant) audio when configured,
/// because it is strictly more information — but we still write the <i>mixed</i> stream as the
/// playable file. Two reasons: brain-rotter's <c>RecordingMeta</c> has exactly one
/// <c>audioFile</c> and its player plays exactly one track; and Microsoft documents unmixed audio
/// as "optimized for machine cognition (e.g. speech recognition) rather than for human perception
/// (such as call recording and playback)". Setting <c>EnableLocalAudioMixingForUnmixed</c> gets us
/// both streams, so the unmixed side is used for speaker attribution
/// (<see cref="SpeakerSpans"/>) while the mix is what lands in the Library.</para>
/// </summary>
public sealed class AudioCaptureSink : IAsyncDisposable
{
    /// <summary>~10 s of 20 ms frames. Past this the disk is not keeping up and queuing is pointless.</summary>
    private const int ChannelCapacity = 500;

    /// <summary>Gap longer than this closes a speaker span and starts a new one.</summary>
    private const double SpeakerSpanGapSeconds = 1.0;

    private readonly IAudioSocket audioSocket;
    private readonly IGraphLogger logger;
    private readonly WhisperWavWriter writer;
    private readonly Channel<PcmFrame> frames;
    private readonly Task drainTask;
    private readonly CancellationTokenSource shutdown = new();
    private readonly ConcurrentDictionary<uint, MutableSpan> openSpeakerSpans = new();
    private readonly List<SpeakerSpan> completedSpeakerSpans = [];
    private readonly object speakerLock = new();
    private readonly bool trackSpeakers;

    private long framesReceived;
    private long framesDropped;
    private long bytesWritten;
    private int disposed;

    private AudioCaptureSink(
        IAudioSocket audioSocket,
        WhisperWavWriter writer,
        IGraphLogger logger,
        bool trackSpeakers)
    {
        this.audioSocket = audioSocket;
        this.writer = writer;
        this.logger = logger;
        this.trackSpeakers = trackSpeakers;

        this.frames = Channel.CreateBounded<PcmFrame>(new BoundedChannelOptions(ChannelCapacity)
        {
            FullMode = BoundedChannelFullMode.DropWrite,
            SingleReader = true,
            SingleWriter = false,
        });

        this.drainTask = Task.Run(this.DrainAsync);
    }

    public string AudioPath => this.writer.Path;

    public TimeSpan Duration => this.writer.Duration;

    public long BytesWritten => Interlocked.Read(ref this.bytesWritten);

    public long FramesReceived => Interlocked.Read(ref this.framesReceived);

    public long FramesDropped => Interlocked.Read(ref this.framesDropped);

    /// <summary>
    /// Opens the WAV file and starts capturing.
    /// </summary>
    /// <param name="consent">
    /// Proof that <c>updateRecordingStatus(recording)</c> succeeded. Not optional, not nullable,
    /// and not constructible outside <see cref="RecordingConsentGate"/>.
    /// </param>
    public static async Task<AudioCaptureSink> StartAsync(
        RecordingConsent consent,
        IAudioSocket audioSocket,
        string audioPath,
        IGraphLogger logger,
        bool trackSpeakers,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(consent);
        ArgumentNullException.ThrowIfNull(audioSocket);

        logger.Info($"[{consent.CallId}] Consent granted at {consent.GrantedAt:O}; opening {audioPath}.");

        // First byte of disk state for this recording. Nothing above this line touches the disk.
        var writer = await WhisperWavWriter.CreateAsync(audioPath, cancellationToken).ConfigureAwait(false);
        var sink = new AudioCaptureSink(audioSocket, writer, logger, trackSpeakers);

        audioSocket.AudioMediaReceived += sink.OnAudioMediaReceived;
        logger.Info($"[{consent.CallId}] Audio capture is live.");
        return sink;
    }

    /// <summary>
    /// Copies the frame out of unmanaged memory and hands it to the writer task. Runs on a media
    /// thread — it must not block, allocate heavily, or throw.
    /// </summary>
    private void OnAudioMediaReceived(object? sender, AudioMediaReceivedEventArgs e)
    {
        var buffer = e.Buffer;
        try
        {
            Interlocked.Increment(ref this.framesReceived);

            if (this.trackSpeakers)
            {
                this.RecordSpeakerActivity(buffer);
            }

            var length = (int)buffer.Length;
            if (length <= 0 || buffer.Data == IntPtr.Zero)
            {
                return;
            }

            var format = buffer.AudioFormat;
            var capacity = PcmResampler.MaxOutputBytes(format, length);
            var rented = ArrayPool<byte>.Shared.Rent(capacity);

            int produced;
            if (PcmResampler.IsAlreadyTarget(format))
            {
                Marshal.Copy(buffer.Data, rented, 0, length);
                produced = length;
            }
            else
            {
                // Two-stage: unmanaged -> pooled staging -> converted. Only taken when the socket
                // is configured for something other than Pcm16K.
                var staging = ArrayPool<byte>.Shared.Rent(length);
                try
                {
                    Marshal.Copy(buffer.Data, staging, 0, length);
                    produced = PcmResampler.Convert(staging.AsSpan(0, length), format, rented);
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(staging);
                }
            }

            if (produced <= 0)
            {
                ArrayPool<byte>.Shared.Return(rented);
                return;
            }

            if (!this.frames.Writer.TryWrite(new PcmFrame(rented, produced)))
            {
                ArrayPool<byte>.Shared.Return(rented);
                var dropped = Interlocked.Increment(ref this.framesDropped);

                // ~1 line per 10 s of sustained backpressure, not one per frame.
                if (dropped % ChannelCapacity == 1)
                {
                    this.logger.Warn(
                        $"Audio write queue is full; dropped {dropped} frames so far. " +
                        "The disk is not keeping up with the meeting. Recording continues with gaps.");
                }
            }
        }
        catch (Exception ex)
        {
            this.logger.Error(ex, "Failed to handle an audio frame; dropping it.");
        }
        finally
        {
            // Mandatory: releases the unmanaged buffer back to the media platform.
            buffer.Dispose();
        }
    }

    private async Task DrainAsync()
    {
        try
        {
            await foreach (var frame in this.frames.Reader.ReadAllAsync(this.shutdown.Token).ConfigureAwait(false))
            {
                try
                {
                    await this.writer.WriteAsync(frame.Buffer.AsMemory(0, frame.Length)).ConfigureAwait(false);
                    Interlocked.Add(ref this.bytesWritten, frame.Length);
                }
                catch (Exception ex)
                {
                    this.logger.Error(ex, "Failed writing an audio frame to disk.");
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(frame.Buffer);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
        catch (Exception ex)
        {
            this.logger.Error(ex, "The audio writer task ended unexpectedly. The recording will be truncated.");
        }
    }

    private void RecordSpeakerActivity(AudioMediaBuffer buffer)
    {
        var unmixed = buffer.UnmixedAudioBuffers;
        if (unmixed is null || unmixed.Length == 0)
        {
            return;
        }

        // Position in the output file, not wall clock — that is what a transcript needs.
        var now = this.writer.Duration.TotalSeconds;

        foreach (var part in unmixed)
        {
            if (part.Length <= 0) continue;

            var span = this.openSpeakerSpans.GetOrAdd(part.ActiveSpeakerId, _ => new MutableSpan(now, now));
            lock (span)
            {
                if (now - span.End > SpeakerSpanGapSeconds)
                {
                    lock (this.speakerLock)
                    {
                        this.completedSpeakerSpans.Add(new SpeakerSpan(part.ActiveSpeakerId, span.Start, span.End));
                    }

                    span.Start = now;
                }

                span.End = now;
            }
        }
    }

    /// <summary>Speaking spans collected so far, flushed and ordered. Empty when unmixed audio was off.</summary>
    public IReadOnlyList<SpeakerSpan> SpeakerSpans()
    {
        lock (this.speakerLock)
        {
            var all = new List<SpeakerSpan>(this.completedSpeakerSpans);
            foreach (var (sourceId, span) in this.openSpeakerSpans)
            {
                lock (span)
                {
                    if (span.End > span.Start)
                    {
                        all.Add(new SpeakerSpan(sourceId, span.Start, span.End));
                    }
                }
            }

            all.Sort((a, b) => a.StartSeconds.CompareTo(b.StartSeconds));
            return all;
        }
    }

    /// <summary>
    /// Unsubscribes, drains anything already queued, and closes the WAV with correct sizes.
    /// Idempotent — the teardown paths (call ended, bot removed, meeting over, shutdown) all
    /// converge here.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) == 1)
        {
            return;
        }

        try
        {
            this.audioSocket.AudioMediaReceived -= this.OnAudioMediaReceived;
        }
        catch (Exception ex)
        {
            this.logger.Warn(ex, "Could not detach the audio handler; the socket may already be gone.");
        }

        this.frames.Writer.TryComplete();

        // Give the writer a bounded window to flush the tail rather than hanging teardown.
        var finished = await Task.WhenAny(this.drainTask, Task.Delay(TimeSpan.FromSeconds(10))).ConfigureAwait(false);
        if (finished != this.drainTask)
        {
            this.logger.Warn("Audio writer did not drain within 10s; finalizing the file anyway.");
            await this.shutdown.CancelAsync().ConfigureAwait(false);
        }

        // Return anything still sitting in the channel so the pool is not leaked.
        while (this.frames.Reader.TryRead(out var leftover))
        {
            ArrayPool<byte>.Shared.Return(leftover.Buffer);
        }

        await this.writer.DisposeAsync().ConfigureAwait(false);
        this.shutdown.Dispose();

        this.logger.Info(
            $"Audio capture finalized: {this.writer.Path} " +
            $"({this.writer.Duration:hh\\:mm\\:ss}, {this.FramesReceived} frames received, {this.FramesDropped} dropped).");
    }

    private readonly record struct PcmFrame(byte[] Buffer, int Length);

    private sealed class MutableSpan(double start, double end)
    {
        public double Start { get; set; } = start;

        public double End { get; set; } = end;
    }
}
