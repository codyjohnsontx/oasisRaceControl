using OasisRigAgent.Core;

namespace OasisRigAgent;

/// <summary>
/// The walk-up loop on the rig PC: ask for a name, sign that person in on this
/// rig, let them drive while laps post under their name, and when they press
/// Enter sign them out and ask for the next name. The owner's words: "the user
/// types their name and then as they make laps it assigns it accordingly. When
/// they are done, they just exit out the program and then it waits for the next
/// person."
///
/// Sign-in goes through the backend's existing guest and check-in routes
/// (<see cref="DriverCheckInClient"/>); sign-out is the agent's own
/// switch-driver, which ends the stint locally at once and delivers the
/// checkout durably. Closing the window signs out on a best-effort basis; if
/// that delivery never lands, the next name's check-in takes the seat over
/// and ends the old stint anyway.
/// </summary>
internal static class DriverPrompt
{
    public static async Task RunAsync(AgentService agent, DriverCheckInClient checkIn, CancellationToken quit)
    {
        while (!quit.IsCancellationRequested)
        {
            Console.WriteLine();
            Console.WriteLine("Type your name and press Enter:");
            var typed = await ReadLineAsync(quit);
            if (typed is null) return;
            var name = typed.Trim();
            if (name.Length == 0) continue;

            DriverCheckIn session;
            try
            {
                session = await checkIn.CheckInAsync(name, quit);
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

            // The poll loop would learn about this stint within ten seconds; a
            // lap driven before then must not be stamped with the old answer.
            await agent.PollAssignmentNowAsync();

            Console.WriteLine(session.Renamed
                ? $"\"{name}\" was taken tonight, so you are driving as {session.DisplayName}."
                : $"Driving as {session.DisplayName}.");
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

    /// <summary>Best-effort sign-out when the program is closing (Ctrl+C, the
    /// window's close button, a console shutdown): end whatever stint is open
    /// here, bounded so a backend that does not answer cannot hold the window
    /// open. The stint ends locally regardless, and a delivery that never lands
    /// is finished by the next name's takeover.</summary>
    public static async Task SignOutOnExitAsync(AgentService agent)
    {
        try
        {
            await agent.SwitchDriverAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception)
        {
            // Nothing more can be done on the way out; the takeover covers it.
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
