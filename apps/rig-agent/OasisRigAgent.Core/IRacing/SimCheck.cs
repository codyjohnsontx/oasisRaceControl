namespace OasisRigAgent.Core.IRacing;

/// <summary>The verdict of one <c>--check-sim</c> run.</summary>
public sealed record SimCheckResult(TelemetryChannelReport? Report, string Message, int ExitCode);

/// <summary>
/// Answers "will this computer score laps?" on the spot, for whoever is standing at
/// the rig.
///
/// The agent is installed on twenty-plus machines that nobody watches, and the way it
/// fails when a channel name is wrong is by scoring nothing while looking perfectly
/// healthy. Waiting for the leaderboard to look wrong is not a check. This one runs in
/// a few seconds against the sim actually installed on this machine, needs no config,
/// no backend, and no database, and reads only what the agent itself reads - so it can
/// be run on a rig with the agent already running, which is the normal state (it starts
/// with Windows).
///
/// It is the same code path the agent uses: one <see cref="IRacingTelemetrySource"/>
/// stepped until it has seen a frame. A pass here is evidence about the running agent,
/// not about a separate implementation of the same idea.
/// </summary>
public static class SimCheck
{
    /// <summary>Every channel a lap's validity turns on is readable.</summary>
    public const int Pass = 0;

    /// <summary>The sim is running but this rig cannot keep a lap from it.</summary>
    public const int ChannelsUnusable = 3;

    /// <summary>iRacing was not running, or its telemetry could not be opened.</summary>
    public const int SimNotFound = 4;

    /// <summary>
    /// This computer could not see the simulator from where the agent is running,
    /// whether or not iRacing is open.
    ///
    /// Separate from <see cref="SimNotFound"/> because they call for opposite actions:
    /// one is "start iRacing", the other is "the agent is installed wrong and no amount
    /// of starting iRacing will fix it". They are otherwise identical from the rig -
    /// the mapping's name simply does not resolve - which is why this exit code exists.
    /// </summary>
    public const int SimOutOfReach = 5;

    /// <summary>
    /// iRacing is running and this agent attached to its telemetry, but could not
    /// decode a frame from it - most usefully, because the simulator publishes a
    /// layout version this agent was not written to read.
    ///
    /// Separate from <see cref="SimNotFound"/> because the two send an operator in
    /// opposite directions: that one means "start iRacing", and iRacing is already
    /// running here. Separate from <see cref="ChannelsUnusable"/> because that one is
    /// about which channels this sim publishes, and nothing here got far enough to
    /// have an opinion about a channel.
    /// </summary>
    public const int SimUnreadable = 6;

    private static readonly TimeSpan Poll = TimeSpan.FromMilliseconds(250);

    /// <param name="connections">How to attach to the sim.</param>
    /// <param name="patience">How long to wait for a frame before giving up. A sim
    /// sitting in a menu publishes nothing, which is not a fault - it is a "start a
    /// session first".</param>
    /// <param name="clock">Pinned by tests.</param>
    /// <param name="wait">How to pass time between attempts. Pinned by tests.</param>
    public static SimCheckResult Run(
        ISimConnectionFactory connections,
        TimeSpan patience,
        Func<DateTimeOffset>? clock = null,
        Action<TimeSpan>? wait = null)
    {
        var now = clock ?? (() => DateTimeOffset.UtcNow);
        var pause = wait ?? Thread.Sleep;
        var deadline = now() + patience;

        using var source = new IRacingTelemetrySource(0, connections, now, "check");
        Exception? lastFault = null;
        source.Faulted += ex => lastFault = ex;

        while (now() < deadline)
        {
            try { source.Step(); }
            catch (Exception ex) { lastFault = ex; }

            if (source.Channels is { } report)
            {
                return report.CanScore
                    ? new SimCheckResult(report, report.Describe(), Pass)
                    : new SimCheckResult(report, report.Describe(), ChannelsUnusable);
            }

            // Asked before the deadline for the same reason as an out-of-reach sim:
            // this rig attached and could not decode what it found, and reading the
            // same layout for another fifteen seconds cannot change that. Asked after
            // the channel report so a rig that is reading its sim has already passed.
            if (source.UndecodableReason is { } undecodable)
            {
                return new SimCheckResult(
                    null,
                    $"Simulator telemetry check: UNREADABLE - {undecodable.Instruction}",
                    SimUnreadable);
            }

            // Asked only after an attempt that did not attach, so a rig reading its
            // sim has already answered above and this can never withhold a pass.
            // Answered immediately rather than at the deadline, because waiting
            // cannot change it: the agent is somewhere the sim's telemetry has no
            // name, and it will still be there in fifteen seconds.
            if (connections.UnreachableReason is { } unreachable)
            {
                return new SimCheckResult(
                    null,
                    $"Simulator telemetry check: OUT OF REACH - {unreachable.Instruction}",
                    SimOutOfReach);
            }

            pause(Poll);
        }

        var why = lastFault is null
            ? "No telemetry from iRacing. Start iRacing and get into a session (any car, any track), then run this again."
            : $"Could not read iRacing's telemetry: {lastFault.Message}";
        return new SimCheckResult(null, $"Simulator telemetry check: NO SIM - {why}", SimNotFound);
    }
}
