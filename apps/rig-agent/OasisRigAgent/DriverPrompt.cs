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
/// a 4-digit PIN; the PIN shows as it is typed, and the screen is cleared the
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
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, IPromptConsole screen, CancellationToken quit)
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
        AgentService agent, DriverCheckInClient checkIn, int rigNumber, IPromptConsole screen, CancellationToken quit)
    {
        var notice = await EmptySeatAsync(agent, quit);

        while (!quit.IsCancellationRequested)
        {
            ShowSignIn(screen, agent, rigNumber, notice, name: null);
            screen.WriteLine("Type your name and press Enter:");
            var typed = await screen.ReadLineAsync(quit);
            if (typed is null) return;
            var name = typed.Trim();
            notice = null;
            if (name.Length == 0) continue;

            var pin = await ReadPinAsync(screen, agent, rigNumber, name, quit);
            if (pin is null) return;
            screen.Clear();
            screen.WriteLine($"Signing in {name}...");

            DriverCheckIn session;
            try
            {
                session = await checkIn.CheckInAsync(name, pin, quit);
            }
            catch (CheckInRefusedException ex)
            {
                notice = $"Could not sign in: {ex.Message}";
                continue;
            }
            catch (OperationCanceledException) when (quit.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                notice = $"Could not reach the backend ({ex.Message}). Check the network and try again.";
                continue;
            }

            agent.SeatCheckedInDriver(session);
            ShowDriving(screen, agent, rigNumber, session);

            var done = await screen.ReadLineAsync(quit);
            var result = await agent.SwitchDriverAsync();
            notice = result switch
            {
                SwitchDriverResult.Ended or SwitchDriverResult.NoActiveSession => $"Thanks {session.DisplayName}, you are logged out.",
                SwitchDriverResult.EndedPendingSync => $"Thanks {session.DisplayName}, logged out here; the backend will be told when the connection returns.",
                _ => $"Thanks {session.DisplayName}, logged out here; the backend could not be reached - the next name's check-in will take the seat over.",
            };
            if (done is null)
            {
                screen.WriteLine(notice);
                return;
            }
        }
    }

    /// <summary>Sign-out when the program is closing (Enter at end of input,
    /// Ctrl+C, the window's close button, a shutdown). The switch-driver writes
    /// its durable tombstone before it touches the network, and the checkout
    /// call is then waited for up to three seconds so a backend that does not
    /// answer cannot hold the window open. Whatever does not land is ended by
    /// the next start's empty seat.</summary>
    public static async Task SignOutOnExitAsync(AgentService agent)
    {
        try
        {
            await agent.SwitchDriverAsync().WaitAsync(ExitSignOutLimit);
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

    private static void Log(IPromptConsole screen, string message) =>
        screen.WriteLine($"[{DateTime.Now:HH:mm:ss}] {message}");

    private static void ShowBanner(IPromptConsole screen, AgentService agent, string title)
    {
        screen.Clear();
        screen.WriteLine(Rule);
        screen.WriteLine(title);
        screen.WriteLine(Rule);
        foreach (var warning in Warnings(agent.CurrentStatus())) screen.WriteLine(warning);
    }

    private static void ShowSignIn(IPromptConsole screen, AgentService agent, int rigNumber, string? notice, string? name)
    {
        ShowBanner(screen, agent, $"  OASIS RACE CONTROL - RIG {rigNumber:D2} - SIGN IN");
        if (notice is not null)
        {
            screen.WriteLine();
            screen.WriteLine(notice);
        }
        screen.WriteLine();
        if (name is not null) screen.WriteLine($"Name: {name}");
    }

    private static void ShowDriving(IPromptConsole screen, AgentService agent, int rigNumber, DriverCheckIn session)
    {
        ShowBanner(screen, agent, $"  RIG {rigNumber:D2} - DRIVING: {session.DisplayName}");
        screen.WriteLine(session.Returning
            ? "Welcome back. Your laps post automatically."
            : "You are signed up. Your laps post automatically. Use the same name and PIN next time, on either rig, either day.");
        screen.WriteLine();
        screen.WriteLine("Press Enter to log out.");
        screen.WriteLine();
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

    /// <summary>Ask for the PIN until it is four digits. A wrong one is cleared
    /// off the screen before asking again, the name staying in view.</summary>
    private static async Task<string?> ReadPinAsync(IPromptConsole screen, AgentService agent, int rigNumber, string name, CancellationToken quit)
    {
        string? notice = null;
        while (true)
        {
            if (notice is not null) ShowSignIn(screen, agent, rigNumber, notice, name);
            screen.WriteLine("Type your 4-digit PIN and press Enter (new here? pick one and remember it):");
            var typed = await screen.ReadLineAsync(quit);
            if (typed is null) return null;
            var pin = typed.Trim();
            if (DriverCheckInClient.IsPin(pin)) return pin;
            notice = "The PIN is exactly 4 digits.";
        }
    }
}
