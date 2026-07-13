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
    public required bool SimRunning { get; init; }
    public required int PendingLaps { get; init; }
}
