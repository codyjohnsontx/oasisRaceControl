namespace OasisRigAgent.Core;

/// <summary>What the agent should do about the customer it believes is in the seat.</summary>
public enum IdleAction
{
    /// <summary>Somebody is driving, or nobody is checked in. Leave it alone.</summary>
    None,

    /// <summary>The rig is about to sign the driver out, and says so on its own
    /// screen while there is still time for them to do something about it.</summary>
    Warn,

    /// <summary>The seat has been empty long enough. End the check-in.</summary>
    EndSession,
}

/// <summary>One evaluation of the seat, plus the check-in it is about.</summary>
/// <param name="Action">What to do now.</param>
/// <param name="Remaining">How long is left before the check-in ends. Zero once it is due.</param>
/// <param name="AssignmentId">The check-in this verdict was reached about, or null when
/// there is none. Carried so the agent ends the session it actually judged rather than
/// whatever is open by the time the request lands - see <see cref="IdleWatch"/>.</param>
public readonly record struct IdleVerdict(IdleAction Action, TimeSpan Remaining, string? AssignmentId)
{
    public static readonly IdleVerdict Nothing = new(IdleAction.None, TimeSpan.Zero, null);
}

/// <summary>
/// Decides when a check-in has outlived the customer who made it.
///
/// The venue has no paid-time signal: staff sell time at the desk and nobody tells
/// this system when it runs out. So a customer who walks away without tapping
/// "sign out" leaves their name on the rig - and the next walk-in almost never
/// rescans a machine that already has a session loaded and a name on the screen.
/// Every lap they drive is then credited to the previous customer, on the phone,
/// the staff dashboard and the TV board. Nothing errors; the leaderboard is simply
/// somebody else's.
///
/// The signal that the seat is empty is the simulator itself, which this agent is
/// already reading: at Oasis a customer's session ends by closing iRacing, and a rig
/// sitting on the Windows desktop with a check-in still open is the shape of a
/// customer who has gone. That is deliberately the ONLY thing that counts as empty
/// here:
///
/// * <see cref="SimHealth.Scoring"/> - iRacing is up. Somebody is in the seat, even
///   if they are parked in the garage reading the setup screen for ten minutes.
/// * <see cref="SimHealth.Unreadable"/> - the agent cannot see the simulator (a
///   missing channel, or an agent Windows started where the sim's shared memory is
///   invisible to it). It has no idea whether anyone is driving, and a blind agent
///   that signs people out on a timer would empty the whole venue's check-ins in one
///   idle period. Silence is not evidence, so the countdown does not run.
/// * <see cref="SimHealth.NoSim"/> - iRacing is closed. This, continuously, for the
///   configured period, is the only thing that ends a session.
///
/// Timing is measured from a monotonic source supplied by the caller rather than the
/// wall clock, because these are venue PCs whose own clocks are already known to be
/// wrong (see <see cref="ServerClock"/>) and a clock correction must never be able to
/// sign a driver out mid-stint.
///
/// The verdict names the check-in it judged. Between deciding and the backend acting
/// there is a live rig and a queue of walk-ins: a new customer can scan the QR code
/// in that window, and ending "whatever is open" would sign out the person who just
/// sat down. The backend closes the named check-in or nothing.
/// </summary>
public sealed class IdleWatch
{
    private readonly TimeSpan _endAfter;
    private readonly TimeSpan _warnFor;

    private string? _assignmentId;
    private TimeSpan? _emptySince;

    /// <param name="endAfter">How long iRacing must stay closed with a check-in open
    /// before the check-in ends. Zero or less turns the whole behaviour off, which is
    /// what a venue that would rather clear rigs by hand sets.</param>
    /// <param name="warnFor">How much of the end of that period the rig spends warning
    /// on its own screen. Clamped into the period, so a warning longer than the period
    /// simply warns from the start rather than never.</param>
    public IdleWatch(TimeSpan endAfter, TimeSpan warnFor)
    {
        _endAfter = endAfter;
        _warnFor = warnFor < TimeSpan.Zero ? TimeSpan.Zero : warnFor;
    }

    public static IdleWatch From(AgentConfig config) => new(
        TimeSpan.FromSeconds(config.IdleTimeoutSeconds),
        TimeSpan.FromSeconds(config.IdleWarningSeconds));

    /// <summary>True when this rig will never sign a driver out on its own.</summary>
    public bool Disabled => _endAfter <= TimeSpan.Zero;

    /// <summary>How long iRacing stays closed before a check-in ends.</summary>
    public TimeSpan EndAfter => _endAfter;

    /// <summary>The period in the units somebody reading a rig's log thinks in. The
    /// venue runs minutes; a pilot tuning the value runs seconds.</summary>
    public static string Describe(TimeSpan period) => period.TotalSeconds < 60
        ? $"{(int)Math.Round(period.TotalSeconds)} second(s)"
        : $"{(int)Math.Round(period.TotalMinutes)} minute(s)";

    /// <param name="assignmentId">The check-in the agent currently believes is open,
    /// or null when the rig is available.</param>
    /// <param name="sim">What the agent can currently do with the simulator.</param>
    /// <param name="elapsed">A monotonic reading (e.g. <see cref="System.Diagnostics.Stopwatch.Elapsed"/>)
    /// that only ever moves forward while the agent runs.</param>
    public IdleVerdict Observe(string? assignmentId, SimHealth sim, TimeSpan elapsed)
    {
        // A different check-in is a different customer: whatever the last one was
        // doing says nothing about this one.
        if (assignmentId != _assignmentId)
        {
            _assignmentId = assignmentId;
            _emptySince = null;
        }

        if (assignmentId is null || Disabled) return IdleVerdict.Nothing;

        // Anything other than a closed simulator means the countdown is not running:
        // Scoring is somebody in the seat, Unreadable is an agent that cannot tell.
        if (sim != SimHealth.NoSim)
        {
            _emptySince = null;
            return IdleVerdict.Nothing;
        }

        // Never let the reading go backwards. A monotonic source will not do this on
        // its own, but restarting from a fresh one mid-life (or a host that hands us
        // the wrong thing) would otherwise leave a negative age that never expires.
        if (_emptySince is not { } since || elapsed < since)
        {
            _emptySince = elapsed;
            since = elapsed;
        }

        var empty = elapsed - since;
        if (empty >= _endAfter) return new IdleVerdict(IdleAction.EndSession, TimeSpan.Zero, assignmentId);

        var remaining = _endAfter - empty;
        return remaining <= _warnFor
            ? new IdleVerdict(IdleAction.Warn, remaining, assignmentId)
            : IdleVerdict.Nothing;
    }
}
