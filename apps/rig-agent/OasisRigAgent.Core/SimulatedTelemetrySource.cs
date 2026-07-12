namespace OasisRigAgent.Core;

/// <summary>
/// Emits fake laps on a timer so the agent can be exercised end-to-end without
/// iRacing (the .NET equivalent of the web repo's fake-rig.ts). Not used in
/// production — selected only when AgentConfig.SimulateTelemetry is set.
/// </summary>
public sealed class SimulatedTelemetrySource : ITelemetrySource
{
    private const string Track = "Spa-Francorchamps";
    private const string Config = "Grand Prix Pits";
    private const string Car = "Porsche 911 GT3 R";
    private const int PaceMs = 138_200;

    private readonly TimeSpan _interval;
    private readonly Random _random = new();
    private Timer? _timer;
    private int _lapNumber;

    public SimulatedTelemetrySource(TimeSpan? interval = null)
        => _interval = interval ?? TimeSpan.FromSeconds(20);

    public bool SimRunning => _timer is not null;
    public event Action<LapCompleted>? LapCompleted;

    public void Start()
    {
        _timer ??= new Timer(_ => EmitLap(), null, _interval, _interval);
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
    }

    private void EmitLap()
    {
        _lapNumber++;
        var dirty = _random.NextDouble() < 0.15;
        var jitter = (int)((_random.NextDouble() - 0.35) * 2500);

        LapCompleted?.Invoke(new LapCompleted
        {
            EventId = $"sim-{Environment.MachineName}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{_lapNumber}",
            TrackName = Track,
            TrackConfig = Config,
            CarName = Car,
            LapNumber = _lapNumber,
            LapTimeMs = Math.Max(60_000, PaceMs + jitter + (dirty ? 4000 : 0)),
            IncidentDelta = dirty ? 1 : 0,
            CompletedAt = DateTimeOffset.UtcNow,
        });
    }
}
