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

    // Bumped whenever this agent changes the assignment locally. A poll reads it
    // before sending and again when the answer comes back: if it moved, that
    // answer describes a rig state this agent has already left behind and is
    // dropped. Without it, a driver who signs out while a poll is in flight gets
    // their assignment reinstated by the late response, and every lap captured
    // afterwards is stamped with a stint that has ended.
    private int _assignmentGeneration;

    // The stint this agent has ended locally but has not yet been able to tell
    // the backend about, mirroring the queue's durable copy so the poll and the
    // stamping path can read it without touching SQLite. Two jobs: it is the
    // retry's target, and it is a tombstone - an assignment named here is one
    // this rig has finished with, whatever a poll still reports about it.
    private volatile string? _pendingCheckout;

    // Whether that pending sign-out reached disk. One held only in memory is
    // still re-sent for as long as this agent runs, but it does not survive a
    // restart - so it must never be reported as a delivery the backend is going
    // to get. Promising one that a reboot would silently drop is the same false
    // assurance, one layer down, as the swallowed press this whole path removes.
    private volatile bool _pendingCheckoutIsDurable;

    public event Action<AgentStatus>? StatusChanged;

    public AgentService(AgentConfig config, BackendClient client, EventQueue queue, ITelemetrySource telemetry)
    {
        _config = config;
        _client = client;
        _queue = queue;
        _telemetry = telemetry;
        // A checkout left undelivered by the previous run of this agent. Read
        // before any loop starts, so the first poll already knows not to adopt
        // the assignment it is about to close.
        _pendingCheckout = _queue.ReadPendingCheckout();
        // Read back off disk, so by definition it survived a restart already.
        _pendingCheckoutIsDurable = _pendingCheckout is not null;
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

    /// <summary>The "switch driver" action: end the current assignment.
    ///
    /// The seat empties HERE, before the backend is asked and whatever it
    /// answers. Gating the local clear on the answer meant that a press the
    /// backend could not receive did nothing at all: the departed driver stayed
    /// in the seat as far as this agent was concerned, so the next person's laps
    /// were stamped with their assignment - and, since nothing had closed that
    /// assignment either, credited to them as valid ranking laps when the outbox
    /// finally drained. Clearing first turns that into "no driver, visibly": the
    /// next person's laps carry no owner, land as unclaimed, and are worked from
    /// /staff by the people already standing there.
    ///
    /// What the backend is owed is queued rather than dropped, so the stint is
    /// closed there too as soon as it can be reached - except when this agent
    /// cannot name a stint to close, where there is nothing to queue and the
    /// result says so rather than promising a delivery that will never
    /// happen.</summary>
    public async Task<SwitchDriverResult> SwitchDriverAsync()
    {
        string? ending;
        bool owedToBackend;
        lock (_stampLock)
        {
            ending = _assignment?.Id;
            // Bumped inside the same lock that clears the assignment, so a poll
            // already in flight cannot answer with the stint that just ended.
            Interlocked.Increment(ref _assignmentGeneration);
            _assignment = null;
            // Durable before the network is touched: the press must survive a
            // rig PC that reboots before the backend comes back.
            //
            // Nothing is queued when this agent has never managed to poll: it
            // cannot name the stint, and a retry meaning "close whatever is
            // open here" would eventually close somebody else's. Such an agent
            // adopts whatever the first poll reports, which is the same
            // exposure a driver who never presses anything already has, and is
            // not what this guard is for.
            if (ending is not null)
            {
                // A durable write that fails costs this press its reboot
                // survival and nothing else - the retry runs off the field
                // below for as long as this agent lives. Letting the exception
                // out instead would take the console's input loop with it, and
                // the button would stop working at all: the failure this whole
                // path exists to remove.
                var durable = false;
                try
                {
                    _queue.SetPendingCheckout(ending);
                    durable = true;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(
                        $"[agent] failed to record queued sign-out {ending}: {ex.Message}");
                }
                _pendingCheckout = ending;
                _pendingCheckoutIsDurable = durable;
            }
            // Whether a delivery this agent can still promise is outstanding
            // once this press is done, read under the same lock that decided
            // it. What the driver is told turns on this, so it must not be
            // re-read after the call, where a settle on another loop could have
            // changed the answer. Durability is carried with the pending
            // sign-out rather than tracked per press, so a later press that
            // names no stint still reports the truth about the one already
            // outstanding.
            owedToBackend = _pendingCheckout is not null && _pendingCheckoutIsDurable;
        }
        PublishStatus();

        // Ok distinguishes "the backend answered" from "the call failed", which
        // a bare bool cannot: the backend legitimately answers false when it had
        // nothing open to close, and that needs no retry.
        var result = await RunBackend(async ct => (Ok: true, Ended: await _client.CheckoutAsync(ending, ct)));
        if (!result.Ok)
            return owedToBackend
                ? SwitchDriverResult.EndedPendingSync
                : SwitchDriverResult.EndedNotQueued;

        if (ending is not null) ClearPendingCheckout(ending);
        return result.Ended ? SwitchDriverResult.Ended : SwitchDriverResult.NoActiveSession;
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
        // Read before the request goes out, compared after it comes back.
        var generation = Volatile.Read(ref _assignmentGeneration);

        var poll = await RunBackend(async token => (Ok: true, Poll: await _client.GetAssignmentAsync(token)));
        if (!poll.Ok) return;
        var assignment = poll.Poll!.Assignment;

        // A stint this agent has already ended is over, however open the backend
        // still believes it to be - it believes that only because it has not
        // been told yet. Adopting it back off the poll would undo the local
        // clear and re-stamp the next person's laps with the departed driver,
        // which is exactly the defect. The lie is not the poll's; the correction
        // belongs here, on the way in.
        if (assignment is not null && assignment.Id == _pendingCheckout) assignment = null;

        lock (_stampLock)
        {
            // Somebody signed out while this was in flight. The answer in hand
            // describes the rig before that, so applying it would resurrect a
            // stint the driver has already ended. Drop it whole - including the
            // first-poll resolution, because a backlog stamped from a superseded
            // answer is the same guess by another route. The next poll is at
            // most one interval away and will resolve from the truth.
            if (Volatile.Read(ref _assignmentGeneration) != generation) return;

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

        // The backend is reachable, so this is the moment a checkout the driver
        // pressed during an outage can finally be delivered.
        await SettlePendingCheckout();
    }

    /// <summary>Deliver a checkout the backend could not be told about when the
    /// driver pressed the button.
    ///
    /// It names the assignment it is closing, so it can only ever close that
    /// one. By the time it lands the seat may legitimately belong to the next
    /// driver, or staff may have cleared the rig, or that driver's own check-in
    /// may have taken the stint over - in every one of those cases the backend
    /// finds nothing to close, answers false, and this stops asking. Only a
    /// backend that could not be reached at all leaves it queued.</summary>
    private async Task SettlePendingCheckout()
    {
        var pending = _pendingCheckout;
        if (pending is null) return;

        var result = await RunBackend(async ct => (Ok: true, Ended: await _client.CheckoutAsync(pending, ct)));
        if (result.Ok) ClearPendingCheckout(pending);
    }

    /// <summary>Forget a checkout the backend has now accounted for. Scoped to
    /// the assignment it settled: a second sign-out during the round trip
    /// records a newer debt, and that one is still owed.</summary>
    private void ClearPendingCheckout(string assignmentId)
    {
        lock (_stampLock)
        {
            _queue.ClearPendingCheckout(assignmentId);
            if (_pendingCheckout == assignmentId)
            {
                _pendingCheckout = null;
                _pendingCheckoutIsDurable = false;
            }
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
            CheckoutPending = _pendingCheckout is not null,
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
