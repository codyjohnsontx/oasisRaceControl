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
        // Dispose(WaitHandle) blocks until in-flight timer callbacks finish, so
        // no lap can be emitted after Stop() returns.
        var timer = Interlocked.Exchange(ref _timer, null);
        if (timer is null) return;
        using var callbacksDone = new ManualResetEvent(false);
        if (timer.Dispose(callbacksDone)) callbacksDone.WaitOne();
    }

    private void EmitLap()
    {
        // Timer callbacks may overlap; the atomic counter keeps lap numbers —
        // and therefore event ids — unique even when the ms timestamp collides.
        var lapNumber = Interlocked.Increment(ref _lapNumber);
        var dirty = Random.Shared.NextDouble() < 0.15;
        var jitter = (int)((Random.Shared.NextDouble() - 0.35) * 2500);

        LapCompleted?.Invoke(new LapCompleted
        {
            EventId = $"sim-{Environment.MachineName}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{lapNumber}",
            TrackName = Track,
            TrackConfig = Config,
            CarName = Car,
            LapNumber = lapNumber,
            LapTimeMs = Math.Max(60_000, PaceMs + jitter + (dirty ? 4000 : 0)),
            IncidentDelta = dirty ? 1 : 0,
            CompletedAt = DateTimeOffset.UtcNow,
        });
    }
}
