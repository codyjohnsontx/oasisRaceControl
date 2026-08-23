using System.Runtime.Versioning;
using OasisRigAgent.Core.IRacing;

namespace OasisRigAgent.Core;

/// <summary>
/// Source of completed-lap events. The venue runs
/// <see cref="IRacingTelemetrySource"/>, which reads the live simulator;
/// <see cref="SimulatedTelemetrySource"/> emits fake laps for exercising the
/// backend end to end, and <see cref="NullTelemetrySource"/> reports no sim at
/// all (what a development machine that is not a rig has).
/// </summary>
public interface ITelemetrySource
{
    /// <summary>True when the sim (iRacing) is running. Drives the "sim status"
    /// shown on the rig and the staff dashboard.</summary>
    bool SimRunning { get; }

    /// <summary>
    /// Why this rig is not scoring, when that is something other than "the sim is
    /// closed". Null whenever there is nothing to say, which is almost always.
    ///
    /// A rig that reads the sim but cannot keep a lap from it - or cannot decode what
    /// the sim publishes at all - looks exactly like a rig between customers, and
    /// across twenty-plus machines that is the failure nobody notices until the
    /// leaderboard is visibly wrong. So the reason travels with the status rather than
    /// only into a log file on the machine itself.
    /// </summary>
    string? SimUnusableReason => null;

    /// <summary>Raised when a lap is completed. The agent queues it immediately.</summary>
    event Action<LapCompleted>? LapCompleted;

    void Start();
    void Stop();
}

/// <summary>Reports the sim as not running and never produces laps. Used where
/// there is no simulator to read: a developer machine, or any non-Windows host.</summary>
public sealed class NullTelemetrySource : ITelemetrySource
{
    public bool SimRunning => false;
    public event Action<LapCompleted>? LapCompleted;
    public void Start() { }
    public void Stop() { _ = LapCompleted; }
}

/// <summary>Chooses the telemetry source this machine can actually run.</summary>
public static class TelemetrySources
{
    /// <summary>
    /// The live iRacing source on a rig, and nothing on anything else.
    ///
    /// The rigs are Windows, and reading the sim means opening a Windows mapping;
    /// a developer working on the agent from another platform gets a source that
    /// honestly reports no sim rather than a startup crash. Fake laps stay an
    /// explicit choice (<see cref="AgentConfig.SimulateTelemetry"/>) so a rig can
    /// never quietly publish invented times to the leaderboard.
    /// </summary>
    public static ITelemetrySource CreateLive(
        int rigNumber,
        Action<LapDetection>? onLapRejected = null,
        Action<Exception>? onFaulted = null,
        Action<TelemetryChannelReport>? onChannelsChecked = null,
        Action<SimReachVerdict?>? onSimUnreachable = null,
        Action<SimDecodeVerdict?>? onSimUndecodable = null)
    {
        if (!OperatingSystem.IsWindows()) return new NullTelemetrySource();
        return CreateWindows(
            rigNumber, onLapRejected, onFaulted, onChannelsChecked, onSimUnreachable, onSimUndecodable);
    }

    [SupportedOSPlatform("windows")]
    private static ITelemetrySource CreateWindows(
        int rigNumber,
        Action<LapDetection>? onLapRejected,
        Action<Exception>? onFaulted,
        Action<TelemetryChannelReport>? onChannelsChecked,
        Action<SimReachVerdict?>? onSimUnreachable,
        Action<SimDecodeVerdict?>? onSimUndecodable)
    {
        var source = new IRacingTelemetrySource(rigNumber, new WindowsSimConnectionFactory());
        if (onLapRejected is not null) source.LapRejected += onLapRejected;
        if (onFaulted is not null) source.Faulted += onFaulted;
        if (onChannelsChecked is not null) source.ChannelsChecked += onChannelsChecked;
        if (onSimUnreachable is not null) source.SimReachChanged += onSimUnreachable;
        if (onSimUndecodable is not null) source.SimDecodeChanged += onSimUndecodable;
        return source;
    }
}
