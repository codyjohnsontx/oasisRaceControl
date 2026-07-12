namespace OasisRigAgent.Core;

/// <summary>
/// Source of completed-lap events. The real iRacing implementation is built
/// after the Phase 1 spike freezes which telemetry fields are available
/// (docs/spike-findings.md). Until then the agent uses NullTelemetrySource
/// (no laps) or SimulatedTelemetrySource (fake laps, for end-to-end testing).
/// </summary>
public interface ITelemetrySource
{
    /// <summary>True when the sim (iRacing) is running. Drives the "sim status"
    /// shown on the rig and the staff dashboard.</summary>
    bool SimRunning { get; }

    /// <summary>Raised when a lap is completed. The agent queues it immediately.</summary>
    event Action<LapCompleted>? LapCompleted;

    void Start();
    void Stop();
}

/// <summary>Real-telemetry placeholder: reports the sim as not running and never
/// produces laps. Swapped for the iRacing SDK source after the spike.</summary>
public sealed class NullTelemetrySource : ITelemetrySource
{
    public bool SimRunning => false;
    public event Action<LapCompleted>? LapCompleted;
    public void Start() { }
    public void Stop() { _ = LapCompleted; }
}
