using Microsoft.AspNetCore.Http.Extensions;

namespace BrainRotter.TeamsBot.Extensions;

/// <summary>
/// Bridges ASP.NET Core's <see cref="HttpRequest"/>/<see cref="HttpResponse"/> and the
/// <see cref="HttpRequestMessage"/>/<see cref="HttpResponseMessage"/> pair the Graph Communications
/// SDK's notification pipeline works in.
/// </summary>
public static class HttpExtensions
{
    public static HttpRequestMessage ToRequestMessage(this HttpRequest request)
    {
        var message = new HttpRequestMessage
        {
            RequestUri = new Uri(request.GetDisplayUrl()),
            Method = new HttpMethod(request.Method),
        };

        if (request.ContentLength is > 0)
        {
            message.Content = new StreamContent(request.Body);
        }

        foreach (var header in request.Headers)
        {
            // Content headers are rejected by HttpRequestMessage.Headers, so try both buckets.
            if (!message.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()))
            {
                message.Content?.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }
        }

        return message;
    }

    public static async Task WriteToAsync(this HttpResponseMessage source, HttpResponse destination, CancellationToken cancellationToken = default)
    {
        destination.StatusCode = (int)source.StatusCode;

        foreach (var header in source.Headers)
        {
            destination.Headers[header.Key] = header.Value.ToArray();
        }

        if (source.Content is not null)
        {
            var body = await source.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (body.Length > 0)
            {
                destination.ContentType = source.Content.Headers.ContentType?.ToString() ?? "application/json";
                await destination.WriteAsync(body, cancellationToken).ConfigureAwait(false);
            }
        }
    }
}
