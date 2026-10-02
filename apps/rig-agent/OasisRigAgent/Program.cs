using System.Runtime.InteropServices;
using OasisRigAgent;
using OasisRigAgent.Core;
using OasisRigAgent.Core.Iracing;
using OasisRigAgent.Core.WalkUp;
#if WINDOWS
using OasisRigAgent.Windows;
#endif

// Oasis Race Control - Rig Agent.
//
// Runs the agent against the backend: heartbeat, current-driver display,
// durable lap queue, and - with "telemetry": "iracing" - laps read from the
// sim's shared memory on this PC. The same Core drives two fronts:
//
//   OasisRigAgent.exe              run the agent (needs agent.config.json). With
//                                  rigQrToken set, the Windows build opens the
//                                  walk-up sign-in window; without it, the
//                                  staff console (s/q).
//   OasisRigAgent.exe --console    walk-up mode in a console window instead of
//                                  the sign-in window (the event-night fallback)
//   OasisRigAgent.exe --diagnose   read iRacing and print what it sees; posts nothing
//
// The net8.0 build (macOS, Linux, the tests) is console-only and treats
// --console as given.

if (args.Contains("--diagnose"))
{
#if WINDOWS
    ConsoleWindow.Open();
#endif
    return Diagnose();
}

// iRacing comes first on this PC: the agent runs below normal priority, so the
// scheduler gives the sim the CPU whenever both want it. The agent waits on the
// network and the sim almost all the time, and the lap detector already
// tolerates a late telemetry tick.
var priority = LowerPriority();

// Startup failures (bad config, unwritable outbox db, invalid backend URL, ...)
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
        TelemetryMode.Iracing => config.RigQrToken is null
            ? AttachTelemetryLog(new IracingTelemetrySource())
            : new IracingTelemetrySource(),
        TelemetryMode.Simulated => new SimulatedTelemetrySource(TimeSpan.FromSeconds(8)),
        _ => new NullTelemetrySource(),
    };
    agentInit = new AgentService(config, client, queueInit, telemetry);
}
catch (Exception ex)
{
    var problem = $"Configuration error: {ex.Message}\nCreate {configPath} (see agent.config.sample.json) or set OASIS_* env vars.";
#if WINDOWS
    // Started from a terminal, the error goes there; double-clicked, there is
    // no console to print to.
    if (!ConsoleWindow.AttachToParent())
    {
        MessageBox.Show(problem, "Oasis Rig Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
#endif
    Console.Error.WriteLine(problem);
    return 1;
}

using var queue = queueInit;
using var http = httpInit;
await using var agent = agentInit;

// The walk-up window is the Windows build's front for a rig with a QR token;
// --console keeps the console screens of the event nights as the fallback.
var window = false;
#if WINDOWS
window = config.RigQrToken is not null && !args.Contains("--console");
if (!window) ConsoleWindow.Open();
#endif

// Walk-up mode's screen exists before the agent starts, so nothing the sim or
// the agent reports in the first moments is printed where a redraw erases it.
WalkUpScreen? walkUp = null;
WalkUpViewModel? model = null;
DriverCheckInClient? checkInClient = null;
if (config.RigQrToken is { } qrToken)
{
    // Every sign-in the backend turns away is counted for the heartbeat, by
    // the answers it gives; a fresh cookie jar per check-in, as the client's
    // own default, so one person's session never leaks into the next.
    checkInClient = new DriverCheckInClient(config.BackendBaseUrl, qrToken, () => new SignInFailureWatch(
        agent.RecordSignInFailure,
        new HttpClientHandler { UseCookies = true, CookieContainer = new System.Net.CookieContainer() }));
}
if (config.RigQrToken is null)
{
    agent.StatusChanged += s => Console.WriteLine(StatusLine(s));
    agent.Notice += Console.Error.WriteLine;
}
else if (window)
{
    var m = new WalkUpViewModel(agent, checkInClient!, config.RigNumber);
    model = m;
    if (telemetry is IracingTelemetrySource iracing) AttachDriverLog(iracing, m.Log, m.Standing);
    agent.StatusChanged += OnlyWhenItMatters(s => m.Log(StatusLine(s)));
}
else
{
    var screen = new WalkUpScreen(new SystemPromptConsole(), agent);
    walkUp = screen;
    if (telemetry is IracingTelemetrySource iracing) AttachDriverLog(iracing, screen.Log, screen.Standing);
    agent.StatusChanged += OnlyWhenItMatters(s => screen.Log(StatusLine(s)));
    agent.Notice += screen.Log;
}
agent.Start();

#if WINDOWS
if (model is { } vm)
{
    using var walkUpModel = vm;
    return RunWindow(vm, agent, priority);
}
#endif

Console.WriteLine($"Oasis Rig Agent - Rig {config.RigNumber:D2}  ({config.BackendBaseUrl})");
Console.WriteLine(config.TelemetryMode switch
{
    TelemetryMode.Iracing => "Telemetry: iRacing shared memory (laps post automatically; each one is logged below with the exact strings sent)",
    TelemetryMode.Simulated => "Telemetry: SIMULATED (emitting fake laps)",
    _ => "Telemetry: none (heartbeat and driver display only)",
});
Console.WriteLine(priority);
var quit = new CancellationTokenSource();

// Every way out - input ending (walk-up), q (staff console), Ctrl+C, the
// window's close button (SIGHUP; CTRL_CLOSE_EVENT on Windows), a shutdown
// (SIGTERM; CTRL_SHUTDOWN_EVENT) and the runtime's own exit - runs the same
// exit work once: the goodbye heartbeat, so the monitor reads a rig that was
// closed differently from one that lost power, and in walk-up mode the seated
// driver's sign-out beside it. The signal handlers wait for it, because
// Windows ends the process as soon as a close handler returns. Both are bounded
// to three seconds, so a backend that does not answer cannot hold the window
// open.
var exitWork = new Lazy<Task>(() => Task.WhenAll(
    walkUp is null ? Task.CompletedTask : DriverPrompt.SignOutOnExitAsync(agent),
    agent.SendGoodbyeAsync(TimeSpan.FromSeconds(3))));
void FinishBeforeExit()
{
    quit.Cancel();
    exitWork.Value.GetAwaiter().GetResult();
}
Console.CancelKeyPress += (_, e) => { e.Cancel = true; quit.Cancel(); };
using var onClose = PosixSignalRegistration.Create(PosixSignal.SIGHUP, context => { context.Cancel = true; FinishBeforeExit(); });
using var onShutdown = PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => { context.Cancel = true; FinishBeforeExit(); });
AppDomain.CurrentDomain.ProcessExit += (_, _) => FinishBeforeExit();

if (walkUp is not null && checkInClient is { } checkIn)
{
    // Walk-up mode: the rig itself is the check-in.
    Console.WriteLine("Walk-up mode: type your name and a 4-digit PIN to start driving, press Enter to log out.");
    Console.WriteLine(new string('-', 60));
    await DriverPrompt.RunAsync(agent, checkIn, config.RigNumber, walkUp, quit.Token);
    await exitWork.Value;
    Console.WriteLine("Shutting down...");
    return 0;
}

Console.WriteLine("Commands:  s = switch driver / sign out   q = quit");
Console.WriteLine(new string('-', 60));

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
                Console.WriteLine("-> switching driver...");
                Console.WriteLine(await agent.SwitchDriverAsync() switch
                {
                    SwitchDriverResult.Ended => "-> session ended.",
                    SwitchDriverResult.NoActiveSession => "-> no active session.",
                    // The seat is empty here, but nothing durable was recorded,
                    // so this is the one case staff have to finish by hand -
                    // either there was no stint to name, or the outbox write
                    // failed and a restart would lose the retry.
                    SwitchDriverResult.EndedNotQueued =>
                        "-> session ended here. Backend offline and the server may never be told - "
                        + "if someone was checked in on this rig, clear it from the staff screen.",
                    // The seat IS empty; only the backend has yet to hear it.
                    // Say so, because until it does, laps on this rig arrive
                    // unclaimed and staff will see them on the dashboard.
                    SwitchDriverResult.EndedPendingSync =>
                        "-> session ended here. Backend offline - it will be told when the connection returns.",
                    // Every result is named above, so this is only reachable
                    // once a new one is added. It says the one thing true of
                    // all of them - the seat is empty here - rather than
                    // inheriting another arm's promise about what the backend
                    // has been told.
                    _ => "-> session ended here.",
                });
                break;
        }
    }
});

try { await Task.Delay(Timeout.Infinite, quit.Token); }
catch (OperationCanceledException) { }

await exitWork.Value;
Console.WriteLine("Shutting down...");
return 0;

/// <summary>Drop this process to below-normal priority, and say what came of
/// it for the start-up banner. A rig where Windows refuses it still runs the
/// agent - just without the head start for the sim.</summary>
static string LowerPriority()
{
    try
    {
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        self.PriorityClass = System.Diagnostics.ProcessPriorityClass.BelowNormal;
        return "Priority: below normal (iRacing comes first)";
    }
    catch (Exception ex)
    {
        return $"Priority: unchanged - could not lower it ({ex.Message})";
    }
}

static string StatusLine(AgentStatus s)
{
    var conn = s.Connection switch
    {
        ConnectionState.Online => "online",
        ConnectionState.Offline => "OFFLINE",
        _ => "connecting",
    };
    // A null assignment the agent has never been able to ask about is not an
    // available rig, and saying so would be a guess in the display too.
    var driver = s.Assignment is { } a
        ? a.DriverDisplayName
        : s.AssignmentKnown ? "- available -" : "(checking)";
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
    return $"[Rig {s.RigNumber:D2}]  {conn}  |  driver: {driver}  |  {sim}{pending}{rejected}{checkout}";
}

/// <summary>Walk-up mode's status line: printed when something the person at
/// the rig or staff would act on changes - the connection, whether the sim is
/// running, laps waiting while offline, laps the backend refused, a sign-out
/// still owed - rather than on every poll.</summary>
static Action<AgentStatus> OnlyWhenItMatters(Action<AgentStatus> render)
{
    object? last = null;
    var gate = new object();
    return s =>
    {
        object key = (s.Connection, s.SimRunning,
            s.Connection == ConnectionState.Online ? 0 : s.PendingLaps, s.RejectedLaps, s.Checkout);
        lock (gate)
        {
            if (Equals(key, last)) return;
            last = key;
        }
        render(s);
    };
}

/// <summary>What walk-up mode prints about the sim on the screen: a lap that
/// was not timed and why, and the problems a driver can see and report -
/// iRacing not running, lap reading stopped. The two that last until a restart
/// stand under the banner of every screen. A timed lap is the prompt's to
/// print, because only it knows whether the lap was queued for a driver and
/// when the backend took it. The exact combo strings
/// are for staff and live in --diagnose and the staff console.</summary>
static void AttachDriverLog(IracingTelemetrySource source, Action<string> log, Action<string> standing)
{
    source.ConnectionChanged += up => log(up ? "iRacing connected." : "iRacing is not running or not in a session - laps resume when it is back.");
    source.MissingVariables += names => standing($"WARNING: this iRacing build does not publish: {string.Join(", ", names)} - laps may not be detected. Tell staff.");
    source.LapDecided += d =>
    {
        if (d.Lap is null) log($"Lap {d.LapCompleted} not counted: {d.SkipReason}");
    };
    source.Faulted += ex => standing($"ERROR: lap reading stopped: {ex.Message} - tell staff to restart the program.");
}

#if WINDOWS
/// <summary>The walk-up window, with every way out of it - the Log out button
/// is the model's, and the close button, Alt+F4, Task Manager's End task and a
/// Windows shutdown (FormClosing, raised at WM_QUERYENDSESSION while Windows
/// still waits for the answer) and the runtime's own exit all run the same
/// exit work once, as the console host's signal handlers do: the seated
/// driver's sign-out and the goodbye heartbeat, each bounded to three seconds,
/// so a backend that does not answer cannot hold the window open.
///
/// An ordinary close (the button, Alt+F4, End task) is refused the first time
/// and the window stays up showing "Signing out..." while the exit work runs;
/// the UI thread only awaits it, so the window keeps painting and a slow
/// backend never makes a normal close look hung, and it closes itself when
/// the work is done. A Windows shutdown is the one close that waits
/// synchronously: Windows owns that deadline and ends the process soon after
/// the handler returns, so the handler must not return before the sign-out is
/// recorded. The exit work starts on the thread pool, never on the UI thread,
/// so that synchronous wait cannot deadlock on a continuation posted back to
/// the thread it blocks.</summary>
static int RunWindow(WalkUpViewModel model, AgentService agent, string priority)
{
    model.Log(priority);
    var quit = new CancellationTokenSource();
    // The model's exit sign-out owns the sign-in that may be in flight: it
    // waits for it out of the same bound, seats and ends the stint it opened,
    // or records the one it may have opened. So quit is cancelled AFTER the
    // exit work, never before - cancelling first would abort that sign-in at
    // the moment its answer is the only thing that names the stint.
    var exitWork = new Lazy<Task>(() => Task.Run(() => Task.WhenAll(
        model.SignOutOnExitAsync(WalkUpRules.ExitLimit),
        agent.SendGoodbyeAsync(WalkUpRules.ExitLimit))));
    void FinishBeforeExit()
    {
        exitWork.Value.GetAwaiter().GetResult();
        quit.Cancel();
    }
    // The console-control routes still exist when --console gave the process a
    // console; a windowed process without one simply never hears them.
    using var onClose = PosixSignalRegistration.Create(PosixSignal.SIGHUP, context => { context.Cancel = true; FinishBeforeExit(); });
    using var onShutdown = PosixSignalRegistration.Create(PosixSignal.SIGTERM, context => { context.Cancel = true; FinishBeforeExit(); });
    AppDomain.CurrentDomain.ProcessExit += (_, _) => FinishBeforeExit();

    Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    // An exception in a UI handler is logged on the window, not raised as the
    // runtime's error dialog, which nobody at an unattended rig would answer.
    Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
    Application.ThreadException += (_, e) => model.Log($"[window] {e.Exception.GetType().Name}: {e.Exception.Message}");

    using var form = new WalkUpForm(model);
    form.FormClosing += async (_, e) =>
    {
        // The exit work is done (an earlier close, a signal, or the quit
        // below): let this close through.
        if (exitWork.IsValueCreated && exitWork.Value.IsCompleted) return;
        if (e.CloseReason == CloseReason.WindowsShutDown)
        {
            FinishBeforeExit();
            return;
        }
        e.Cancel = true;
        // Already signing out from an earlier close: this one changes nothing.
        if (exitWork.IsValueCreated) return;
        try { await exitWork.Value; }
        catch (Exception) { /* bounded inside; nothing more to do on the way out */ }
        quit.Cancel();
    };
    // Whatever ran the exit work - a close above, a signal handler - the window
    // closes once it is done, and never before: FormClosing lets it through
    // only then.
    using var closeOnQuit = quit.Token.Register(() =>
    {
        if (!form.IsDisposed && form.IsHandleCreated)
        {
            try { form.BeginInvoke(form.Close); }
            catch (InvalidOperationException) { }
        }
    });
    _ = model.StartAsync(quit.Token);
    Application.Run(form);
    exitWork.Value.GetAwaiter().GetResult();
    return 0;
}
#endif

/// <summary>What the normal run prints about the sim, on top of the status
/// line: connection changes, the combo strings exactly as they will be posted,
/// and every lap boundary with its verdict. The featured combo on the backend
/// matches these strings exactly, so they are printed verbatim and quoted.</summary>
static IracingTelemetrySource AttachTelemetryLog(IracingTelemetrySource source)
{
    source.ConnectionChanged += up => Log(up ? "iRacing connected" : "iRacing not running or not in a session (waiting; laps resume when it is back)");
    source.Attached += header => Log($"iRacing header: {header}");
    source.HeaderRejected += (header, reason) => Log($"iRacing shared memory not ready: {reason} (header: {header?.ToString() ?? "unreadable"}) - retrying every second");
    source.ComboChanged += combo => Log($"session: {Describe(combo)}");
    source.SessionInfoIncomplete += found => Log($"session info does not name a track and car yet (found: {found})");
    source.MissingVariables += names => Log($"WARNING this iRacing build does not publish: {string.Join(", ", names)} - laps may not be detected");
    source.LapDecided += d => Log(d.Lap is { } lap
        ? $"lap {d.LapCompleted} {LapTime.Format(lap.LapTimeMs)} incidents={(lap.IncidentDelta?.ToString() ?? "n/a")} queued as track=\"{lap.TrackName}\" config=\"{lap.TrackConfig}\" car=\"{lap.CarName}\""
        : $"lap {d.LapCompleted} skipped: {d.SkipReason}");
    source.LapCounterResynced += message => Log(message);
    source.Faulted += ex => Log($"ERROR telemetry stopped: {ex.Message} - restart the agent");
    return source;

    static void Log(string message) => Console.WriteLine($"[telemetry {DateTime.Now:HH:mm:ss}] {message}");
}

/// <summary>Read-only check for a rig PC: is iRacing seen, what does it call the
/// track, layout and car, and does each lap come through. Posts nothing, needs no
/// config, writes no outbox. This is the first thing to run on a real rig.</summary>
static int Diagnose()
{
    Console.WriteLine("Oasis Rig Agent - iRacing DIAGNOSTIC (reads only; nothing is posted or saved)");
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
    source.Attached += header =>
        Console.WriteLine($"[{Now()}] HEADER {header}");
    source.HeaderRejected += (header, reason) =>
    {
        Console.WriteLine($"[{Now()}] shared memory NOT READY: {reason}");
        Console.WriteLine($"           raw header: {header?.ToString() ?? "could not be read"}");
        Console.WriteLine("           (normal while a session loads - retrying every second; if it never clears, send these lines)");
    };
    source.ComboChanged += combo =>
    {
        Console.WriteLine($"[{Now()}] SESSION {Describe(combo)}");
        Console.WriteLine($"           iRacing ids: TrackName=\"{combo.TrackName}\" TrackID={combo.TrackId} CarID={combo.CarId} PlayerCarIdx={combo.PlayerCarIdx}");
        Console.WriteLine("           featured-combo SQL for the wall (copy exactly):");
        Console.WriteLine($"           insert into featured_combos (combo_date, track_name, track_config, car_name, incident_limit)");
        Console.WriteLine($"           values (venue_today(), {Sql(combo.TrackDisplayName)}, {Sql(combo.TrackConfigName)}, {Sql(combo.CarScreenName)}, 0)");
        Console.WriteLine("           on conflict (combo_date) do update set track_name = excluded.track_name, track_config = excluded.track_config, car_name = excluded.car_name, incident_limit = excluded.incident_limit;");
    };
    source.SessionInfoIncomplete += found =>
    {
        Console.WriteLine($"[{Now()}] session info read but it does not name a track and car yet (still loading?)");
        Console.WriteLine($"           found: {found}");
        Console.WriteLine("           (if SESSION never follows once you are in the car, send these lines)");
    };
    source.MissingVariables += names =>
        Console.WriteLine($"[{Now()}] WARNING this iRacing build does not publish: {string.Join(", ", names)}");
    source.LapDecided += d =>
    {
        if (d.Lap is { } lap)
        {
            laps++;
            Console.WriteLine($"[{Now()}] LAP {d.LapCompleted}  {LapTime.Format(lap.LapTimeMs)}  incidents={(lap.IncidentDelta?.ToString() ?? "n/a")}  -> would POST"
                + $"  track=\"{lap.TrackName}\" config=\"{lap.TrackConfig}\" car=\"{lap.CarName}\""
                + (lap.IncidentDelta > 0 ? "  (backend stores it but marks it invalid: incidents over the limit)" : ""));
        }
        else
        {
            Console.WriteLine($"[{Now()}] LAP {d.LapCompleted}  -> would NOT post: {d.SkipReason}");
        }
    };
    source.LapCounterResynced += message => Console.WriteLine($"[{Now()}]   ({message}; no lap)");
    source.Faulted += ex => Console.WriteLine($"[{Now()}] ERROR telemetry stopped: {ex.GetType().Name}: {ex.Message} - restart the program and send this line");

    source.Start();
    Console.WriteLine($"[{Now()}] looking for iRacing shared memory...");
    Console.ReadLine();
    source.Stop();
    Console.WriteLine($"stopped. {laps} lap(s) would have been posted.");
    return 0;

    static string Now() => DateTime.Now.ToString("HH:mm:ss");
    static string Sql(string? s) => s is null ? "null" : $"'{s.Replace("'", "''")}'";
}

static string Describe(SessionCombo c)
    => $"track=\"{c.TrackDisplayName}\" config=\"{c.TrackConfigName}\" car=\"{c.CarScreenName}\"";

