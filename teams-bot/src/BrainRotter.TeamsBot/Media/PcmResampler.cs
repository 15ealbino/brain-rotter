using System.Buffers.Binary;
using Microsoft.Skype.Bots.Media;

namespace BrainRotter.TeamsBot.Media;

/// <summary>
/// Converts whatever the media platform hands us into the 16 kHz mono 16-bit PCM that
/// <see cref="WhisperWavWriter"/> writes.
/// <para>
/// In the normal path this is a no-op copy: the audio socket requests
/// <see cref="AudioFormat.Pcm16K"/> and the platform delivers it. The stereo/48k branches exist
/// because <c>AudioSocketSettings.SupportedAudioFormat</c> is a request, and a bot that is later
/// changed to ask for <see cref="AudioFormat.Pcm48KStereo"/> (for human-perceptible playback
/// quality) should not silently write a mislabelled WAV.
/// </para>
/// </summary>
public static class PcmResampler
{
    /// <summary>Samples per second for each format the platform can deliver.</summary>
    public static int SampleRateOf(AudioFormat format) => format switch
    {
        AudioFormat.Pcm16K => 16_000,
        AudioFormat.Pcm44KStereo => 44_100,
        AudioFormat.Pcm48KStereo => 48_000,
        _ => 16_000,
    };

    public static int ChannelsOf(AudioFormat format) => format switch
    {
        AudioFormat.Pcm44KStereo or AudioFormat.Pcm48KStereo => 2,
        _ => 1,
    };

    public static bool IsAlreadyTarget(AudioFormat format) =>
        SampleRateOf(format) == WhisperWavWriter.SampleRate && ChannelsOf(format) == 1;

    /// <summary>
    /// Worst-case byte count <see cref="Convert"/> can produce for <paramref name="sourceBytes"/>.
    /// </summary>
    public static int MaxOutputBytes(AudioFormat format, int sourceBytes)
    {
        if (IsAlreadyTarget(format)) return sourceBytes;

        var channels = ChannelsOf(format);
        var sourceFrames = sourceBytes / (2 * channels);
        var outFrames = (int)Math.Ceiling((double)sourceFrames * WhisperWavWriter.SampleRate / SampleRateOf(format)) + 1;
        return outFrames * 2;
    }

    /// <summary>
    /// Downmixes to mono and resamples to 16 kHz. Returns the number of bytes written to
    /// <paramref name="destination"/>.
    /// <para>
    /// The resampler is a linear interpolator with no anti-aliasing filter. That is deliberate:
    /// this branch only runs if someone reconfigures the socket away from Pcm16K, and speech
    /// content below 8 kHz — all that whisper uses — survives it. If you need broadcast-quality
    /// downsampling, hand the file to ffmpeg instead of widening this.
    /// </para>
    /// </summary>
    public static int Convert(ReadOnlySpan<byte> source, AudioFormat format, Span<byte> destination)
    {
        if (IsAlreadyTarget(format))
        {
            var n = Math.Min(source.Length, destination.Length);
            // Trim to a whole number of 16-bit samples so we never split a sample across frames.
            n -= n % 2;
            source[..n].CopyTo(destination);
            return n;
        }

        var channels = ChannelsOf(format);
        var sourceRate = SampleRateOf(format);
        var bytesPerFrame = 2 * channels;
        var sourceFrames = source.Length / bytesPerFrame;
        if (sourceFrames == 0) return 0;

        var ratio = (double)sourceRate / WhisperWavWriter.SampleRate;
        var outFrames = (int)(sourceFrames / ratio);
        var written = 0;

        for (var i = 0; i < outFrames; i++)
        {
            var position = i * ratio;
            var index = (int)position;
            var frac = position - index;
            var next = Math.Min(index + 1, sourceFrames - 1);

            var a = MonoSampleAt(source, index, channels, bytesPerFrame);
            var b = MonoSampleAt(source, next, channels, bytesPerFrame);
            var value = (short)Math.Clamp(a + ((b - a) * frac), short.MinValue, short.MaxValue);

            if (written + 2 > destination.Length) break;
            BinaryPrimitives.WriteInt16LittleEndian(destination[written..], value);
            written += 2;
        }

        return written;
    }

    private static int MonoSampleAt(ReadOnlySpan<byte> source, int frame, int channels, int bytesPerFrame)
    {
        var offset = frame * bytesPerFrame;
        var sum = 0;
        for (var c = 0; c < channels; c++)
        {
            sum += BinaryPrimitives.ReadInt16LittleEndian(source[(offset + (c * 2))..]);
        }

        return sum / channels;
    }
}
