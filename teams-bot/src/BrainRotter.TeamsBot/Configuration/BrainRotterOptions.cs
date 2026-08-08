namespace BrainRotter.TeamsBot.Configuration;

/// <summary>
/// Where finished recordings land. Mirrors how the Electron app resolves its own storage root
/// (see <c>src/main/settings.ts</c>: <c>settings.storageRoot</c> or <c>&lt;userData&gt;/recordings</c>).
/// </summary>
public sealed class BrainRotterOptions
{
    public const string SectionName = "BrainRotter";

    /// <summary>
    /// Explicit recordings root. Wins over everything else. Set this when the bot runs on a
    /// different machine than the app and writes to a share or a sync folder.
    /// </summary>
    public string StorageRoot { get; set; } = string.Empty;

    /// <summary>
    /// Override for the Electron <c>userData</c> directory. When set, the bot reads
    /// <c>&lt;userData&gt;/settings.json</c> for a <c>storageRoot</c> override exactly like the app
    /// does, and otherwise uses <c>&lt;userData&gt;/recordings</c>.
    /// </summary>
    public string UserDataDir { get; set; } = string.Empty;

    /// <summary>Electron <c>app.getName()</c> — the folder name under the OS config dir.</summary>
    public string AppName { get; set; } = "brain-rotter";

    /// <summary>
    /// Write a <c>speakers.json</c> next to the audio with per-participant speaking spans derived
    /// from the unmixed audio stream. The parent app ignores it; it is there for later use.
    /// </summary>
    public bool WriteSpeakerAttribution { get; set; } = true;

    /// <summary>How long to wait for the cross-process index lock before giving up.</summary>
    public int IndexLockTimeoutSeconds { get; set; } = 30;
}
