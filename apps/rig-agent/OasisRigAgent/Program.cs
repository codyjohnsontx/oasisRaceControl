using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;

// Oasis Race Control — Rig Agent (console host).
//
// Runs the agent against the backend: heartbeat, current-driver display,
// durable lap queue, and live lap detection off the running simulator. Set
// SimulateTelemetry to emit fake laps instead, for exercising the backend from a
// machine with no sim. The tray/window UI is a later pass that wraps this Core.
//
// --version prints the build on this machine and exits 0.
// Exit codes: 0 shut down cleanly, 1 could not start (config or data folder),
// 2 another agent is already running on this machine, 10 this machine cannot keep
// a lap queue. --check-sim adds 3 (the sim
// is running but this rig cannot keep a lap from it), 4 (no sim to read),
// 5 (this agent cannot see the sim from where Windows is running it) and
// 6 (the sim is running and publishes telemetry this agent cannot decode).
// --check-backend adds 7 (the backend could not be reached) and 8 (the backend
// answered and will not accept this rig's token), and reuses 1 for a config it
// cannot read.

// Which build is on this machine, answered without starting anything. A fleet
// update is a walk round twenty-plus rigs with a USB stick, and this is the answer
// at the rig; /staff is the same answer for the whole room at once.
if (args.Any(a => a is "--version" or "/version"))
{
    Console.WriteLine(AgentVersionInfo.Current);
    return 0;
}

// "Will this computer score laps?", answered on the spot. Runs before the lock and
// before config, because the way it gets used is walking up to a rig that already
// has the agent running on it and wants an answer in ten seconds.
if (args.Any(a => a is "--check-sim" or "/check-sim"))
{
    if (!OperatingSystem.IsWindows())
    {
        Console.Error.WriteLine("Simulator telemetry check: reading iRacing needs Windows.");
        return SimCheck.SimNotFound;
    }

    // Printed whatever the verdict is. iRacing's telemetry is named per Windows
    // session, so where this ran is part of reading any answer it gives - and it is
    // the difference between "start iRacing" and "this agent is installed wrong".
    Console.WriteLine($"Windows session: {WindowsSimConnectionFactory.CurrentWindowsSession()}");
    var check = SimCheck.Run(new WindowsSimConnectionFactory(), TimeSpan.FromSeconds(15));
    Console.WriteLine(check.Message);
    return check.ExitCode;
}

// Where this machine keeps its files. Resolved before anything else, because
// every remaining startup step writes to it and the failure has to name it.
var paths = AgentPaths.ForApp();

// "Does this rig's identity work?", answered on the spot. A rig's token is typed
// by hand once per machine, and until this there was nothing that ever checked it:
// a mistyped one produces a machine that says "offline" all night, which reads as
// the venue's network rather than as this computer. Runs before the instance lock
// like --check-sim does, so it can be run on a rig with the agent already on it -
// which is the normal state, because the agent starts with Windows.
if (args.Any(a => a is "--check-backend" or "/check-backend"))
{
    AgentConfig checkConfig;
    try
    {
        checkConfig = AgentConfig.Load(paths.ConfigPath);
        checkConfig.Validate();
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Backend check: NOT CONFIGURED - {ex.Message}");
        Console.Error.WriteLine($"Expected {paths.ConfigPath} (see agent.config.sample.json).");
        return BackendCheck.NotConfigured;
    }

    using var checkHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    var checkClient = new BackendClient(checkHttp, checkConfig.BackendBaseUrl, checkConfig.RigToken);
    var backend = await BackendCheck.RunAsync(checkConfig, BackendCheck.ProbeWith(checkClient));
    Console.WriteLine(backend.Message);
    return backend.ExitCode;
}
try
{
    paths.EnsureWritable();
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Startup error: {ex.Message}");
    return 1;
}

// One agent per rig. Two copies would interleave writes to a single outbox and
// disagree with each other about who is checked in.
var instanceLock = SingleInstanceLock.TryAcquire(paths.LockPath);
if (instanceLock is null)
{
    var holder = SingleInstanceLock.DescribeHolder(paths.LockPath);
    Console.Error.WriteLine("The Oasis Rig Agent is already running on this computer"
        + (holder.Length > 0 ? $" ({holder})" : "") + ".");
    Console.Error.WriteLine("Close the running one first — two agents on one rig fight over the same lap queue.");
    return 2;
}

using var _lock = instanceLock;
using var fileLog = new RotatingFileLog(paths.LogDirectory);
using var log = new CompositeLog(new ConsoleLog(), fileLog);
IAgentLog logger = log;

// Startup failures (bad config, unwritable outbox db, invalid backend URL, …)
// all get the same friendly message instead of a raw stack trace.
AgentConfig config;
EventQueue queueInit;
HttpClient httpInit;
var serverClock = new ServerClock();
ITelemetrySource telemetry;
AgentService agentInit;
try
{
    config = AgentConfig.Load(paths.ConfigPath);
    config.Validate();

    queueInit = new EventQueue(paths.OutboxPath);
    // A queue this machine could not read was replaced rather than allowed to stop
    // the rig - said at Error because laps were lost with it, and because the disk
    // that damaged one queue is the reason to look at this computer.
    if (queueInit.Recovery is { } recovered)
        foreach (var line in Wrap(recovered.Describe())) logger.Error($"[outbox] {line}");
    // Every backend response is a reading of how far this machine's clock is from
    // the venue's. A rig that is minutes out has its laps refused or filed on the
    // wrong night, and nothing else in the system says so — see ServerClock.
    serverClock.Changed += c => logger.Warn(
        $"[clock] this computer's clock is {c.Describe()} - laps are being corrected, "
        + "but fix the machine's time (w32tm /resync) so its own logs read straight.");
    httpInit = new HttpClient(new ServerClockHandler(serverClock)) { Timeout = TimeSpan.FromSeconds(15) };
    var client = new BackendClient(httpInit, config.BackendBaseUrl, config.RigToken);
    // A dropped lap is the one failure a customer notices and nobody else does,
    // so the reason it was dropped is written down rather than swallowed.
    telemetry = config.SimulateTelemetry
        ? new SimulatedTelemetrySource(TimeSpan.FromSeconds(8))
        : TelemetrySources.CreateLive(
            config.RigNumber,
            onLapRejected: d => logger.Warn(
                $"[telemetry] lap {d.LapNumber?.ToString() ?? "?"} not counted: {d.Outcome}"
                + (d.Detail is null ? "" : $" ({d.Detail})")),
            onFaulted: ex => logger.Warn($"[telemetry] recovered from: {ex.Message}"),
            // Every attach says what the sim it found actually publishes. A pass is
            // one line of evidence in the log that this rig is reading the sim
            // correctly; a fail is the only warning before a night of missing laps.
            onChannelsChecked: report =>
            {
                if (report.CanScore)
                {
                    logger.Info("[telemetry] simulator channel check passed.");
                    foreach (var degraded in report.Degraded)
                        logger.Warn($"[telemetry] {degraded.Describe()}");
                    return;
                }

                logger.Error("[telemetry] THIS RIG WILL NOT SCORE — the simulator does not publish "
                    + "everything a lap's validity is judged on, and a lap that cannot be judged "
                    + "clean is not published.");
                foreach (var line in report.Describe().Split('\n')) logger.Error(line.TrimEnd());
            },
            // Windows can start this agent somewhere iRacing's telemetry has no
            // name - as a service, or as the wrong user. From there the sim looks
            // closed forever, so the reason is written down the moment it changes.
            onSimUnreachable: verdict => logger.Error(verdict is null
                ? "[telemetry] the simulator is reachable again."
                : $"[telemetry] THIS RIG WILL NOT SCORE — {verdict.Instruction}"),
            // The sim is there and this agent cannot make sense of what it publishes -
            // most usefully, because an iRacing update changed the telemetry layout,
            // which lands on every rig in the venue within a day of each other.
            onSimUndecodable: verdict => logger.Error(verdict is null
                ? "[telemetry] the simulator's telemetry is readable again."
                : $"[telemetry] THIS RIG WILL NOT SCORE — {verdict.Instruction}"));
    // Which computer this is. Sent on every heartbeat so the backend can tell two
    // rigs installed from the same copied folder apart - see InstallationIdentity.
    var installation = InstallationIdentity.ForMachine(paths, logger);
    logger.Info($"Installation: {installation.MachineName} ({installation.Id})");
    agentInit = new AgentService(config, client, queueInit, telemetry, logger, serverClock, installation);
}
// A rig that cannot keep a lap is not a configuration mistake, and telling
// somebody to fix agent.config.json sends them to the one file that is fine. The
// agent stops, because a lap it cannot queue is a lap it silently drops.
catch (OutboxUnusableException ex)
{
    logger.Error($"Lap queue error: {ex.Message}");
    logger.Error("Until this machine can keep a lap queue, every lap driven on it is lost the "
        + "moment the network hiccups, so the agent will not start.");
    return 10;
}
catch (Exception ex)
{
    logger.Error($"Configuration error: {ex.Message}");
    logger.Error($"Create {paths.ConfigPath} (see agent.config.sample.json) or set OASIS_* env vars.");
    return 1;
}

using var queue = queueInit;
using var http = httpInit;
using var telemetryLifetime = telemetry as IDisposable;
await using var agent = agentInit;

agent.StatusChanged += Render;
agent.Start();

logger.Info($"Oasis Rig Agent {AgentVersionInfo.Current} — Rig {config.RigNumber:D2}  ({config.BackendBaseUrl})");
if (config.IgnoredConfigVersion is { } declaredVersion)
{
    // Ignored rather than obeyed, and said out loud rather than dropped: a config
    // that looks like it sets the version, on a dashboard showing another number,
    // is worse than either alone.
    logger.Warn($"[config] \"agentVersion\": \"{declaredVersion}\" in the config file is ignored - "
        + $"this rig reports the build it is running ({AgentVersionInfo.Current}). Remove the line.");
}
logger.Info(config.SimulateTelemetry
    ? "Telemetry: SIMULATED (emitting fake laps)"
    : telemetry is NullTelemetrySource
        ? "Telemetry: none (reading iRacing needs Windows)"
        : "Telemetry: iRacing (read-only; waiting for the sim)");
// Two candidate config locations means an operator can edit the one the agent
// is not reading, so which one it read is written down every start.
logger.Info($"Config:  {paths.ConfigPath}{(paths.ConfigIsBesideExecutable ? "  (beside the app)" : "")}");
logger.Info($"Data:    {paths.DataDirectory}");
logger.Info($"Log:     {fileLog.ActivePath}");
Console.WriteLine("Commands:  s = switch driver / sign out   q = quit");
Console.WriteLine(new string('-', 60));

using var quit = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; quit.Cancel(); };

_ = Task.Run(async () =>
{
    while (!quit.IsCancellationRequested)
    {
        // Started by Task Scheduler or a service wrapper there is no console to
        // read from, so ReadLine returns null immediately and forever. Backing
        // off keeps an unattended rig from waking this loop several times a
        // second for the rest of the day next to a running simulator.
        var line = Console.ReadLine();
        if (line is null) { await Task.Delay(1000); continue; }
        switch (line.Trim().ToLowerInvariant())
        {
            case "q":
                quit.Cancel();
                break;
            case "s":
                Console.WriteLine("→ switching driver…");
                var ended = await agent.SwitchDriverAsync();
                logger.Info(ended ? "→ session ended." : "→ no active session.");
                break;
        }
    }
});

try { await Task.Delay(Timeout.Infinite, quit.Token); }
catch (OperationCanceledException) { }

logger.Info("Shutting down…");
return 0;

// A paragraph on one console line is a paragraph nobody reads, and the rotating log
// is the file a rig gets diagnosed from.
static IEnumerable<string> Wrap(string text, int width = 96)
{
    var line = new System.Text.StringBuilder();
    foreach (var word in text.Split(' ', StringSplitOptions.RemoveEmptyEntries))
    {
        if (line.Length > 0 && line.Length + 1 + word.Length > width)
        {
            yield return line.ToString();
            line.Clear();
        }
        if (line.Length > 0) line.Append(' ');
        line.Append(word);
    }
    if (line.Length > 0) yield return line.ToString();
}

void Render(AgentStatus s)
{
    // "Offline" is the right word for a rig whose network dropped and the wrong
    // one for a rig the backend refused: that machine's connection is fine, the
    // refusal is permanent, and it is the only place in the system that can say
    // so - a rig that cannot authenticate never reaches /staff at all.
    var conn = s.BackendRefusal is not null ? "⛔ TOKEN REFUSED" : s.Connection switch
    {
        ConnectionState.Online => "● online",
        ConnectionState.Offline => "○ offline",
        _ => "◌ connecting",
    };
    var driver = s.Assignment is { } a ? a.DriverDisplayName : "— available —";
    // The same two words /staff puts on the rig's card, so the machine and the
    // dashboard do not describe one situation differently. Which of the reasons it
    // is - a channel the sim does not publish, or a sim this agent cannot see from
    // where Windows started it - is the sentence at the end of the line.
    var sim = s.SimUnusableReason is not null ? "⚠ NOT SCORING" : s.SimRunning ? "sim running" : "sim idle";
    var pending = s.PendingLaps > 0 ? $"  |  {s.PendingLaps} lap(s) queued" : "";
    var rejected = s.QuarantinedLaps > 0 ? $"  |  ⚠ {s.QuarantinedLaps} lap(s) rejected" : "";
    var unreadable = s.SimUnusableReason is { } why ? $"  |  {why}" : "";
    var refused = s.BackendRefusal is { } refusal ? $"  |  {refusal}" : "";
    // Laps are corrected for it, so this is not "laps are being lost" - it is
    // "this machine's time is wrong", which is a thing only the rig can say.
    var clock = serverClock.Describe() is { } off ? $"  |  ⚠ CLOCK {off}" : "";
    // Queued laps alone would read as an outage. This is the one reason for them
    // that no amount of waiting fixes, so it says so rather than looking patient.
    var shared = s.RigTokenShared ? "  |  ⚠ TOKEN SHARED WITH ANOTHER PC" : "";
    // The one failure on this screen that looks like nothing at all when it is not
    // said: the machine works, the backend answers, and every lap driven here is
    // going to another rig's customer.
    var wrongRig = s.WrongRig is { } mixup ? $"  |  ⛔ {mixup}" : "";
    // The one line on this screen a customer is meant to act on, so it says what to
    // do rather than what is about to happen to them.
    var signOut = s.IdleSignOutIn is { } left
        ? $"  |  ⚠ STILL DRIVING? SIGNING OUT IN {Math.Max(1, (int)Math.Round(left.TotalSeconds))}s — START iRACING TO STAY CHECKED IN"
        : "";
    logger.Info($"[Rig {s.RigNumber:D2}]  {conn}  |  driver: {driver}  |  {sim}{pending}{rejected}{wrongRig}{shared}{signOut}{clock}{refused}{unreadable}");
}
