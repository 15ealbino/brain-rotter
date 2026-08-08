using System.Buffers.Binary;

namespace BrainRotter.TeamsBot.Media;

/// <summary>
/// Streams 16 kHz mono 16-bit PCM into a RIFF/WAVE file.
/// <para>
/// 16 kHz mono is what brain-rotter's whisper.cpp path wants (<c>src/main/ffmpeg.ts</c>
/// <c>toWhisperWav</c>), and it is also what the Teams media platform hands us when the audio
/// socket asks for <see cref="Microsoft.Skype.Bots.Media.AudioFormat.Pcm16K"/> — so in the normal
/// case no resampling happens at all.
/// </para>
/// <para>
/// The header is written up front with placeholder sizes and patched on
/// <see cref="DisposeAsync"/>, so memory use is flat regardless of meeting length. A meeting is
/// 1.92 MB of WAV per minute; an eight-hour cap is ~920 MB.
/// </para>
/// </summary>
public sealed class WhisperWavWriter : IAsyncDisposable
{
    public const int SampleRate = 16_000;
    public const int Channels = 1;
    public const int BitsPerSample = 16;
    private const int HeaderBytes = 44;

    private readonly FileStream stream;
    private long dataBytes;
    private bool finalized;

    private WhisperWavWriter(FileStream stream)
    {
        this.stream = stream;
    }

    public string Path => this.stream.Name;

    public long DataBytes => Interlocked.Read(ref this.dataBytes);

    public TimeSpan Duration =>
        TimeSpan.FromSeconds((double)this.DataBytes / (SampleRate * Channels * (BitsPerSample / 8)));

    /// <summary>Creates the file and writes a placeholder header.</summary>
    public static async Task<WhisperWavWriter> CreateAsync(string path, CancellationToken cancellationToken = default)
    {
        var directory = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var stream = new FileStream(
            path,
            FileMode.Create,
            FileAccess.ReadWrite,
            FileShare.Read,
            bufferSize: 64 * 1024,
            useAsync: true);

        var writer = new WhisperWavWriter(stream);
        await writer.WriteHeaderAsync(cancellationToken).ConfigureAwait(false);
        return writer;
    }

    public async ValueTask WriteAsync(ReadOnlyMemory<byte> pcm, CancellationToken cancellationToken = default)
    {
        if (this.finalized) throw new ObjectDisposedException(nameof(WhisperWavWriter));
        if (pcm.IsEmpty) return;

        await this.stream.WriteAsync(pcm, cancellationToken).ConfigureAwait(false);
        Interlocked.Add(ref this.dataBytes, pcm.Length);
    }

    private async Task WriteHeaderAsync(CancellationToken cancellationToken)
    {
        var header = new byte[HeaderBytes];
        var byteRate = SampleRate * Channels * (BitsPerSample / 8);
        var blockAlign = Channels * (BitsPerSample / 8);

        "RIFF"u8.CopyTo(header);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(4), 0);   // patched on close
        "WAVE"u8.CopyTo(header.AsSpan(8));
        "fmt "u8.CopyTo(header.AsSpan(12));
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(16), 16); // PCM fmt chunk size
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(20), 1);  // WAVE_FORMAT_PCM
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(22), Channels);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(24), SampleRate);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(28), (uint)byteRate);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(32), (ushort)blockAlign);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(34), BitsPerSample);
        "data"u8.CopyTo(header.AsSpan(36));
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(40), 0);  // patched on close

        await this.stream.WriteAsync(header, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Flushes, patches the RIFF/data sizes, and closes. Safe to call twice.</summary>
    public async ValueTask DisposeAsync()
    {
        if (this.finalized)
        {
            return;
        }

        this.finalized = true;

        try
        {
            await this.stream.FlushAsync().ConfigureAwait(false);

            var data = (uint)Math.Min(this.dataBytes, uint.MaxValue - HeaderBytes);
            var sizes = new byte[4];

            this.stream.Seek(4, SeekOrigin.Begin);
            BinaryPrimitives.WriteUInt32LittleEndian(sizes, 36 + data);
            await this.stream.WriteAsync(sizes).ConfigureAwait(false);

            this.stream.Seek(40, SeekOrigin.Begin);
            BinaryPrimitives.WriteUInt32LittleEndian(sizes, data);
            await this.stream.WriteAsync(sizes).ConfigureAwait(false);

            await this.stream.FlushAsync().ConfigureAwait(false);
        }
        finally
        {
            await this.stream.DisposeAsync().ConfigureAwait(false);
        }
    }
}
