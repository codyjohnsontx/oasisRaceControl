namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// Why this agent could not see the simulator, in two lengths.
///
/// <see cref="Summary"/> goes where there is a line: the rig's own status and the
/// staff dashboard's rig card, beside "the simulator does not publish OnPitRoad"
/// and in the same register. It has to be readable at a glance across a room, so
/// it names the situation and nothing else.
///
/// <see cref="Instruction"/> goes where there is room to read: the rig's log and
/// <c>--check-sim</c>, both of which somebody is looking at deliberately because
/// they are fixing this machine. That is where the whole explanation and the fix
/// belong.
/// </summary>
public sealed record SimReachVerdict(string Summary, string Instruction);

/// <summary>
/// Whether this agent is in a position to see iRacing at all, and what to tell
/// whoever installed it when it is not.
///
/// iRacing publishes its telemetry into <c>Local\IRSDKMemMapFileName</c>. The
/// <c>Local\</c> prefix is not decoration: it scopes the mapping to the Windows
/// terminal-services session that created it, so the name only resolves for a
/// process running in that same session. iRacing needs a desktop, so it always
/// runs in the signed-in user's session (1, 2, ...) and never in session 0.
///
/// That makes one install choice fatal and silent. A Windows Service, and a
/// scheduled task set to <i>run whether the user is logged on or not</i>, both run
/// in session 0. From there the mapping's name does not resolve, the open fails
/// with "file not found", and the agent reports exactly what it reports between
/// customers: no sim. The rig heartbeats all night, shows online, and scores
/// nothing - on every machine installed that way, which is the whole fleet if it
/// is how the install was written down.
///
/// So the ordinary "iRacing is closed" answer has to be separated from "this agent
/// could not see iRacing if it were open", and the second one has to say what to do.
/// The rule is here, apart from the Windows call that observes it, so it is decided
/// in one place and tested on any machine.
///
/// It can only ever explain a failure to attach - <see cref="ISimConnectionFactory"/>
/// consults it after a null, never before - so nothing here can hold back a lap on a
/// rig that is reading its sim.
/// </summary>
public static class SimReach
{
    /// <summary>
    /// The Windows session services and non-interactive scheduled tasks run in.
    /// Interactive sessions have been numbered from 1 since Windows Vista, so this
    /// is not a heuristic: a process here has no signed-in user's namespace to read.
    /// </summary>
    public const int ServicesSession = 0;

    /// <summary>The agent is running where iRacing's telemetry has no name.</summary>
    public static readonly SimReachVerdict WrongSession = new(
        "this agent was started outside the rig's signed-in Windows session (it is in session 0), "
        + "where iRacing's telemetry cannot be opened",
        "This agent is running in Windows session 0 - as a service, or as a task set to run whether "
        + "the user is logged on or not. iRacing publishes telemetry into the signed-in user's own "
        + "session, and session 0 cannot open it, so this rig will never score however long iRacing "
        + "is left running. Start the agent in the rig's own signed-in session: a logon task set to "
        + "run only when the user is logged on, not a service.");

    /// <summary>The mapping is there and this account is not allowed to read it.</summary>
    public static readonly SimReachVerdict WrongAccount = new(
        "this agent is running as a different Windows user than iRacing, which may not read the "
        + "simulator's telemetry",
        "iRacing's telemetry is published on this computer, but the Windows account running this "
        + "agent is not permitted to open it. Run the agent as the same user that runs iRacing.");

    /// <summary>
    /// Why nothing attached, when the answer is something other than "iRacing is
    /// closed" - which is the answer most of the day on most of the fleet, and is
    /// reported as null.
    ///
    /// Session 0 is decided first because it is the root cause and it makes the
    /// second observation impossible: from there the name does not resolve at all,
    /// so the open fails as "not found" rather than as "denied", and an agent that
    /// blamed the account would send somebody to change a password.
    /// </summary>
    /// <param name="windowsSession">The session Windows is running this agent in.</param>
    /// <param name="openWasDenied">Whether the last attempt to open the sim's memory
    /// failed because this account is not permitted to read it.</param>
    public static SimReachVerdict? Explain(int windowsSession, bool openWasDenied) =>
        windowsSession == ServicesSession ? WrongSession
        : openWasDenied ? WrongAccount
        : null;
}
