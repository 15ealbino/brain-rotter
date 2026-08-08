using BrainRotter.TeamsBot.Bot;
using BrainRotter.TeamsBot.Configuration;
using BrainRotter.TeamsBot.Sinks;
using Microsoft.Extensions.Options;
using Microsoft.Graph.Communications.Common.Telemetry;

var builder = WebApplication.CreateBuilder(args);

// Secrets come from user-secrets in development and environment variables everywhere else
// (Bot__AppSecret, Bot__AppId, ...). appsettings.json holds structure and placeholders only.
builder.Configuration.AddEnvironmentVariables();
if (builder.Environment.IsDevelopment())
{
    builder.Configuration.AddUserSecrets<Program>(optional: true);
}

builder.Services.Configure<BotOptions>(builder.Configuration.GetSection(BotOptions.SectionName));
builder.Services.Configure<BrainRotterOptions>(builder.Configuration.GetSection(BrainRotterOptions.SectionName));

builder.Services.AddHttpClient();
builder.Services.AddControllers();

// The SDK logs through its own IGraphLogger; mirroring it into ILogger keeps one log stream.
builder.Services.AddSingleton<IGraphLogger>(_ => new GraphLogger(nameof(TeamsRecordingBot), redirectToTrace: true));

builder.Services.AddSingleton<StorageRootResolver>();
builder.Services.AddSingleton<RecordingIndexWriter>();
builder.Services.AddSingleton<IRecordingSink, BrainRotterSink>();
builder.Services.AddSingleton<MeetingChatAnnouncer>();
builder.Services.AddSingleton<TeamsRecordingBot>();

var app = builder.Build();

// Fail loudly and specifically at startup rather than with a null reference on the first join.
var options = app.Services.GetRequiredService<IOptions<BotOptions>>().Value;
var problems = options.Validate();
if (problems.Count > 0)
{
    var log = app.Services.GetRequiredService<ILogger<Program>>();
    foreach (var problem in problems)
    {
        log.LogCritical("Configuration problem: {Problem}", problem);
    }

    log.LogCritical("See teams-bot/README.md > Configuration, and teams-bot/.env.example.");
    return 1;
}

app.MapControllers();

// Construct the bot eagerly so media-platform failures surface at startup, not mid-meeting.
var bot = app.Services.GetRequiredService<TeamsRecordingBot>();
var startupLog = app.Services.GetRequiredService<ILogger<Program>>();
var sink = app.Services.GetRequiredService<IRecordingSink>();

startupLog.LogInformation(
    "Brain Rotter Teams recorder starting. Notification URL {Url}. Sink '{Sink}'. Media platform {Media}.",
    new Uri(options.BotBaseUri, "/api/calls"),
    sink.Name,
    bot.CanJoin ? "ready" : "UNAVAILABLE (join disabled)");

if (sink is BrainRotterSink brainRotterSink)
{
    startupLog.LogInformation("Recordings will be written to {Root}.", brainRotterSink.StorageRoot);
}

// Leave every meeting cleanly and finalize every open recording when the host stops.
app.Lifetime.ApplicationStopping.Register(() => bot.DisposeAsync().AsTask().GetAwaiter().GetResult());

app.Run();
return 0;

/// <summary>Marker type so <c>AddUserSecrets&lt;Program&gt;</c> has something to bind to.</summary>
public partial class Program;
