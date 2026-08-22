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

    // Written by the assignment poll and by SwitchDriverAsync, read by the
    // telemetry thread when it stamps a lap. volatile so a captured lap is
    // stamped against a current view of the assignment, not a cached one.
    private volatile Assignment? _assignment;

    // False until a poll has actually come back. A null _assignment only means
    // "nobody is checked in" once this is true; before that it means the agent
    // has never managed to ask, which is a different answer and must not be
    // stamped onto a lap as if it were the same one.
    private volatile bool _hasPolled;

    // Orders "decide this lap's stamp" against "resolve the laps captured
    // before the first poll", so a lap enqueued unresolved can never land just
    // after the resolution pass that would have stamped it and sit unsendable
    // for the rest of the night.
    private readonly object _stampLock = new();

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
                // Who was in the seat NOW. The lap may sit in the outbox through
                // a network outage and arrive long after this driver has left, so
                // the owner has to be decided here; the backend deliberately will
                // not re-derive it from whoever is checked in when the batch
                // lands.
                //
                // Unless the agent has never reached the backend - a rig PC that
                // rebooted during an outage while a driver was checked in from
                // their phone. It has no answer to stamp, and stamping null
                // would assert the rig was empty, permanently unattributing laps
                // that have a driver. Those laps wait unresolved for the first
                // poll that gets through.
                lock (_stampLock)
                {
                    if (_hasPolled) _queue.Enqueue(lap, _assignment?.Id);
                    else _queue.EnqueueUnresolved(lap);
                }
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
        var poll = await RunBackend(async token => (Ok: true, Poll: await _client.GetAssignmentAsync(token)));
        if (!poll.Ok) return;
        var assignment = poll.Poll!.Assignment;

        lock (_stampLock)
        {
            // The first answer the agent has ever had also settles every lap it
            // captured before it had one. The whole assignment goes in, not just
            // its id: a lap driven before this driver checked in belongs to
            // nobody, and only its own completedAt can say which side of that
            // line it falls on. Resolving before publishing the new assignment
            // means anything that observes _assignment is already looking at an
            // outbox whose backlog has been stamped.
            if (!_hasPolled)
            {
                // The offset comes from this same response, so the comparison
                // inside runs in server time even on a rig whose clock drifts.
                _queue.ResolveUnresolved(assignment, poll.Poll.ServerClockOffset);
                _hasPolled = true;
            }
            _assignment = assignment;
        }
        PublishStatus();
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
            AssignmentKnown = _hasPolled,
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
