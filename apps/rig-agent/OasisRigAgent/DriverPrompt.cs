using OasisRigAgent.Core;

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
/// The walk-up loop on the rig PC, as two screens. SIGN IN asks for a name and
/// a 4-digit PIN (twice for a name that matches nobody, before it is
/// registered); the PIN shows as it is typed, and the screen is cleared the
/// moment Enter is pressed so it is gone before the next person sits down.
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
    private const int EmptySeatAttempts = 5;
    private static readonly TimeSpan EmptySeatRetryGap = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ExitSignOutLimit = TimeSpan.FromSeconds(3);
    private static readonly string Rule = new('=', 60);

    public static async Task RunAsync(
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, WalkUpScreen screen, CancellationToken quit)
    {
        var waiting = new Dictionary<string, string>();
        void OnQueued(LapCompleted lap, string? stamp)
        {
            var label = $"Lap {lap.LapNumber?.ToString() ?? "-"}  {LapTime.Format(lap.LapTimeMs)}  incidents {lap.IncidentDelta?.ToString() ?? "n/a"}";
            if (stamp is null)
            {
                Log(screen, $"{label} - lap not counted - sign in first");
                return;
            }
            lock (waiting) waiting[lap.EventId] = label;
            Log(screen, $"{label} - queued");
        }
        void OnPosted(IReadOnlyList<string> eventIds)
        {
            foreach (var eventId in eventIds)
            {
                string? label;
                lock (waiting)
                {
                    if (!waiting.Remove(eventId, out label)) continue;
                }
                Log(screen, $"{label} - posted");
            }
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
        var notice = await EmptySeatAsync(agent, quit);

        while (!quit.IsCancellationRequested)
        {
            ShowSignIn(screen, rigNumber, notice, name: null, prompt: "Type your name and press Enter:");
            var typed = await screen.ReadLineAsync(quit);
            if (typed is null) return;
            var name = typed.Trim();
            notice = null;
            if (name.Length == 0) continue;

            var outcome = await SignInAsync(agent, checkIn, rigNumber, screen, name, quit);
            if (outcome.Quit) return;
            if (outcome.CheckIn is null)
            {
                notice = outcome.Notice;
                continue;
            }

            var driver = outcome.CheckIn;
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
            notice = result switch
            {
                SwitchDriverResult.Ended or SwitchDriverResult.NoActiveSession => $"Thanks {driver.DisplayName}, you are logged out.",
                SwitchDriverResult.EndedPendingSync => $"Thanks {driver.DisplayName}, logged out here; the backend will be told when the connection returns.",
                _ => $"Thanks {driver.DisplayName}, logged out here; the backend could not be reached - the next name's check-in will take the seat over.",
            };
            if (done is null)
            {
                screen.Transition(notice);
                return;
            }
        }
    }

    /// <summary>What asking one name for its PIN came to: a driver to seat, or
    /// a notice for the name screen, or the program closing.</summary>
    private readonly record struct SignInOutcome(DriverCheckIn? CheckIn, string? Notice, bool Quit);

    /// <summary>Ask the typed name for its PIN and sign it in. A new name is
    /// asked for the PIN a second time before it is registered; a name that is
    /// already registered to a different PIN, or a new PIN that was not
    /// confirmed, keeps the name and asks for the PIN again. Once the backend
    /// has said the name is registered, a later wrong PIN is worded as one and
    /// never offered as a new sign-up. Enter alone at the PIN goes back to the
    /// name screen.</summary>
    private static async Task<SignInOutcome> SignInAsync(
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, WalkUpScreen screen, string name, CancellationToken quit)
    {
        string? pinNotice = null;
        var nameRegistered = false;
        while (true)
        {
            var pin = await ReadPinAsync(screen, rigNumber, name, pinNotice, quit);
            if (pin is null) return new SignInOutcome(null, null, Quit: true);
            if (pin.Length == 0) return new SignInOutcome(null, null, Quit: false);
            screen.Transition($"Signing in {name}...");

            if (!await agent.SettlePendingCheckoutAsync())
                return new SignInOutcome(null, "Could not reach the backend to finish the last log-out. Check the network and try again.", Quit: false);

            var inputEnded = false;
            async Task<string?> ConfirmNewPin(CancellationToken ct)
            {
                ShowSignIn(screen, rigNumber, $"No driver is signed up as \"{name}\" with that PIN.", name,
                    "New here? Type the same PIN again to sign up (raced here before? press Enter to type your PIN again):");
                var typed = await screen.ReadLineAsync(quit);
                if (typed is null)
                {
                    inputEnded = true;
                    return null;
                }
                screen.Transition($"Signing up {name}...");
                return typed.Trim();
            }

            try
            {
                return new SignInOutcome(await checkIn.CheckInAsync(name, pin, nameRegistered ? null : ConfirmNewPin, quit), null, Quit: false);
            }
            catch (CheckInRefusedException ex) when (ex.RetryPin)
            {
                nameRegistered |= ex.NameRegistered;
                pinNotice = $"Could not sign in: {ex.Message}";
            }
            catch (CheckInRefusedException ex)
            {
                return new SignInOutcome(null, $"Could not sign in: {ex.Message}", Quit: false);
            }
            catch (OperationCanceledException) when (quit.IsCancellationRequested || inputEnded)
            {
                return new SignInOutcome(null, null, Quit: true);
            }
            catch (Exception ex)
            {
                return new SignInOutcome(null, $"Could not reach the backend ({ex.Message}). Check the network and try again.", Quit: false);
            }
        }
    }

    /// <summary>Sign-out when the program is closing (Enter at end of input,
    /// Ctrl+C, the window's close button, a shutdown). The switch-driver writes
    /// its durable tombstone before it touches the network, and the checkout
    /// call is then waited for up to three seconds so a backend that does not
    /// answer cannot hold the window open. Whatever does not land is ended by
    /// the next start's empty seat. Nobody seated - closed from the sign-in
    /// screen, or after the log-out that input ending already ran - sends
    /// nothing: there is no stint of this agent's to name.</summary>
    public static async Task SignOutOnExitAsync(AgentService agent)
    {
        try
        {
            await agent.SignOutSeatedDriverAsync().WaitAsync(ExitSignOutLimit);
        }
        catch (Exception)
        {
            // Nothing more can be done on the way out; the next start covers it.
        }
    }

    /// <summary>One line for each problem standing right now that the person at
    /// the rig can see the effect of, or should tell staff about.</summary>
    internal static IEnumerable<string> Warnings(AgentStatus status)
    {
        if (status.Connection == ConnectionState.Offline)
            yield return "WARNING: the backend cannot be reached - laps are kept on this rig and sent when it is back.";
        if (!status.SimRunning)
            yield return "WARNING: iRacing is not running or not in a session - no laps are being read.";
        if (status.RejectedLaps > 0)
            yield return $"WARNING: {status.RejectedLaps} lap(s) were refused by the backend - tell staff.";
        if (status.Checkout == CheckoutDelivery.NotQueued)
            yield return "WARNING: a log-out was not saved - staff must clear this rig on the staff screen.";
    }

    private static void Log(WalkUpScreen screen, string message) => screen.Log(message);

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
            if (name is not null) console.WriteLine($"Name: {name}");
            console.WriteLine(prompt);
        });
    }

    private static void ShowDriving(WalkUpScreen screen, int rigNumber, DriverCheckIn session)
    {
        screen.Show(typedOn: false, body: (console, warnings) =>
        {
            Banner(console, warnings, $"  RIG {rigNumber:D2} - DRIVING: {session.DisplayName}");
            console.WriteLine(session.Returning
                ? "Welcome back. Your laps post automatically."
                : "You are signed up. Your laps post automatically. Use the same name and PIN next time, on either rig, either day.");
            console.WriteLine();
            console.WriteLine("Press Enter to log out.");
            console.WriteLine();
        });
    }

    /// <summary>End whatever is open on this rig before the first name is
    /// asked for, retrying a few times while the backend does not answer. Once
    /// the prompt has to show it shows anyway: this agent never stamps a lap
    /// with a stint it did not create, and the first check-in takes the seat
    /// over. Returns what the first sign-in screen should say about it.</summary>
    private static async Task<string?> EmptySeatAsync(AgentService agent, CancellationToken quit)
    {
        for (var attempt = 1; ; attempt++)
        {
            if (await agent.EmptySeatAsync()) return null;
            if (attempt == EmptySeatAttempts)
                return "Could not reach the backend to clear this rig's seat; the first check-in will take it over.";
            try { await Task.Delay(EmptySeatRetryGap, quit); }
            catch (OperationCanceledException) { return null; }
        }
    }

    /// <summary>Ask for the PIN until it is four digits, or empty to go back to
    /// the name. A wrong one is cleared off the screen before asking again, the
    /// name staying in view. <paramref name="notice"/> opens a fresh screen with
    /// it; without one the prompt goes under the name just typed.</summary>
    private static async Task<string?> ReadPinAsync(
        WalkUpScreen screen, int rigNumber, string name, string? notice, CancellationToken quit)
    {
        const string prompt = "Type your 4-digit PIN and press Enter (new here? pick one and remember it):";
        const string again = "Type your 4-digit PIN and press Enter (Enter alone goes back to the name):";
        var retrying = notice is not null;
        while (true)
        {
            if (notice is not null) ShowSignIn(screen, rigNumber, notice, name, retrying ? again : prompt);
            else screen.Append(prompt);
            var typed = await screen.ReadLineAsync(quit);
            if (typed is null) return null;
            var pin = typed.Trim();
            if (pin.Length == 0 && retrying) return "";
            if (DriverCheckInClient.IsPin(pin)) return pin;
            notice = "The PIN is exactly 4 digits.";
        }
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
    private readonly List<string> _appended = new();

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
            _appended.Clear();
            Draw(Warnings(_agent.CurrentStatus()));
        }
    }

    /// <summary>A prompt line that belongs to the current screen (re-printed on a redraw).</summary>
    public void Append(string line)
    {
        lock (_lock)
        {
            _appended.Add(line);
            _console.WriteLine(line);
        }
    }

    /// <summary>A one-line transitional message with no screen behind it.</summary>
    public void Transition(string message)
    {
        lock (_lock)
        {
            _body = null;
            _log.Clear();
            _appended.Clear();
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

    private List<string> Warnings(AgentStatus status) => _standing.Concat(DriverPrompt.Warnings(status)).ToList();

    private void Draw(List<string> warnings)
    {
        _console.Clear();
        _shownWarnings = warnings;
        _body?.Invoke(_console, warnings);
        foreach (var line in _appended) _console.WriteLine(line);
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
