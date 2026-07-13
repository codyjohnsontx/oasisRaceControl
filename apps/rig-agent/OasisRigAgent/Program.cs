using OasisRigAgent.Core;

// Oasis Race Control — Rig Agent (skeleton console host).
//
// Runs the agent against the backend: heartbeat, current-driver display,
// durable lap queue. Lap DETECTION is stubbed behind ITelemetrySource until the
// Phase 1 iRacing spike lands — run with SimulateTelemetry to exercise the full
// path today. The tray/window UI is a later pass that wraps this same Core.

// Startup failures (bad config, unwritable outbox db, invalid backend URL, …)
// all get the same friendly message instead of a raw stack trace.
var configPath = Path.Combine(AppContext.BaseDirectory, "agent.config.json");
AgentConfig config;
EventQueue queueInit;
HttpClient httpInit;
AgentService agentInit;
try
{
    config = AgentConfig.Load(configPath);
    config.Validate();

    queueInit = new EventQueue(Path.Combine(AppContext.BaseDirectory, "outbox.db"));
    httpInit = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    var client = new BackendClient(httpInit, config.BackendBaseUrl, config.RigToken);
    ITelemetrySource telemetry = config.SimulateTelemetry
        ? new SimulatedTelemetrySource(TimeSpan.FromSeconds(8))
        : new NullTelemetrySource();
    agentInit = new AgentService(config, client, queueInit, telemetry);
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Configuration error: {ex.Message}");
    Console.Error.WriteLine($"Create {configPath} (see agent.config.sample.json) or set OASIS_* env vars.");
    return 1;
}

using var queue = queueInit;
using var http = httpInit;
await using var agent = agentInit;

agent.StatusChanged += Render;
agent.Start();

Console.WriteLine($"Oasis Rig Agent — Rig {config.RigNumber:D2}  ({config.BackendBaseUrl})");
Console.WriteLine(config.SimulateTelemetry
    ? "Telemetry: SIMULATED (emitting fake laps)"
    : "Telemetry: none (real iRacing source lands after the spike)");
Console.WriteLine("Commands:  s = switch driver / sign out   q = quit");
Console.WriteLine(new string('-', 60));

using var quit = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; quit.Cancel(); };

_ = Task.Run(async () =>
{
    while (!quit.IsCancellationRequested)
    {
        var line = Console.ReadLine();
        if (line is null) { await Task.Delay(200); continue; }
        switch (line.Trim().ToLowerInvariant())
        {
            case "q":
                quit.Cancel();
                break;
            case "s":
                Console.WriteLine("→ switching driver…");
                var ended = await agent.SwitchDriverAsync();
                Console.WriteLine(ended ? "→ session ended." : "→ no active session.");
                break;
        }
    }
});

try { await Task.Delay(Timeout.Infinite, quit.Token); }
catch (OperationCanceledException) { }

Console.WriteLine("Shutting down…");
return 0;

static void Render(AgentStatus s)
{
    var conn = s.Connection switch
    {
        ConnectionState.Online => "● online",
        ConnectionState.Offline => "○ offline",
        _ => "◌ connecting",
    };
    var driver = s.Assignment is { } a ? a.DriverDisplayName : "— available —";
    var sim = s.SimRunning ? "sim running" : "sim idle";
    var pending = s.PendingLaps > 0 ? $"  |  {s.PendingLaps} lap(s) queued" : "";
    Console.WriteLine($"[Rig {s.RigNumber:D2}]  {conn}  |  driver: {driver}  |  {sim}{pending}");
}
