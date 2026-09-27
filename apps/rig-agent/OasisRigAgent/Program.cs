using OasisRigAgent.Core;
using OasisRigAgent.Core.Iracing;

// Oasis Race Control — Rig Agent (console host).
//
// Runs the agent against the backend: heartbeat, current-driver display,
// durable lap queue, and - with "telemetry": "iracing" - laps read from the
// sim's shared memory on this PC. The tray/window UI is a later pass that
// wraps this same Core.
//
//   OasisRigAgent.exe              run the agent (needs agent.config.json)
//   OasisRigAgent.exe --diagnose   read iRacing and print what it sees; posts nothing

if (args.Any(a => a is "--diagnose" or "diagnose" or "--diag" or "diag"))
    return Diagnose();

// Startup failures (bad config, unwritable outbox db, invalid backend URL, …)
// all get the same friendly message instead of a raw stack trace.
var configPath = Path.Combine(AppContext.BaseDirectory, "agent.config.json");
AgentConfig config;
EventQueue queueInit;
HttpClient httpInit;
AgentService agentInit;
ITelemetrySource telemetry;
try
{
    config = AgentConfig.Load(configPath);
    config.Validate();

    queueInit = new EventQueue(Path.Combine(AppContext.BaseDirectory, "outbox.db"));
    httpInit = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    var client = new BackendClient(httpInit, config.BackendBaseUrl, config.RigToken);
    telemetry = config.TelemetryMode switch
    {
        TelemetryMode.Iracing => AttachTelemetryLog(new IracingTelemetrySource()),
        TelemetryMode.Simulated => new SimulatedTelemetrySource(TimeSpan.FromSeconds(8)),
        _ => new NullTelemetrySource(),
    };
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
Console.WriteLine(config.TelemetryMode switch
{
    TelemetryMode.Iracing => "Telemetry: iRacing shared memory (laps post automatically; each one is logged below with the exact strings sent)",
    TelemetryMode.Simulated => "Telemetry: SIMULATED (emitting fake laps)",
    _ => "Telemetry: none (heartbeat and driver display only)",
});
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
                    // The seat is empty here, but nothing durable was recorded,
                    // so this is the one case staff have to finish by hand -
                    // either there was no stint to name, or the outbox write
                    // failed and a restart would lose the retry.
                    SwitchDriverResult.EndedNotQueued =>
                        "→ session ended here. Backend offline and the server may never be told - "
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
    // Separate from the queued count on purpose: these are not waiting for the
    // link to come back, they are waiting for a person. Counting them as queued
    // is what the rig did while one of them was blocking the whole outbox.
    var rejected = s.RejectedLaps > 0
        ? $"  |  {s.RejectedLaps} lap(s) the backend rejected - kept, not sent"
        : "";
    // The press prints its one-shot line once and scrolls away; this is the
    // line staff still have in front of them an hour later, so it has to say
    // the same thing - including naming the one case they have to finish by
    // hand rather than reporting it as handled.
    var checkout = s.Checkout switch
    {
        CheckoutDelivery.Queued => "  |  sign-out queued",
        CheckoutDelivery.NotQueued => "  |  sign-out NOT saved - clear this rig from the staff screen",
        _ => "",
    };
    Console.WriteLine($"[Rig {s.RigNumber:D2}]  {conn}  |  driver: {driver}  |  {sim}{pending}{rejected}{checkout}");
}

/// <summary>What the normal run prints about the sim, on top of the status
/// line: connection changes, the combo strings exactly as they will be posted,
/// and every lap boundary with its verdict. The featured combo on the backend
/// matches these strings exactly, so they are printed verbatim and quoted.</summary>
static IracingTelemetrySource AttachTelemetryLog(IracingTelemetrySource source)
{
    source.ConnectionChanged += up => Log(up ? "iRacing connected" : "iRacing not running (waiting; laps resume when it is back)");
    source.ComboChanged += combo => Log(combo is null
        ? "session info does not name a track and car yet"
        : $"session: {Describe(combo)}");
    source.MissingVariables += names => Log($"WARNING this iRacing build does not publish: {string.Join(", ", names)} - laps may not be detected");
    source.LapDecided += d => Log(d.Lap is { } lap
        ? $"lap {d.LapCompleted} {FormatLap(lap.LapTimeMs)} incidents={(lap.IncidentDelta?.ToString() ?? "n/a")} queued as track=\"{lap.TrackName}\" config=\"{lap.TrackConfig}\" car=\"{lap.CarName}\""
        : $"lap {d.LapCompleted} skipped: {d.SkipReason}");
    source.Faulted += ex => Log($"ERROR telemetry stopped: {ex.Message} - restart the agent");
    return source;

    static void Log(string message) => Console.WriteLine($"[telemetry {DateTime.Now:HH:mm:ss}] {message}");
}

/// <summary>Read-only check for a rig PC: is iRacing seen, what does it call the
/// track, layout and car, and does each lap come through. Posts nothing, needs no
/// config, writes no outbox. This is the first thing to run on a real rig.</summary>
static int Diagnose()
{
    Console.WriteLine("Oasis Rig Agent — iRacing DIAGNOSTIC (reads only; nothing is posted or saved)");
    Console.WriteLine("Start iRacing, join a session and get in the car. Drive laps. Press Enter to stop.");
    Console.WriteLine(new string('-', 72));

    if (!OperatingSystem.IsWindows())
    {
        Console.WriteLine("This has to run on the Windows rig PC that runs iRacing.");
        return 3;
    }

    using var source = new IracingTelemetrySource();
    var laps = 0;
    source.ConnectionChanged += up => Console.WriteLine(up
        ? $"[{Now()}] iRacing CONNECTED"
        : $"[{Now()}] iRacing NOT RUNNING or not in a session - waiting (start the sim or load a session)");
    source.ComboChanged += combo =>
    {
        if (combo is null)
        {
            Console.WriteLine($"[{Now()}] session info read but it does not name a track and car yet (still loading?)");
            return;
        }
        Console.WriteLine($"[{Now()}] SESSION {Describe(combo)}");
        Console.WriteLine($"           iRacing ids: TrackName=\"{combo.TrackName}\" TrackID={combo.TrackId} CarID={combo.CarId} PlayerCarIdx={combo.PlayerCarIdx}");
        Console.WriteLine("           featured-combo SQL for the wall (copy exactly):");
        Console.WriteLine($"           insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)");
        Console.WriteLine($"           values (venue_today(), {Sql(combo.TrackDisplayName)}, {Sql(combo.TrackConfigName)}, {Sql(combo.CarScreenName)}, 0)");
        Console.WriteLine("           on conflict (combo_date) do update set track_name = excluded.track_name, track_config = excluded.track_config, car_name = excluded.car_name, incident_limit = excluded.incident_limit;");
    };
    source.MissingVariables += names =>
        Console.WriteLine($"[{Now()}] WARNING this iRacing build does not publish: {string.Join(", ", names)}");
    source.LapDecided += d =>
    {
        if (d.Lap is { } lap)
        {
            laps++;
            Console.WriteLine($"[{Now()}] LAP {d.LapCompleted}  {FormatLap(lap.LapTimeMs)}  incidents={(lap.IncidentDelta?.ToString() ?? "n/a")}  -> would POST"
                + $"  track=\"{lap.TrackName}\" config=\"{lap.TrackConfig}\" car=\"{lap.CarName}\""
                + (lap.IncidentDelta > 0 ? "  (backend stores it but marks it invalid: incidents over the limit)" : ""));
        }
        else
        {
            Console.WriteLine($"[{Now()}] LAP {d.LapCompleted}  -> would NOT post: {d.SkipReason}");
        }
    };
    source.Faulted += ex => Console.WriteLine($"[{Now()}] ERROR telemetry stopped: {ex.GetType().Name}: {ex.Message}");

    source.Start();
    Console.WriteLine($"[{Now()}] looking for iRacing shared memory…");
    Console.ReadLine();
    source.Stop();
    Console.WriteLine($"stopped. {laps} lap(s) would have been posted.");
    return 0;

    static string Now() => DateTime.Now.ToString("HH:mm:ss");
    static string Sql(string? s) => s is null ? "null" : $"'{s.Replace("'", "''")}'";
}

static string Describe(SessionCombo c)
    => $"track=\"{c.TrackDisplayName}\" config=\"{c.TrackConfigName}\" car=\"{c.CarScreenName}\"";

static string FormatLap(int ms)
    => $"{ms / 60_000}:{ms % 60_000 / 1000:00}.{ms % 1000:000}";
