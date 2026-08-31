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

    /// <summary>Laps the outbox is holding that it still intends to send.</summary>
    public required int PendingLaps { get; init; }

    /// <summary>Laps the backend refused as invalid input. They are held, not
    /// sent and not thrown away, so they are counted apart from the ones still
    /// going: rolling them into <see cref="PendingLaps"/> would leave the rig
    /// reading "n lap(s) queued" forever, which is what it read while one
    /// rejected lap was blocking the whole outbox.</summary>
    public int RejectedLaps { get; init; }

    /// <summary>What the rig still owes the backend for a switch-driver it
    /// could not deliver. The seat is already empty here in every case; this
    /// says only what the backend has yet to hear, and whether this rig will
    /// still be able to tell it after a restart.</summary>
    public CheckoutDelivery Checkout { get; init; }
}

/// <summary>Whether a sign-out the backend has not received yet is one this rig
/// can still deliver.
///
/// Three answers rather than two, because "outstanding" and "outstanding and
/// survivable" are different promises and the display makes one of them to
/// staff all night. Collapsing them puts the persistent status line at odds
/// with what the driver was told at the press.</summary>
public enum CheckoutDelivery
{
    /// <summary>Nothing is owed: either the backend has it, or the press had no
    /// stint to name in the first place.</summary>
    None,

    /// <summary>Recorded in the outbox, so it outlives this process and is
    /// re-sent until the backend accounts for it.</summary>
    Queued,

    /// <summary>Outstanding, but only in this process - the outbox write
    /// failed. The retry runs for as long as the agent does, so it is shown
    /// rather than hidden; a restart before the link returns loses it, so the
    /// rig has to be cleared from the staff screen instead.</summary>
    NotQueued,
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

    /// <summary>The backend could not be reached and nothing durable was
    /// recorded to tell it later - either this agent has no stint to name, or
    /// the outbox write failed. The seat is empty here and laps arrive
    /// unclaimed, but nothing guarantees the stint the backend still holds open
    /// will ever be closed, so it has to be cleared from the staff screen.</summary>
    EndedNotQueued,
}
