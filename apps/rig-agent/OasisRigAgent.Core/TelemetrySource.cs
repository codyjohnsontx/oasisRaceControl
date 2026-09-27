namespace OasisRigAgent.Core;

/// <summary>
/// Source of completed-lap events. Three implementations, chosen by
/// AgentConfig.TelemetryMode: Iracing.IracingTelemetrySource reads the sim's
/// shared memory on the rig PC, SimulatedTelemetrySource emits fake laps for
/// end-to-end testing, and NullTelemetrySource produces none (heartbeat and
/// driver display only).
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

/// <summary>No telemetry: reports the sim as not running and never produces
/// laps. The agent still heartbeats, shows the driver and drains its outbox.</summary>
public sealed class NullTelemetrySource : ITelemetrySource
{
    public bool SimRunning => false;
    public event Action<LapCompleted>? LapCompleted;
    public void Start() { }
    public void Stop() { _ = LapCompleted; }
}
