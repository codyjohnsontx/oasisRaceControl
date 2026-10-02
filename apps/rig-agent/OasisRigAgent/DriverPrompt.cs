using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;

namespace OasisRigAgent;

/// <summary>What the walk-up loop needs from a console: read a line (giving up
/// when the agent is quitting), write a line, and clear the screen.</summary>
internal interface IPromptConsole
{
    Task<string?> ReadLineAsync(CancellationToken quit);
    void WriteLine(string line = "");
    void Clear();
}

/// <summary>The rig PC's own console window.</summary>
internal sealed class SystemPromptConsole : IPromptConsole
{
    /// <summary>Console.ReadLine that gives up when the agent is quitting, so a
    /// Ctrl+C or window close does not leave the loop stuck on input.</summary>
    public async Task<string?> ReadLineAsync(CancellationToken quit)
    {
        var read = Task.Run(Console.ReadLine);
        var finished = await Task.WhenAny(read, Task.Delay(Timeout.Infinite, quit).ContinueWith(_ => (string?)null));
        return finished == read ? read.Result : null;
    }

    public void WriteLine(string line = "") => Console.WriteLine(line);

    /// <summary>A console whose output is piped (a test, a log file) has no
    /// screen to clear, and clearing it must not end the program.</summary>
    public void Clear()
    {
        if (Console.IsOutputRedirected) return;
        try { Console.Clear(); }
        catch (IOException) { }
    }
}

/// <summary>
/// The walk-up loop on the rig PC, as two screens. SIGN IN asks for a name,
/// looks it up, and then asks a returning driver for their 4-digit PIN or has
/// a new one pick a PIN (typed twice, before it is registered); the PIN shows
/// as it is typed, and the screen is cleared the moment Enter is pressed so it
/// is gone before the next person sits down.
/// DRIVING shows only the signed-in name and "Press Enter to log out", with the
/// driver's laps printed below it - queued, then posted once the backend has
/// them; Enter logs them out and clears back to SIGN IN. A lap driven while
/// nobody is signed in says it did not count. Every screen opens with a
/// warning line for each problem still standing (backend offline, iRacing not
/// running), so clearing the screen never hides one. The owner's words: "the user types their name and
/// then as they make laps it assigns it accordingly. When they are done, they
/// just exit out the program and then it waits for the next person." The same
/// name and PIN bring a returning driver back to their own leaderboard row, on
/// either rig, on both event days.
///
/// Sign-in goes through the backend's existing login, register and check-in
/// routes (<see cref="DriverCheckInClient"/>); sign-out is the agent's own
/// switch-driver, which ends the stint locally at once and delivers the
/// checkout durably. Closing the program signs out too (see
/// <see cref="SignOutOnExitAsync"/>), and the next start empties the seat
/// before it asks for a name, so a stint whose sign-out never landed is ended
/// then and never credited with anyone else's laps.
/// </summary>
internal static class DriverPrompt
{
    private static readonly string Rule = new('=', 60);

    public static async Task RunAsync(
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, WalkUpScreen screen, CancellationToken quit)
    {
        var laps = new LapBoard();
        void OnQueued(LapCompleted lap, string? stamp) => screen.Log(laps.Queued(lap, stamp).Describe());
        void OnPosted(IReadOnlyList<string> eventIds)
        {
            foreach (var row in laps.Posted(eventIds)) screen.Log(row.Describe());
        }

        agent.LapQueued += OnQueued;
        agent.LapsPosted += OnPosted;
        try
        {
            await RunScreensAsync(agent, checkIn, rigNumber, screen, quit);
        }
        finally
        {
            agent.LapQueued -= OnQueued;
            agent.LapsPosted -= OnPosted;
        }
    }

    private static async Task RunScreensAsync(
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, WalkUpScreen screen, CancellationToken quit)
    {
        var notice = await WalkUpRules.EmptySeatAsync(agent, quit);

        while (!quit.IsCancellationRequested)
        {
            var driver = await SignInAsync(agent, checkIn, rigNumber, screen, notice, quit);
            if (driver is null) return;

            agent.SeatCheckedInDriver(driver);
            ShowDriving(screen, rigNumber, driver);

            var done = await screen.ReadLineAsync(quit);
            // Input ending is the program closing, and a signal handler may
            // already have run the exit sign-out and emptied the seat; an
            // unguarded switch here would then send an unnamed checkout and
            // close whatever stint was opened on the rig since.
            var result = done is null
                ? await agent.SignOutSeatedDriverAsync()
                : await agent.SwitchDriverAsync();
            notice = WalkUpRules.LoggedOut(driver.DisplayName, result);
            if (done is null)
            {
                screen.Transition(notice);
                return;
            }
        }
    }

    /// <summary>Walk the next driver from their name to a check-in,
    /// one console prompt per <see cref="SignInStep"/> of the shared
    /// <see cref="SignInFlow"/>; the rules are the flow's. Null when the
    /// program is closing.</summary>
    private static async Task<DriverCheckIn?> SignInAsync(
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, WalkUpScreen screen, string? notice, CancellationToken quit)
    {
        var flow = new SignInFlow(notice);
        while (true)
        {
            if (flow.Pending is { } request)
            {
                screen.Transition(request.Call switch
                {
                    SignInCall.LookUpName => $"Looking up {request.Name}...",
                    SignInCall.LogIn => $"Signing in {request.Name}...",
                    _ => $"Signing up {request.Name}...",
                });
                var result = await SignInAttempt.PerformAsync(agent, checkIn, request, quit);
                if (result.Outcome == SignInOutcome.Cancelled) return null;
                flow.Apply(result);
                if (flow.Step == SignInStep.SignedIn) return flow.Driver;
                continue;
            }

            var typed = await AskAsync(screen, rigNumber, flow.Notice, NameLine(flow), Prompt(flow), quit);
            if (typed is null) return null;
            flow.Submit(typed);
        }
    }

    /// <summary>The line above the prompt naming the driver, once the lookup
    /// has said which they are; null at the name prompt.</summary>
    private static string? NameLine(SignInFlow flow) => flow.Step switch
    {
        SignInStep.AskPin or SignInStep.PinRefused => $"Welcome back, {flow.Name}",
        SignInStep.AskNewPin or SignInStep.AskNewPinAgain => $"New driver: {flow.Name}",
        _ => null,
    };

    /// <summary>The console's wording of each prompt.</summary>
    private static string Prompt(SignInFlow flow) => flow.Step switch
    {
        SignInStep.AskName => "Type your name for the leaderboard and press Enter:",
        SignInStep.AskPin => "Type your 4-digit PIN and press Enter (not you? Enter alone goes back to the name):",
        SignInStep.PinRefused => "That PIN does not match. Ask staff to reset your PIN, or press Enter to try a different name.",
        SignInStep.AskNewPin => "Pick a 4-digit PIN, remember it, and press Enter (Enter alone goes back to the name):",
        SignInStep.AskNewPinAgain => "Type the same PIN again and press Enter (Enter alone goes back):",
        _ => throw new InvalidOperationException($"no prompt for {flow.Step}"),
    };

    /// <summary>Show one sign-in prompt and read the answer, trimmed; null when
    /// the program is closing. The screen is cleared the moment Enter is
    /// pressed, by whatever is shown next, so a PIN is gone before the next
    /// person sits down.</summary>
    private static async Task<string?> AskAsync(
        WalkUpScreen screen, int rigNumber, string? notice, string? name, string prompt, CancellationToken quit)
    {
        ShowSignIn(screen, rigNumber, notice, name, prompt);
        return (await screen.ReadLineAsync(quit))?.Trim();
    }

    /// <summary>See <see cref="WalkUpRules.SignOutOnExitAsync"/>.</summary>
    public static Task SignOutOnExitAsync(AgentService agent) => WalkUpRules.SignOutOnExitAsync(agent);

    private static void Banner(IPromptConsole console, IReadOnlyList<string> warnings, string title)
    {
        console.WriteLine(Rule);
        console.WriteLine(title);
        console.WriteLine(Rule);
        foreach (var warning in warnings) console.WriteLine(warning);
    }

    private static void ShowSignIn(WalkUpScreen screen, int rigNumber, string? notice, string? name, string prompt)
    {
        screen.Show(typedOn: true, body: (console, warnings) =>
        {
            Banner(console, warnings, $"  OASIS RACE CONTROL - RIG {rigNumber:D2} - SIGN IN");
            if (notice is not null)
            {
                console.WriteLine();
                console.WriteLine(notice);
            }
            console.WriteLine();
            if (name is not null) console.WriteLine(name);
            console.WriteLine(prompt);
        });
    }

    private static void ShowDriving(WalkUpScreen screen, int rigNumber, DriverCheckIn session)
    {
        screen.Show(typedOn: false, body: (console, warnings) =>
        {
            Banner(console, warnings, $"  RIG {rigNumber:D2} - DRIVING: {session.DisplayName}");
            console.WriteLine(WalkUpRules.Welcome(session));
            console.WriteLine();
            console.WriteLine("Press Enter to log out.");
            console.WriteLine();
        });
    }
}

/// <summary>
/// The console as one screen at a time. A screen is a drawing (banner with the
/// warnings standing at that moment, then its own lines) plus the log lines
/// added since it was shown. When the agent's status changes the set of
/// warnings, the DRIVING screen is drawn again from scratch with the current
/// set and its log lines re-printed - so a warning that no longer applies is
/// gone the moment it stops applying, and one that starts applying appears
/// without waiting for the next screen. The first real rig showed "iRacing is
/// not running" above laps that were being read and posted; this is what
/// removes it. A SIGN IN screen is never cleared while it is up, because a
/// name or PIN may be half typed and clearing hides it from the person typing
/// while the console still holds it; a warning that starts applying there is
/// printed below the prompt instead. Everything walk-up mode prints goes
/// through <see cref="Log"/> or <see cref="Standing"/>, so a redraw keeps it.
/// </summary>
internal sealed class WalkUpScreen
{
    private const int KeptLogLines = 30;
    private readonly IPromptConsole _console;
    private readonly AgentService _agent;
    private readonly object _lock = new();
    private readonly List<string> _log = new();
    private readonly List<string> _standing = new();
    private Action<IPromptConsole, IReadOnlyList<string>>? _body;
    private bool _typedOn;
    private List<string> _shownWarnings = new();

    public WalkUpScreen(IPromptConsole console, AgentService agent)
    {
        _console = console;
        _agent = agent;
        _agent.StatusChanged += OnStatus;
    }

    public Task<string?> ReadLineAsync(CancellationToken quit) => _console.ReadLineAsync(quit);

    /// <summary>Replace what is on screen with this drawing. A screen that is
    /// <paramref name="typedOn"/> is not redrawn until the next one is shown.</summary>
    public void Show(Action<IPromptConsole, IReadOnlyList<string>> body, bool typedOn)
    {
        lock (_lock)
        {
            _body = body;
            _typedOn = typedOn;
            _log.Clear();
            Draw(Warnings(_agent.CurrentStatus()));
        }
    }

    /// <summary>A one-line transitional message with no screen behind it.</summary>
    public void Transition(string message)
    {
        lock (_lock)
        {
            _body = null;
            _log.Clear();
            _console.Clear();
            _console.WriteLine(message);
        }
    }

    public void Log(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {message}";
        lock (_lock)
        {
            _log.Add(line);
            if (_log.Count > KeptLogLines) _log.RemoveAt(0);
            _console.WriteLine(line);
        }
    }

    /// <summary>A problem that stands until the program is restarted - lap
    /// reading stopped, an iRacing build missing what laps are read from - shown
    /// under the banner of every screen from now on.</summary>
    public void Standing(string warning)
    {
        lock (_lock)
        {
            if (_standing.Contains(warning)) return;
            _standing.Add(warning);
            Refresh(Warnings(_agent.CurrentStatus()));
        }
    }

    private List<string> Warnings(AgentStatus status) => _standing.Concat(WalkUpRules.Warnings(status)).ToList();

    private void Draw(List<string> warnings)
    {
        _console.Clear();
        _shownWarnings = warnings;
        _body?.Invoke(_console, warnings);
        foreach (var line in _log) _console.WriteLine(line);
    }

    private void Refresh(List<string> warnings)
    {
        if (_body is null || warnings.SequenceEqual(_shownWarnings)) return;
        if (!_typedOn)
        {
            Draw(warnings);
            return;
        }
        foreach (var warning in warnings.Except(_shownWarnings)) _console.WriteLine(warning);
        _shownWarnings = warnings;
    }

    private void OnStatus(AgentStatus status)
    {
        lock (_lock) Refresh(Warnings(status));
    }
}
