using System.Text.Json;
using BrainRotter.TeamsBot.Configuration;
using Microsoft.Extensions.Options;

namespace BrainRotter.TeamsBot.Sinks;

/// <summary>
/// Works out where brain-rotter keeps its recordings, using the same rules the Electron app does.
/// <para>
/// Order of precedence:
/// </para>
/// <list type="number">
///   <item><c>BrainRotter:StorageRoot</c> — explicit override, always wins.</item>
///   <item><c>&lt;userData&gt;/settings.json</c> → <c>storageRoot</c>, when non-empty. This is
///     exactly what <c>storageRoot()</c> in <c>src/main/settings.ts</c> reads.</item>
///   <item><c>&lt;userData&gt;/recordings</c> — the app's default.</item>
/// </list>
/// <para>
/// <c>&lt;userData&gt;</c> follows Electron's <c>app.getPath('userData')</c>:
/// <c>%APPDATA%\brain-rotter</c> on Windows, <c>~/.config/brain-rotter</c> on Linux,
/// <c>~/Library/Application Support/brain-rotter</c> on macOS.
/// </para>
/// <para>
/// <b>Cross-machine caveat.</b> When the bot runs on a Windows Server VM and the app runs on the
/// user's laptop, this resolves to a path on the <i>VM</i>, which the laptop cannot see. Nothing
/// here copies files between machines. See the README section "Getting audio to the app".
/// </para>
/// </summary>
public sealed class StorageRootResolver(IOptions<BrainRotterOptions> options, ILogger<StorageRootResolver> logger)
{
    private readonly BrainRotterOptions options = options.Value;

    public string Resolve()
    {
        if (!string.IsNullOrWhiteSpace(this.options.StorageRoot))
        {
            return Path.GetFullPath(this.options.StorageRoot);
        }

        var userData = this.ResolveUserDataDir();
        var fromSettings = this.ReadStorageRootFromSettings(userData);
        if (!string.IsNullOrWhiteSpace(fromSettings))
        {
            logger.LogInformation("Using storageRoot from {Settings}: {Root}", Path.Combine(userData, "settings.json"), fromSettings);
            return Path.GetFullPath(fromSettings);
        }

        return Path.GetFullPath(Path.Combine(userData, "recordings"));
    }

    public string ResolveUserDataDir()
    {
        if (!string.IsNullOrWhiteSpace(this.options.UserDataDir))
        {
            return Path.GetFullPath(this.options.UserDataDir);
        }

        var appName = string.IsNullOrWhiteSpace(this.options.AppName) ? "brain-rotter" : this.options.AppName;

        if (OperatingSystem.IsWindows())
        {
            // Electron uses %APPDATA% (roaming), not LocalApplicationData.
            var appData = Environment.GetEnvironmentVariable("APPDATA")
                          ?? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            return Path.Combine(appData, appName);
        }

        if (OperatingSystem.IsMacOS())
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, "Library", "Application Support", appName);
        }

        var xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
        if (string.IsNullOrWhiteSpace(xdg))
        {
            xdg = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config");
        }

        return Path.Combine(xdg, appName);
    }

    private string? ReadStorageRootFromSettings(string userDataDir)
    {
        var settingsPath = Path.Combine(userDataDir, "settings.json");
        if (!File.Exists(settingsPath))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("storageRoot", out var value) &&
                value.ValueKind == JsonValueKind.String)
            {
                var root = value.GetString();
                return string.IsNullOrWhiteSpace(root) ? null : root;
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not read {Path}; falling back to the default recordings folder.", settingsPath);
        }

        return null;
    }
}
