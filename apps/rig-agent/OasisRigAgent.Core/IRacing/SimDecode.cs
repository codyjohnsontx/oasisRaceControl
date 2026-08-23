namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// Why this agent cannot decode the simulator's telemetry, in two lengths - the
/// same split, for the same reason, as <see cref="SimReachVerdict"/>.
///
/// <see cref="Summary"/> goes on the rig's status line and the staff dashboard's
/// rig card, where it sits beside the other reasons a rig is not scoring and has
/// to be readable at a glance across a room. <see cref="Instruction"/> goes in the
/// log and <c>--check-sim</c>, where somebody is reading deliberately because they
/// are fixing this machine.
/// </summary>
public sealed record SimDecodeVerdict(string Summary, string Instruction);

/// <summary>
/// Turns "this rig attached to iRacing and could not make sense of a single frame"
/// into something a person can act on.
///
/// Before this, that failure was the third way a rig could be up, healthy, and
/// scoring nothing while looking exactly like an idle machine between customers -
/// the same shape as a missing channel (<see cref="TelemetryChannels"/>) and an
/// agent Windows started out of reach of the sim (<see cref="SimReach"/>), both of
/// which are already reported. It went into the log every couple of seconds and
/// nowhere else, and the log is on the rig.
///
/// The case worth naming is a version bump. iRacing stamps a layout version on its
/// telemetry, the venue's twenty-plus machines take the same forced seasonal update
/// within a day of each other, and a build that moves that version moves every field
/// this agent reads. So the whole room stops scoring at once, for a reason no amount
/// of looking at any one machine reveals, and the fix is a new agent rather than
/// anything an operator can do at the rig. That deserves its own words rather than
/// the parser's internal complaint about a tick rate.
/// </summary>
public static class SimDecode
{
    /// <param name="failure">What the parser refused the frame with.</param>
    public static SimDecodeVerdict Explain(Exception failure) => failure switch
    {
        UnsupportedTelemetryFormatException format => new(
            $"iRacing on this rig publishes telemetry format {format.PublishedVersion}, and this agent "
            + $"reads format {format.SupportedVersion} - the agent needs updating",
            $"iRacing on this computer publishes its telemetry in layout version {format.PublishedVersion}. "
            + $"This agent was written against version {format.SupportedVersion} and will not guess at a "
            + "layout it does not know, because every reading it took from one would still look like a "
            + "plausible lap time. Nothing at this rig fixes it and every rig running this iRacing build "
            + "is in the same state: update the Oasis Rig Agent on the fleet."),
        _ => new(
            "iRacing is running on this rig but its telemetry could not be read at all",
            "iRacing is running and this agent attached to its telemetry, but no frame could be "
            + $"decoded from it: {failure.Message} Laps are being held back rather than guessed at. "
            + "Restart iRacing on this rig; if it comes back the same way, send logs\\agent.log on."),
    };
}
