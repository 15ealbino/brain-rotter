using System.ComponentModel.DataAnnotations;
using BrainRotter.TeamsBot.Bot;
using BrainRotter.TeamsBot.Extensions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Graph.Communications.Client;

namespace BrainRotter.TeamsBot.Controllers;

[ApiController]
[Route("api")]
public sealed class CallsController(TeamsRecordingBot bot, ILogger<CallsController> logger) : ControllerBase
{
    /// <summary>
    /// The Graph call-notification webhook. Registered as the bot's <c>callbackUri</c>.
    ///
    /// <para>Request validation happens inside <c>ProcessNotificationAsync</c>, which calls
    /// <c>GraphAuthenticationProvider.ValidateInboundRequestAsync</c>: the bearer token must be
    /// signed by the calling platform, carry <c>https://graph.microsoft.com</c> (or the Bot
    /// Framework) as issuer, name this bot's app id as audience, and include a tenant claim.
    /// Anything else gets a 403 and never reaches call state. The endpoint is therefore
    /// deliberately <c>[AllowAnonymous]</c> at the MVC layer — the SDK is the authenticator.</para>
    /// </summary>
    [HttpPost("calls")]
    public async Task OnCallNotificationAsync()
    {
        using var request = this.Request.ToRequestMessage();
        using var response = await bot.Client.ProcessNotificationAsync(request).ConfigureAwait(false);

        // Keeps notifications from pinning to one instance behind a load balancer.
        response.Headers.ConnectionClose = true;

        await response.WriteToAsync(this.Response, this.HttpContext.RequestAborted).ConfigureAwait(false);
    }

    /// <summary>Joins a meeting from a Teams join URL.</summary>
    [HttpPost("join")]
    public async Task<IActionResult> JoinAsync([FromBody] JoinRequest request, CancellationToken cancellationToken)
    {
        if (!bot.CanJoin)
        {
            return this.StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                error = "media_platform_unavailable",
                message = bot.MediaPlatformStatus,
            });
        }

        try
        {
            var call = await bot.JoinAsync(request.JoinUrl, request.TenantId, cancellationToken).ConfigureAwait(false);

            return this.Accepted(new
            {
                callId = call.Id,
                state = call.Resource?.State?.ToString(),
                threadId = call.Resource?.ChatInfo?.ThreadId,
                note = "Recording starts only once updateRecordingStatus(recording) succeeds. " +
                       "If the meeting admits to lobby, an organizer has to let the bot in first.",
            });
        }
        catch (ArgumentException ex)
        {
            return this.BadRequest(new { error = "invalid_join_url", message = ex.Message });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Join failed.");
            return this.StatusCode(StatusCodes.Status502BadGateway, new { error = "join_failed", message = ex.Message });
        }
    }

    /// <summary>Leaves a meeting and finalizes its recording.</summary>
    [HttpPost("leave/{callId}")]
    public async Task<IActionResult> LeaveAsync(string callId, CancellationToken cancellationToken)
    {
        var left = await bot.LeaveAsync(callId, cancellationToken).ConfigureAwait(false);
        return left
            ? this.Accepted(new { callId, message = "Leaving and finalizing the recording." })
            : this.NotFound(new { error = "unknown_call", callId });
    }

    /// <summary>Everything the bot is currently in.</summary>
    [HttpGet("calls")]
    public IActionResult ListCalls() => this.Ok(new
    {
        count = bot.ActiveCalls().Count,
        calls = bot.ActiveCalls(),
    });

    public sealed class JoinRequest
    {
        /// <summary>The "Join the meeting now" link from the invite.</summary>
        [Required]
        public string JoinUrl { get; set; } = string.Empty;

        /// <summary>Optional: overrides the tenant id parsed out of the join URL.</summary>
        public string? TenantId { get; set; }
    }
}
