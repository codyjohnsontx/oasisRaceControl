namespace OasisRigAgent.Core.WalkUp;

/// <summary>
/// What walk-up mode tells the person at the rig, and how it starts and ends a
/// stint, in one place for the console and the window: the warnings standing
/// under every screen's banner, the words at a log-out, and emptying the seat
/// before the first name is asked for.
/// </summary>
public static class WalkUpRules
{
    private const int EmptySeatAttempts = 5;
    private static readonly TimeSpan EmptySeatRetryGap = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ExitSignOutLimit = TimeSpan.FromSeconds(3);

    /// <summary>One line for each problem standing right now that the person at
    /// the rig can see the effect of, or should tell staff about.</summary>
    public static IEnumerable<string> Warnings(AgentStatus status)
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

    /// <summary>What the next sign-in screen says about the driver who just
    /// logged out, by what the backend has been told.</summary>
    public static string LoggedOut(string displayName, SwitchDriverResult result) => result switch
    {
        SwitchDriverResult.Ended or SwitchDriverResult.NoActiveSession => $"Thanks {displayName}, you are logged out.",
        SwitchDriverResult.EndedPendingSync => $"Thanks {displayName}, logged out here; the backend will be told when the connection returns.",
        _ => $"Thanks {displayName}, logged out here; the backend could not be reached - the next name's check-in will take the seat over.",
    };

    /// <summary>The first line of the driving screen, by whether the name and
    /// PIN were already the driver's.</summary>
    public static string Welcome(DriverCheckIn driver) => driver.Returning
        ? "Welcome back. Your laps post automatically."
        : "You are signed up. Your laps post automatically. Use the same name and PIN next time, on either rig, either day.";

    /// <summary>End whatever is open on this rig before the first name is asked
    /// for, retrying a few times while the backend does not answer. Once the
    /// prompt has to show it shows anyway: this agent never stamps a lap with a
    /// stint it did not create, and the first check-in takes the seat over.
    /// Returns what the first sign-in screen should say about it.</summary>
    public static async Task<string?> EmptySeatAsync(AgentService agent, CancellationToken quit)
    {
        for (var attempt = 1; ; attempt++)
        {
            if (await agent.EmptySeatAsync().ConfigureAwait(false)) return null;
            if (attempt == EmptySeatAttempts)
                return "Could not reach the backend to clear this rig's seat; the first check-in will take it over.";
            try { await Task.Delay(EmptySeatRetryGap, quit).ConfigureAwait(false); }
            catch (OperationCanceledException) { return null; }
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
            await agent.SignOutSeatedDriverAsync().WaitAsync(ExitSignOutLimit).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Nothing more can be done on the way out; the next start covers it.
        }
    }
}
