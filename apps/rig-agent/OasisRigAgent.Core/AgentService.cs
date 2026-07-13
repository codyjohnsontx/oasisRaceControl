namespace OasisRigAgent.Core;

/// <summary>
/// Orchestrates the rig agent: queues detected laps, and runs the three
/// background loops — heartbeat, assignment poll, and queue flush. Exposes a
/// single StatusChanged event the UI renders. All backend calls funnel through
/// RunBackend so one place owns the online/offline state transition.
/// </summary>
public sealed class AgentService : IAsyncDisposable
{
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(5);
    private const int FlushBatchSize = 50;

    private readonly AgentConfig _config;
    private readonly BackendClient _client;
    private readonly EventQueue _queue;
    private readonly ITelemetrySource _telemetry;
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _loops = new();

    private ConnectionState _connection = ConnectionState.Connecting;
    private Assignment? _assignment;

    public event Action<AgentStatus>? StatusChanged;

    public AgentService(AgentConfig config, BackendClient client, EventQueue queue, ITelemetrySource telemetry)
    {
        _config = config;
        _client = client;
        _queue = queue;
        _telemetry = telemetry;
    }

    public void Start()
    {
        // A detected lap is durably queued before anything else can go wrong.
        // The handler runs on the telemetry source's timer thread, so a queue
        // failure must be contained here — an escaped exception would kill the
        // process, not just drop the lap.
        _telemetry.LapCompleted += lap =>
        {
            try
            {
                _queue.Enqueue(lap);
                PublishStatus();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[agent] failed to queue lap {lap.EventId}: {ex.Message}");
            }
        };
        _telemetry.Start();

        _loops.Add(RunLoop(HeartbeatInterval, HeartbeatTick, runImmediately: true));
        _loops.Add(RunLoop(PollInterval, PollAssignmentTick, runImmediately: true));
        _loops.Add(RunLoop(FlushInterval, FlushQueueTick, runImmediately: true));
        PublishStatus();
    }

    /// <summary>The "switch driver" action: end the current assignment.</summary>
    public async Task<bool> SwitchDriverAsync()
    {
        var ended = await RunBackend(ct => _client.CheckoutAsync(ct));
        if (ended)
        {
            _assignment = null;
            PublishStatus();
        }
        return ended;
    }

    private async Task HeartbeatTick(CancellationToken ct)
        => await RunBackend(async token =>
        {
            await _client.HeartbeatAsync(_config.AgentVersion, token);
            return true;
        });

    private async Task PollAssignmentTick(CancellationToken ct)
    {
        // Success must come from this poll's own result — _connection is shared
        // with the heartbeat/flush loops, so it can flip between our call and
        // this check (e.g. clearing the assignment because a heartbeat failed).
        var poll = await RunBackend(async token => (Ok: true, Assignment: await _client.GetAssignmentAsync(token)));
        if (poll.Ok)
        {
            _assignment = poll.Assignment;
            PublishStatus();
        }
    }

    private async Task FlushQueueTick(CancellationToken ct)
    {
        var batch = _queue.PendingBatch(FlushBatchSize);
        if (batch.Count == 0) return;

        var settled = await RunBackend(token => _client.SendLapsAsync(batch, token));
        if (settled is { Count: > 0 })
        {
            _queue.Remove(settled);
            PublishStatus();
        }
    }

    /// <summary>Runs a backend call, flipping connection state on success/failure.
    /// Returns default(T) if the call throws (offline) — callers must treat that
    /// as "no update".</summary>
    private async Task<T?> RunBackend<T>(Func<CancellationToken, Task<T>> call)
    {
        try
        {
            var result = await call(_cts.Token);
            SetConnection(ConnectionState.Online);
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            SetConnection(ConnectionState.Offline);
            return default;
        }
    }

    private async Task RunLoop(TimeSpan interval, Func<CancellationToken, Task> tick, bool runImmediately)
    {
        if (runImmediately && !await RunTick(tick)) return;
        using var timer = new PeriodicTimer(interval);
        try
        {
            while (await timer.WaitForNextTickAsync(_cts.Token))
            {
                if (!await RunTick(tick)) return;
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>A failed tick must never kill its loop — RunBackend absorbs
    /// backend errors, but local failures (e.g. the SQLite outbox) would
    /// otherwise silently end heartbeats/polls/flushes for good. Returns false
    /// only on cancellation.</summary>
    private async Task<bool> RunTick(Func<CancellationToken, Task> tick)
    {
        try
        {
            await tick(_cts.Token);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[agent] tick failed: {ex.Message}");
            return true;
        }
    }

    private void SetConnection(ConnectionState state)
    {
        if (_connection == state) return;
        _connection = state;
        PublishStatus();
    }

    private void PublishStatus()
    {
        StatusChanged?.Invoke(new AgentStatus
        {
            RigNumber = _config.RigNumber,
            Connection = _connection,
            Assignment = _assignment,
            SimRunning = _telemetry.SimRunning,
            PendingLaps = _queue.PendingCount(),
        });
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync();
        _telemetry.Stop();
        foreach (var loop in _loops)
        {
            try { await loop; } catch { /* shutting down */ }
        }
        _cts.Dispose();
    }
}
