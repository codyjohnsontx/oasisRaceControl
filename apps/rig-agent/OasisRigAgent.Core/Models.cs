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
    public required DateTimeOffset CompletedAt { get; init; }
}

/// <summary>The rig's current driver assignment, as reported by the backend.</summary>
public sealed record Assignment(string Id, string DriverId, string DriverDisplayName, DateTimeOffset StartedAt);

/// <summary>
/// What one assignment poll learned: the rig's assignment (null if nobody is
/// checked in), and how far this machine's clock sits from the server's.
///
/// The offset exists because attribution compares two timestamps that come from
/// DIFFERENT machines - a lap's completedAt is stamped by the rig, an
/// assignment's StartedAt by the server - and a rig clock that drifts a few
/// minutes would otherwise decide a lap was driven on the wrong side of a
/// check-in. Adding this to a rig timestamp puts it in server time, so the
/// comparison happens within one clock. It is measured from the response's
/// Date header, so it costs no extra call and no wire change.
/// </summary>
public sealed record AssignmentPoll(Assignment? Assignment, TimeSpan ServerClockOffset);

/// <summary>Whether the agent can currently reach the backend.</summary>
public enum ConnectionState
{
    Connecting,
    Online,
    Offline,
}

/// <summary>Snapshot of agent state for the UI to render.</summary>
public sealed record AgentStatus
{
    public required int RigNumber { get; init; }
    public required ConnectionState Connection { get; init; }
    public Assignment? Assignment { get; init; }

    /// <summary>Whether an assignment poll has ever come back. Until it has, a
    /// null <see cref="Assignment"/> means "the agent has not managed to ask",
    /// not "nobody is checked in" - the same distinction a lap's stamp turns
    /// on, so the display must not claim the rig is free either.</summary>
    public required bool AssignmentKnown { get; init; }
    public required bool SimRunning { get; init; }
    public required int PendingLaps { get; init; }

    /// <summary>Whether a switch-driver the backend could not be told about is
    /// still waiting to be delivered. The seat is already empty here either way;
    /// this only says the backend has yet to agree.</summary>
    public bool CheckoutPending { get; init; }
}

/// <summary>What the "switch driver" action achieved. The stint is over locally
/// in every case - they differ only in what the backend now knows, and in
/// whether it will ever be told.</summary>
public enum SwitchDriverResult
{
    /// <summary>The backend closed the assignment.</summary>
    Ended,

    /// <summary>The backend had nothing open on this rig to close.</summary>
    NoActiveSession,

    /// <summary>The backend could not be reached. The stint ended here and the
    /// checkout is queued; until it lands, laps on this rig carry no owner and
    /// arrive as unclaimed rather than under the departed driver's name.</summary>
    EndedPendingSync,

    /// <summary>The backend could not be reached and this agent has no stint to
    /// name, so nothing was queued and nothing will be delivered later. The seat
    /// is empty here and laps arrive unclaimed, but a stint the backend still
    /// holds open on this rig can now only be closed from the staff screen.</summary>
    EndedNotQueued,
}
