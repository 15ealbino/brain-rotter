using System.Diagnostics;
using System.Text.Json;
using BrainRotter.TeamsBot.Configuration;
using Microsoft.Extensions.Options;

namespace BrainRotter.TeamsBot.Sinks;

/// <summary>
/// Inserts and updates rows in brain-rotter's <c>index.json</c> without losing anyone else's
/// writes.
///
/// <para><b>Why this is fiddly.</b> The Electron app may be running while the bot finalizes a
/// recording, and it does its own read → modify → write on the same file
/// (<c>upsert()</c>/<c>writeIndex()</c> in <c>src/main/recordings.ts</c>). A naive write from here
/// would silently drop rows the app added in between.</para>
///
/// <para><b>What we do.</b> Take a cross-process advisory lock (an exclusive <c>index.lock</c>
/// file), then re-read the index from disk, remove only our own id, append our row, sort, write to
/// <c>index.json.tmp</c>, <c>fsync</c>, and atomically rename over the original — the same
/// temp-then-rename dance the app uses, so a crash never leaves a half-written index.</para>
///
/// <para><b>Residual race, stated honestly.</b> The Electron app does not take this lock; it has no
/// idea the bot exists. So the lock only serialises multiple bot instances against each other. If
/// the app happens to write in the exact window between our read and our rename, its row can still
/// be lost. The window is a few milliseconds and the damage is recoverable: the app rebuilds the
/// index from each folder's <c>meta.json</c> when the index is unreadable
/// (<c>rebuildIndexFromDisk()</c>), and we always write <c>meta.json</c> before touching the index,
/// so no recording is ever unrecoverable. Closing the window properly would need a change on the
/// Electron side, which is out of scope for this component.</para>
/// </summary>
public sealed class RecordingIndexWriter(
    IOptions<BrainRotterOptions> options,
    ILogger<RecordingIndexWriter> logger)
{
    private const string IndexFileName = "index.json";
    private const string LockFileName = "index.lock";

    /// <summary>A lock older than this is assumed to belong to a crashed process and is broken.</summary>
    private static readonly TimeSpan StaleLockAge = TimeSpan.FromMinutes(2);

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        WriteIndented = true,
    };

    private readonly TimeSpan lockTimeout =
        TimeSpan.FromSeconds(Math.Clamp(options.Value.IndexLockTimeoutSeconds, 1, 300));

    public async Task UpsertAsync(string storageRoot, RecordingMeta meta, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(storageRoot);

        var indexPath = Path.Combine(storageRoot, IndexFileName);
        using var _ = await this.AcquireLockAsync(storageRoot, cancellationToken).ConfigureAwait(false);

        var index = await this.ReadAsync(indexPath, cancellationToken).ConfigureAwait(false);

        var replaced = index.Recordings.RemoveAll(r => string.Equals(r.Id, meta.Id, StringComparison.Ordinal)) > 0;
        var preserved = index.Recordings.Count;
        index.Recordings.Add(meta);
        index.Version = 1;

        // Newest first, matching sortRecordings() in the app.
        index.Recordings.Sort((a, b) => string.CompareOrdinal(b.CreatedAt, a.CreatedAt));

        await WriteAtomicAsync(indexPath, index, cancellationToken).ConfigureAwait(false);

        logger.LogInformation(
            "Wrote {Path}: {Preserved} existing row(s) preserved, {Id} {Action}.",
            indexPath,
            preserved,
            meta.Id,
            replaced ? "updated" : "inserted");
    }

    private async Task<RecordingsIndex> ReadAsync(string indexPath, CancellationToken cancellationToken)
    {
        if (!File.Exists(indexPath))
        {
            return new RecordingsIndex();
        }

        try
        {
            await using var stream = new FileStream(indexPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var parsed = await JsonSerializer.DeserializeAsync<RecordingsIndex>(stream, cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            if (parsed?.Recordings is not null)
            {
                return parsed;
            }
        }
        catch (Exception ex)
        {
            // Do NOT overwrite an index we could not parse with an empty one — that would delete
            // the user's library. Rebuild from the per-recording meta.json files instead, which is
            // exactly what the app does in rebuildIndexFromDisk().
            logger.LogError(ex, "{Path} is unreadable; rebuilding the row list from each folder's meta.json.", indexPath);
            return new RecordingsIndex { Recordings = this.RebuildFromDisk(Path.GetDirectoryName(indexPath)!) };
        }

        logger.LogWarning("{Path} had no recordings array; rebuilding from disk.", indexPath);
        return new RecordingsIndex { Recordings = this.RebuildFromDisk(Path.GetDirectoryName(indexPath)!) };
    }

    private List<RecordingMeta> RebuildFromDisk(string storageRoot)
    {
        var rows = new List<RecordingMeta>();

        foreach (var dir in Directory.EnumerateDirectories(storageRoot))
        {
            var metaPath = Path.Combine(dir, BrainRotterSink.MetaFileName);
            if (!File.Exists(metaPath)) continue;

            try
            {
                var row = JsonSerializer.Deserialize<RecordingMeta>(File.ReadAllText(metaPath));
                if (row is not null && !string.IsNullOrWhiteSpace(row.Id))
                {
                    rows.Add(row);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Skipping unreadable {Path} while rebuilding the index.", metaPath);
            }
        }

        logger.LogInformation("Recovered {Count} recording(s) from disk.", rows.Count);
        return rows;
    }

    private static async Task WriteAtomicAsync(string indexPath, RecordingsIndex index, CancellationToken cancellationToken)
    {
        var tempPath = indexPath + ".tmp";

        await using (var stream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await JsonSerializer.SerializeAsync(stream, index, WriteOptions, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);

            // Force the bytes down before the rename, so a power loss cannot leave us pointing at
            // an empty file.
            stream.Flush(flushToDisk: true);
        }

        File.Move(tempPath, indexPath, overwrite: true);
    }

    private async Task<IDisposable> AcquireLockAsync(string storageRoot, CancellationToken cancellationToken)
    {
        var lockPath = Path.Combine(storageRoot, LockFileName);
        var deadline = Stopwatch.StartNew();
        var timeout = this.lockTimeout;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                var handle = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
                return new FileLock(handle, lockPath, logger);
            }
            catch (IOException)
            {
                if (TryBreakStaleLock(lockPath))
                {
                    logger.LogWarning("Broke a stale {Path} left behind by a crashed process.", lockPath);
                    continue;
                }

                if (deadline.Elapsed > timeout)
                {
                    logger.LogWarning("Could not take {Path} within {Timeout}s; proceeding without it.", lockPath, timeout.TotalSeconds);
                    return new NoLock();
                }

                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static bool TryBreakStaleLock(string lockPath)
    {
        try
        {
            var age = DateTime.UtcNow - File.GetCreationTimeUtc(lockPath);
            if (age <= StaleLockAge) return false;

            File.Delete(lockPath);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private sealed class FileLock(FileStream handle, string path, ILogger logger) : IDisposable
    {
        public void Dispose()
        {
            try
            {
                // FileOptions.DeleteOnClose removes the file for us.
                handle.Dispose();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Could not release {Path}.", path);
            }
        }
    }

    private sealed class NoLock : IDisposable
    {
        public void Dispose()
        {
        }
    }
}
