using BrainRotter.TeamsBot.Bot;
using BrainRotter.TeamsBot.Sinks;
using Microsoft.AspNetCore.Mvc;

namespace BrainRotter.TeamsBot.Controllers;

[ApiController]
public sealed class HealthController(TeamsRecordingBot bot, IRecordingSink sink) : ControllerBase
{
    /// <summary>
    /// Liveness plus the two things that actually go wrong: media platform initialization and a
    /// storage root the bot cannot write to.
    /// </summary>
    [HttpGet("/healthz")]
    public IActionResult Health()
    {
        var storageRoot = sink is BrainRotterSink brainRotter ? brainRotter.StorageRoot : "(n/a)";
        var storageWritable = TryWrite(storageRoot, out var storageError);
        var healthy = bot.CanJoin && storageWritable;

        return this.StatusCode(healthy ? StatusCodes.Status200OK : StatusCodes.Status503ServiceUnavailable, new
        {
            status = healthy ? "healthy" : "degraded",
            mediaPlatform = bot.CanJoin ? "ready" : "unavailable",
            mediaPlatformDetail = bot.MediaPlatformStatus,
            sink = sink.Name,
            storageRoot,
            storageWritable,
            storageError,
            activeCalls = bot.ActiveCalls().Count,
            version = typeof(HealthController).Assembly.GetName().Version?.ToString(),
        });
    }

    private static bool TryWrite(string root, out string? error)
    {
        error = null;
        try
        {
            Directory.CreateDirectory(root);
            var probe = Path.Combine(root, $".healthz-{Guid.NewGuid():N}");
            System.IO.File.WriteAllText(probe, string.Empty);
            System.IO.File.Delete(probe);
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }
}
