namespace OasisRigAgent.Core;

/// <summary>
/// A completed lap detected by a telemetry source, before it is queued.
///
/// PROVISIONAL CONTRACT: mirrors the backend's LAP_COMPLETED event
/// (apps/web/src/lib/events.ts). Field details may change when the Phase 1
/// iRacing spike findings land; the real telemetry source is built against the
/// frozen version.
/// </summary>
public sealed record LapCompleted
{
    public required string EventId { get; init; }
    public required string TrackName { get; init; }
    public string? TrackConfig { get; init; }
    public required string CarName { get; init; }
    public int? LapNumber { get; init; }
    public required int LapTimeMs { get; init; }
    public int? IncidentDelta { get; init; }

    /// <summary>
    /// Whether the car's own tyres left the racing surface at any point during this
    /// lap, watched frame by frame across the whole lap (iRacing's
    /// <c>PlayerTrackSurface</c>).
    ///
    /// Reported alongside <see cref="IncidentDelta"/> rather than folded into it,
    /// because the sim does not charge a point for every off - running wide at the
    /// fastest corner on the track routinely comes back 0x - and the venue's rule
    /// invalidates a lap for going off. Keeping the two apart leaves the incident
    /// count the sim's own number and leaves the backend
    /// (<c>apps/web/src/lib/validity.ts</c>) the single owner of what invalidates a
    /// lap. The agent reports what it saw; it does not judge.
    /// </summary>
    public bool OffTrackSeen { get; init; }

    public required DateTimeOffset CompletedAt { get; init; }
}

/// <summary>The rig's current driver assignment, as reported by the backend.</summary>
public sealed record Assignment(string Id, string DriverId, string DriverDisplayName, DateTimeOffset StartedAt);

/// <summary>Whether the agent can currently reach the backend.</summary>
public enum ConnectionState
{
    Connecting,
    Online,
    Offline,
}

/// <summary>
/// What this rig can currently do with its simulator.
///
/// Mirrors the backend's heartbeat contract (apps/web/src/lib/events.ts); the wire
/// spelling is <see cref="SimHealthReading.WireName"/>. The distinction that matters
/// is <see cref="Unreadable"/> versus <see cref="NoSim"/>: both produce no laps, but
/// one is a machine somebody has to walk over to and the other is most of the room
/// most of the day.
/// </summary>
public enum SimHealth
{
    /// <summary>Nothing to read - iRacing is closed, loading, or in a menu.</summary>
    NoSim,

    /// <summary>iRacing is running but a lap from it could not be judged, so the agent
    /// is keeping laps back rather than publishing times it cannot vouch for.</summary>
    Unreadable,

    /// <summary>iRacing is running and every channel a lap's validity turns on is
    /// readable - a lap driven now would be scored.</summary>
    Scoring,
}

/// <summary>The one rule that turns what a telemetry source reports into a rig's
/// simulator health, so the rig's own screen and the staff dashboard cannot
/// disagree about whether this machine is fine.</summary>
public static class SimHealthReading
{
    /// <param name="simRunning"><see cref="ITelemetrySource.SimRunning"/>.</param>
    /// <param name="unusableReason"><see cref="ITelemetrySource.SimUnusableReason"/>.</param>
    public static SimHealth Of(bool simRunning, string? unusableReason)
    {
        // Checked before SimRunning, not after: a source that cannot judge a lap
        // reports the sim as not running (it will produce nothing), so reading
        // SimRunning first would file a broken rig as an idle one - which is the
        // whole failure this reading exists to separate.
        if (!string.IsNullOrWhiteSpace(unusableReason)) return SimHealth.Unreadable;
        return simRunning ? SimHealth.Scoring : SimHealth.NoSim;
    }

    /// <summary>The spelling the backend's contract accepts.</summary>
    public static string WireName(this SimHealth health) => health switch
    {
        SimHealth.Scoring => "scoring",
        SimHealth.Unreadable => "unreadable",
        SimHealth.NoSim => "no_sim",
        _ => throw new ArgumentOutOfRangeException(nameof(health), health, "Unknown simulator health."),
    };
}

/// <summary>Snapshot of agent state for the UI to render.</summary>
public sealed record AgentStatus
{
    public required int RigNumber { get; init; }
    public required ConnectionState Connection { get; init; }
    public Assignment? Assignment { get; init; }
    public required bool SimRunning { get; init; }
    public required int PendingLaps { get; init; }

    /// <summary>Laps this rig gave up on because the backend refused to parse
    /// them. Any number above zero means this machine needs looking at — it is
    /// not a queue that will drain on its own.</summary>
    public int QuarantinedLaps { get; init; }

    /// <summary>Set when the simulator is running but this rig cannot keep a lap from
    /// it — the other thing that means this machine needs looking at, and the one that
    /// otherwise looks identical to a quiet rig.</summary>
    public string? SimUnusableReason { get; init; }

    /// <summary>How far this machine's own clock is from the backend's, as last
    /// measured (see <see cref="ServerClock"/>). Zero on a healthy rig. Laps are
    /// already corrected by it, so this is a maintenance fact rather than a lost
    /// lap — but it is the only place the machine says its clock is wrong.</summary>
    public TimeSpan ClockOffset { get; init; }

    /// <summary>
    /// Set when the backend answered and would not accept this rig's identity
    /// (<see cref="BackendReach.Refused"/>), which the rig otherwise reports as
    /// being offline - the same word it uses for a dropped network, and the one
    /// failure of the two that no amount of waiting fixes.
    ///
    /// Nullable rather than a third <see cref="ConnectionState"/> for the same
    /// reason <see cref="SimUnusableReason"/> sits beside <see cref="SimRunning"/>:
    /// the plain state is still true (nothing is getting through) and this is the
    /// reason for it.
    /// </summary>
    public string? BackendRefusal { get; init; }

    /// <summary>
    /// Set when this computer is not the rig it was installed as: its token belongs
    /// to another one (<see cref="RigIdentity"/>). Distinct from
    /// <see cref="BackendRefusal"/> because nothing here is refused - the token
    /// works, and that is the problem. The rig holds its laps rather than scoring
    /// them onto somewhere else in the room, so this is "somebody has to walk back
    /// to this machine", not "laps are being lost".
    /// </summary>
    public string? WrongRig { get; init; }

    /// <summary>True while the backend is refusing to credit this rig's laps
    /// because a second computer is using the same rig token. The laps stay
    /// queued and deliver themselves once each rig has its own token, so this is
    /// "somebody has to fix the config", not "laps are being lost".</summary>
    public bool RigTokenShared { get; init; }

    /// <summary>
    /// How long until this rig signs the checked-in customer out because iRacing has
    /// been closed the whole time (see <see cref="IdleWatch"/>). Null except in the
    /// last stretch before it happens, which is the only time anybody needs to know:
    /// a customer still at the machine restarts the sim and keeps their session.
    /// </summary>
    public TimeSpan? IdleSignOutIn { get; init; }

    /// <summary>The same reading the heartbeat carries to the staff dashboard.</summary>
    public SimHealth Sim => SimHealthReading.Of(SimRunning, SimUnusableReason);
}
