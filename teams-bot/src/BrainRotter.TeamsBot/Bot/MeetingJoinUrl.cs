using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Graph.Contracts;
using Microsoft.Graph.Models;

namespace BrainRotter.TeamsBot.Bot;

/// <summary>
/// Meeting coordinates pulled out of a Teams "join meeting" URL.
/// </summary>
public sealed record MeetingCoordinates(ChatInfo ChatInfo, MeetingInfo MeetingInfo, string? TenantId)
{
    public string ThreadId => this.ChatInfo.ThreadId ?? string.Empty;

    public string? OrganizerId => (this.MeetingInfo as OrganizerMeetingInfo)?.Organizer?.User?.Id;
}

/// <summary>
/// Parses the join URL Teams puts in a meeting invite into the thread id / organizer id /
/// tenant id triple that <c>POST /communications/calls</c> needs.
/// </summary>
public static partial class MeetingJoinUrl
{
    /// <summary>
    /// Matches both the historical and current shapes, e.g.
    /// <c>https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context={"Tid":"...","Oid":"..."}</c>
    /// The thread segment is the second-to-last path segment and the message id is the last.
    /// </summary>
    [GeneratedRegex(
        @"https://teams\.(microsoft|live)\.com.*/(?<thread>[^/]+)/(?<message>[^/?]+)\?context=(?<context>\{.*\})",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex JoinUrlPattern();

    public static bool TryParse(string joinUrl, out MeetingCoordinates coordinates, out string error)
    {
        coordinates = null!;
        error = string.Empty;

        if (string.IsNullOrWhiteSpace(joinUrl))
        {
            error = "The join URL was empty.";
            return false;
        }

        // Teams URLs arrive percent-encoded from Outlook/Teams; the context blob is JSON.
        var decoded = WebUtility.UrlDecode(joinUrl.Trim());
        var match = JoinUrlPattern().Match(decoded);
        if (!match.Success)
        {
            error = "The join URL does not look like a Teams meeting link. " +
                    "Copy it from the meeting invite ('Join the meeting now' / 'Click here to join the meeting').";
            return false;
        }

        JoinContext? context;
        try
        {
            context = JsonSerializer.Deserialize<JoinContext>(match.Groups["context"].Value);
        }
        catch (JsonException ex)
        {
            error = $"The context fragment of the join URL is not valid JSON: {ex.Message}";
            return false;
        }

        if (context is null || string.IsNullOrWhiteSpace(context.Oid))
        {
            error = "The join URL's context fragment carried no organizer object id (Oid). " +
                    "Channel-meeting links and some tenant-restricted links do not; use the thread id directly instead.";
            return false;
        }

        var chatInfo = new ChatInfo
        {
            ThreadId = match.Groups["thread"].Value,
            MessageId = match.Groups["message"].Value,
            ReplyChainMessageId = context.MessageId,
        };

        var organizer = new IdentitySet { User = new Identity { Id = context.Oid } };
        if (!string.IsNullOrWhiteSpace(context.Tid))
        {
            // The tenant id lives in Identity.AdditionalData["tenantId"]; the SDK ships an
            // extension for it rather than a first-class property.
            organizer.User!.SetTenantId(context.Tid);
        }

        coordinates = new MeetingCoordinates(chatInfo, new OrganizerMeetingInfo { Organizer = organizer }, context.Tid);
        return true;
    }

    private sealed class JoinContext
    {
        [JsonPropertyName("Tid")]
        public string? Tid { get; set; }

        [JsonPropertyName("Oid")]
        public string? Oid { get; set; }

        [JsonPropertyName("MessageId")]
        public string? MessageId { get; set; }
    }
}
