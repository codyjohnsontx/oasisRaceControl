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
                Console.WriteLine(await agent.SwitchDriverAsync() switch
                {
                    SwitchDriverResult.Ended => "→ session ended.",
                    SwitchDriverResult.NoActiveSession => "→ no active session.",
                    // The seat is empty here, but nothing was queued and nothing
                    // will be sent later, so this is the one case staff have to
                    // finish by hand.
                    SwitchDriverResult.EndedNotQueued =>
                        "→ session ended here. Backend offline and the server cannot be told - "
                        + "if someone was checked in on this rig, clear it from the staff screen.",
                    // The seat IS empty; only the backend has yet to hear it.
                    // Say so, because until it does, laps on this rig arrive
                    // unclaimed and staff will see them on the dashboard.
                    SwitchDriverResult.EndedPendingSync =>
                        "→ session ended here. Backend offline - it will be told when the connection returns.",
                    // Every result is named above, so this is only reachable
                    // once a new one is added. It says the one thing true of
                    // all of them - the seat is empty here - rather than
                    // inheriting another arm's promise about what the backend
                    // has been told.
                    _ => "→ session ended here.",
                });
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
    // A null assignment the agent has never been able to ask about is not an
    // available rig, and saying so would be a guess in the display too.
    var driver = s.Assignment is { } a
        ? a.DriverDisplayName
        : s.AssignmentKnown ? "— available —" : "(checking)";
    var sim = s.SimRunning ? "sim running" : "sim idle";
    var pending = s.PendingLaps > 0 ? $"  |  {s.PendingLaps} lap(s) queued" : "";
    var checkout = s.CheckoutPending ? "  |  sign-out queued" : "";
    Console.WriteLine($"[Rig {s.RigNumber:D2}]  {conn}  |  driver: {driver}  |  {sim}{pending}{checkout}");
}
