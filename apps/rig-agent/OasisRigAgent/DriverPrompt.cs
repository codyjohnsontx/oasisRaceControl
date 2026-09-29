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
/// The walk-up loop on the rig PC, as two screens. SIGN IN asks whether the
/// driver has raced here before, then a name and a 4-digit PIN (twice for a
/// new driver, before it is registered); the PIN shows as it is typed, and the
/// screen is cleared the moment Enter is pressed so it is gone before the next
/// person sits down.
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
    private const int LoginsPerName = 2;
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

    /// <summary>
    /// Where signing the next driver in has got to (<see cref="SignInAsync"/>).
    /// The rig asks whether the driver has raced here before instead of
    /// guessing it from a failed login, so a wrong PIN is never offered as a
    /// new sign-up and a new driver is never told their PIN is wrong. Enter
    /// alone at any prompt goes back one step.
    /// <list type="bullet">
    /// <item><see cref="AskRacedBefore"/>: y goes to the returning path, n to
    /// the new one.</item>
    /// <item><see cref="AskName"/>: the name, then <see cref="AskPin"/>
    /// (returning) or <see cref="AskNewPin"/> (new).</item>
    /// <item><see cref="AskPin"/> then <see cref="LogIn"/>: a match signs the
    /// driver in. A miss asks for the PIN once more; the second miss goes to
    /// <see cref="PinRefused"/>. The misses are counted per name for the whole
    /// sign-in, however often the name is typed again, and a name that has used
    /// them goes straight to <see cref="PinRefused"/> without a login - so one
    /// sign-in makes at most <c>LoginsPerName</c> failed logins for a name, and
    /// a stranger cannot run a real name into the backend's lockout (five).
    /// Names compare without case, as the backend's do. Never registers
    /// anything.</item>
    /// <item><see cref="PinRefused"/>: says to ask staff for a PIN reset; Enter
    /// goes back to the name.</item>
    /// <item><see cref="AskNewPin"/> then <see cref="AskNewPinAgain"/>: two PINs
    /// that differ ask for both again, on the rig, with no backend call; the
    /// same PIN twice goes to <see cref="Register"/>.</item>
    /// <item><see cref="Register"/>: a new driver is signed in. A taken name
    /// (409) goes back to the name, saying to answer y if it is theirs. Never
    /// logs in; a check-in that fails after the sign-up goes back to the name
    /// on the returning path, since the name is theirs now.</item>
    /// </list>
    /// </summary>
    private enum SignInState { AskRacedBefore, AskName, AskPin, LogIn, PinRefused, AskNewPin, AskNewPinAgain, Register }

    /// <summary>Walk the next driver from "Raced here before?" to a check-in.
    /// Null when the program is closing.</summary>
    private static async Task<DriverCheckIn?> SignInAsync(
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, WalkUpScreen screen, string? notice, CancellationToken quit)
    {
        var state = SignInState.AskRacedBefore;
        var returning = false;
        var name = "";
        var pin = "";
        var misses = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

        while (true)
        {
            string? typed;
            switch (state)
            {
                case SignInState.AskRacedBefore:
                    typed = await AskAsync(screen, rigNumber, notice, null, "Raced here before? Type y or n and press Enter:", quit);
                    if (typed is null) return null;
                    notice = null;
                    switch (typed.ToLowerInvariant())
                    {
                        case "y" or "yes":
                            returning = true;
                            state = SignInState.AskName;
                            break;
                        case "n" or "no":
                            returning = false;
                            state = SignInState.AskName;
                            break;
                        case "":
                            break;
                        default:
                            notice = "Type y if you have raced here before, or n if you are new.";
                            break;
                    }
                    break;

                case SignInState.AskName:
                    typed = await AskAsync(screen, rigNumber, notice, null, returning
                        ? "Type the name you raced under and press Enter (Enter alone goes back):"
                        : "Type a name for the leaderboard and press Enter (Enter alone goes back):", quit);
                    if (typed is null) return null;
                    notice = null;
                    if (typed.Length == 0)
                    {
                        state = SignInState.AskRacedBefore;
                        break;
                    }
                    name = typed;
                    state = !returning ? SignInState.AskNewPin
                        : misses.GetValueOrDefault(name) >= LoginsPerName ? SignInState.PinRefused
                        : SignInState.AskPin;
                    break;

                case SignInState.AskPin:
                    typed = await AskAsync(screen, rigNumber, notice, name,
                        "Type your 4-digit PIN and press Enter (Enter alone goes back to the name):", quit);
                    if (typed is null) return null;
                    notice = null;
                    if (typed.Length == 0) state = SignInState.AskName;
                    else if (!DriverCheckInClient.IsPin(typed)) notice = "The PIN is exactly 4 digits.";
                    else
                    {
                        pin = typed;
                        state = SignInState.LogIn;
                    }
                    break;

                case SignInState.LogIn:
                case SignInState.Register:
                    {
                        screen.Transition(state == SignInState.LogIn ? $"Signing in {name}..." : $"Signing up {name}...");
                        DriverCheckIn? driver;
                        try
                        {
                            if (!await agent.SettlePendingCheckoutAsync())
                            {
                                notice = "Could not reach the backend to finish the last log-out. Check the network and try again.";
                                state = SignInState.AskName;
                                break;
                            }
                            driver = state == SignInState.LogIn
                                ? await checkIn.CheckInReturningAsync(name, pin, quit)
                                : await checkIn.CheckInNewAsync(name, pin, quit);
                        }
                        catch (SignedUpButNotCheckedInException ex)
                        {
                            returning = true;
                            notice = ex.InnerException is CheckInRefusedException
                                ? $"You are signed up as \"{name}\", but could not be checked in: {ex.Message}. Type your name and PIN to check in."
                                : $"You are signed up as \"{name}\", but the backend could not be reached to check you in ({ex.Message}). Type your name and PIN to check in.";
                            state = SignInState.AskName;
                            break;
                        }
                        catch (CheckInRefusedException ex)
                        {
                            notice = $"Could not sign in: {ex.Message}";
                            state = SignInState.AskName;
                            break;
                        }
                        catch (OperationCanceledException) when (quit.IsCancellationRequested)
                        {
                            return null;
                        }
                        catch (Exception ex)
                        {
                            notice = $"Could not reach the backend ({ex.Message}). Check the network and try again.";
                            state = SignInState.AskName;
                            break;
                        }
                        if (driver is not null) return driver;

                        if (state == SignInState.Register)
                        {
                            notice = $"The name \"{name}\" is already registered. If it is yours, press Enter and answer y to \"Raced here before?\"; otherwise type a different name.";
                            state = SignInState.AskName;
                        }
                        else if ((misses[name] = misses.GetValueOrDefault(name) + 1) < LoginsPerName)
                        {
                            notice = $"That PIN does not match \"{name}\". Type it again.";
                            state = SignInState.AskPin;
                        }
                        else
                        {
                            state = SignInState.PinRefused;
                        }
                        break;
                    }

                case SignInState.PinRefused:
                    typed = await AskAsync(screen, rigNumber, null, name,
                        "That PIN does not match. Ask staff to reset your PIN, or press Enter to try a different name.", quit);
                    if (typed is null) return null;
                    state = SignInState.AskName;
                    break;

                case SignInState.AskNewPin:
                    typed = await AskAsync(screen, rigNumber, notice, name,
                        "Pick a 4-digit PIN, remember it, and press Enter (Enter alone goes back to the name):", quit);
                    if (typed is null) return null;
                    notice = null;
                    if (typed.Length == 0) state = SignInState.AskName;
                    else if (!DriverCheckInClient.IsPin(typed)) notice = "The PIN is exactly 4 digits.";
                    else
                    {
                        pin = typed;
                        state = SignInState.AskNewPinAgain;
                    }
                    break;

                case SignInState.AskNewPinAgain:
                    typed = await AskAsync(screen, rigNumber, null, name,
                        "Type the same PIN again and press Enter (Enter alone goes back):", quit);
                    if (typed is null) return null;
                    if (typed.Length == 0) state = SignInState.AskNewPin;
                    else if (typed == pin) state = SignInState.Register;
                    else
                    {
                        notice = "The two PINs did not match, so nothing was signed up. Pick a PIN and type it twice.";
                        state = SignInState.AskNewPin;
                    }
                    break;
            }
        }
    }

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

    private List<string> Warnings(AgentStatus status) => _standing.Concat(DriverPrompt.Warnings(status)).ToList();

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
