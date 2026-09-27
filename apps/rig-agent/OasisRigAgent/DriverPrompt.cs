using OasisRigAgent.Core;

namespace OasisRigAgent;

/// <summary>
/// The walk-up loop on the rig PC: ask for a name and a 4-digit PIN, sign that
/// person in on this rig, let them drive while laps post under their name, and
/// when they press Enter sign them out and ask for the next name. The owner's
/// words: "the user types their name and then as they make laps it assigns it
/// accordingly. When they are done, they just exit out the program and then it
/// waits for the next person." The same name and PIN bring a returning driver
/// back to their own leaderboard row, on either rig, on both event days.
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

    public static async Task RunAsync(AgentService agent, DriverCheckInClient checkIn, CancellationToken quit)
    {
        if (!await EmptySeatAsync(agent, quit)) return;

        while (!quit.IsCancellationRequested)
        {
            Console.WriteLine();
            Console.WriteLine("Type your name and press Enter:");
            var typed = await ReadLineAsync(quit);
            if (typed is null) return;
            var name = typed.Trim();
            if (name.Length == 0) continue;

            var pin = await ReadPinAsync(quit);
            if (pin is null) return;

            DriverCheckIn session;
            try
            {
                session = await checkIn.CheckInAsync(name, pin, quit);
            }
            catch (CheckInRefusedException ex)
            {
                Console.WriteLine($"Could not sign in: {ex.Message}");
                continue;
            }
            catch (OperationCanceledException) when (quit.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Could not reach the backend ({ex.Message}). Check the network and try again.");
                continue;
            }

            agent.SeatCheckedInDriver(session);

            Console.WriteLine(session.Returning
                ? $"Welcome back {session.DisplayName}."
                : $"Signed up as {session.DisplayName}. Use the same name and PIN next time, on either rig, either day.");
            Console.WriteLine("Laps post automatically. Press Enter when you are done.");

            var done = await ReadLineAsync(quit);
            var result = await agent.SwitchDriverAsync();
            Console.WriteLine(result switch
            {
                SwitchDriverResult.Ended or SwitchDriverResult.NoActiveSession => $"Thanks {session.DisplayName}, you are signed out.",
                SwitchDriverResult.EndedPendingSync => $"Thanks {session.DisplayName}, signed out here; the backend will be told when the connection returns.",
                _ => $"Thanks {session.DisplayName}, signed out here; the backend could not be reached - the next name's check-in will take the seat over.",
            });
            if (done is null) return;
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

    /// <summary>End whatever is open on this rig before the first name is
    /// asked for, retrying a few times while the backend does not answer. Once
    /// the prompt has to show it shows anyway: this agent never stamps a lap
    /// with a stint it did not create, and the first check-in takes the seat
    /// over. False only when the agent is quitting.</summary>
    private static async Task<bool> EmptySeatAsync(AgentService agent, CancellationToken quit)
    {
        for (var attempt = 1; ; attempt++)
        {
            if (await agent.EmptySeatAsync()) return true;
            if (attempt == EmptySeatAttempts)
            {
                Console.WriteLine("Could not reach the backend to clear this rig's seat; the first check-in will take it over.");
                return true;
            }
            try { await Task.Delay(EmptySeatRetryGap, quit); }
            catch (OperationCanceledException) { return false; }
        }
    }

    private static async Task<string?> ReadPinAsync(CancellationToken quit)
    {
        while (true)
        {
            Console.WriteLine("Type your 4-digit PIN and press Enter (new here? pick one and remember it):");
            var typed = await ReadLineAsync(quit);
            if (typed is null) return null;
            var pin = typed.Trim();
            if (DriverCheckInClient.IsPin(pin)) return pin;
            Console.WriteLine("The PIN is exactly 4 digits.");
        }
    }

    /// <summary>Console.ReadLine that gives up when the agent is quitting, so a
    /// Ctrl+C or window close does not leave the loop stuck on input.</summary>
    private static async Task<string?> ReadLineAsync(CancellationToken quit)
    {
        var read = Task.Run(Console.ReadLine);
        var finished = await Task.WhenAny(read, Task.Delay(Timeout.Infinite, quit).ContinueWith(_ => (string?)null));
        return finished == read ? read.Result : null;
    }
}
