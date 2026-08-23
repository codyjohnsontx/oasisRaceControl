namespace OasisRigAgent.Core;

/// <summary>
/// Orchestrates the rig agent: queues detected laps, and runs the background
/// loops — heartbeat, assignment poll, queue flush, and the idle sign-out that
/// keeps a departed customer's name off the next walk-in's laps. Exposes a
/// single StatusChanged event the UI renders. All backend calls funnel through
/// RunBackend so one place owns the online/offline state transition.
/// </summary>
public sealed class AgentService : IAsyncDisposable
{
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan MaxIdleInterval = TimeSpan.FromSeconds(5);
    private const int FlushBatchSize = 50;

    private readonly AgentConfig _config;
    private readonly BackendClient _client;
    private readonly EventQueue _queue;
    private readonly ITelemetrySource _telemetry;
    private readonly IAgentLog _log;
    private readonly ServerClock _clock;
    private readonly InstallationIdentity? _installation;
    private readonly IdleWatch _idle;
    // Monotonic: how long a seat has been empty must not be measurable by a venue
    // PC's own clock, which this fleet already assumes is wrong (see ServerClock).
    private readonly System.Diagnostics.Stopwatch _uptime = System.Diagnostics.Stopwatch.StartNew();
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _loops = new();

    private ConnectionState _connection = ConnectionState.Connecting;

    // Set when the backend last answered that a second computer is using this
    // rig's token, cleared the first flush it does not. Written by the flush
    // loop, read when status is published from any of them.
    private volatile bool _rigTokenShared;

    // Set when the backend named a rig this computer is not installed as, cleared
    // the first poll the two numbers agree. Written by the assignment poll, which
    // is the only call that learns it, and read by the heartbeat and flush loops
    // so a machine that knows it is the wrong rig stops acting like the right one.
    private volatile RigIdentityVerdict? _wrongRig;

    // Set when the backend answered and refused this rig's identity, cleared by
    // the first call it accepts. Written by whichever loop made the call - they
    // all funnel through RunBackend - and read when status is published from any
    // of them, so the rig says the same thing whichever timer ran last.
    private volatile BackendReachVerdict? _backendRefusal;

    // Completed once the first assignment poll has finished AND its verdict has been
    // recorded, however it finished. Everything that acts as this rig - the heartbeat,
    // which is a claim on a rig number, and the flush, which credits laps to it -
    // waits on this first.
    //
    // Every loop runs immediately at startup, so without it they race the one call
    // that learns whether this computer is the rig it says it is, and both lose in
    // the way that costs somebody: a mis-enrolled machine stamps a conflict onto the
    // rig it is impersonating and holds THAT rig's laps until it ages out, and a
    // machine restarted with laps already in its outbox empties them onto the wrong
    // rig's customer in the first tick. Both were found by running this against a
    // real backend, not by a test.
    private readonly TaskCompletionSource _identityChecked =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    // Written by the assignment poll loop, read by the telemetry thread when a
    // lap is detected — volatile so the driver stamped on a lap is the one the
    // most recent poll saw, not a stale cached read.
    private volatile Assignment? _assignment;

    // How long this rig has left before it signs the current customer out on its
    // own, once it is close enough to say so; -1 the rest of the time. Held as
    // ticks rather than TimeSpan? because the idle loop writes it and any of the
    // other loops can be publishing status from it at that moment - a struct wide
    // enough to tear would put a countdown nobody is on onto the rig's screen.
    private long _idleSignOutTicks = -1;

    private TimeSpan? IdleSignOutIn
    {
        get
        {
            var ticks = Interlocked.Read(ref _idleSignOutTicks);
            return ticks < 0 ? null : TimeSpan.FromTicks(ticks);
        }
    }

    public event Action<AgentStatus>? StatusChanged;

    public AgentService(
        AgentConfig config,
        BackendClient client,
        EventQueue queue,
        ITelemetrySource telemetry,
        IAgentLog? log = null,
        ServerClock? clock = null,
        InstallationIdentity? installation = null,
        IdleWatch? idle = null)
    {
        _config = config;
        _client = client;
        _queue = queue;
        _telemetry = telemetry;
        _log = log ?? NullLog.Instance;
        // A default clock has measured nothing and corrects nothing, so an agent
        // built without one behaves exactly as it did before.
        _clock = clock ?? new ServerClock();
        // Absent means an agent that cannot say which computer it is; the backend
        // then leaves this rig's recorded machine alone rather than guessing.
        _installation = installation;
        _idle = idle ?? IdleWatch.From(config);
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
                // Bind the lap to the driver who was checked in when it was
                // driven. Resolving the owner at flush time instead would hand
                // a lap queued through an outage to the next customer.
                //
                // And say when it was driven in the backend's terms rather than
                // this machine's. The backend decides who owns a lap and which
                // night it belongs to from this one timestamp, so a rig with a
                // wrong clock otherwise has its laps refused outright or filed
                // on a day the leaderboard is not showing - see ServerClock.
                _queue.Enqueue(lap with { CompletedAt = _clock.Correct(lap.CompletedAt) }, _assignment?.Id);
                PublishStatus();
            }
            catch (Exception ex)
            {
                _log.Error($"[agent] failed to queue lap {lap.EventId}: {ex.Message}");
            }
        };
        _telemetry.Start();

        _loops.Add(RunLoop(HeartbeatInterval, HeartbeatTick, runImmediately: true));
        _loops.Add(RunLoop(PollInterval, PollAssignmentTick, runImmediately: true));
        _loops.Add(RunLoop(FlushInterval, FlushQueueTick, runImmediately: true));
        if (!_idle.Disabled) _loops.Add(RunLoop(IdleInterval(_idle.EndAfter), IdleTick, runImmediately: false));
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
    {
        // A heartbeat is a claim on a rig: it stamps this computer as the machine
        // behind that rig number, and a second live installation puts the rig into
        // conflict and stops it scoring. So a computer holding another rig's token
        // must stop heartbeating the moment it knows - otherwise one wrong paste at
        // enrolment takes a working rig, with a customer on it, off the air for the
        // night. It keeps polling, which is how it finds out the token was fixed.
        //
        // Waited on rather than checked, for the first beat only: a beat sent before
        // the first poll answers is a claim made before the machine knows whether
        // the rig is its own.
        await _identityChecked.Task.WaitAsync(_cts.Token);
        if (_wrongRig is not null) return;

        await RunBackend(async token =>
        {
            // Read once: the telemetry thread can change these between two reads,
            // and a reason paired with the wrong running flag would report a rig
            // that cannot score as merely idle.
            var reason = _telemetry.SimUnusableReason;
            await _client.HeartbeatAsync(
                // The build that is running, never a number from the config file: the
                // config is what survives a fleet update, so a version read from it can
                // never say a rig took one (AgentVersionInfo).
                AgentVersionInfo.Current,
                SimHealthReading.Of(_telemetry.SimRunning, reason),
                reason,
                _installation,
                token);
            return true;
        });
    }

    private async Task PollAssignmentTick(CancellationToken ct)
    {
        // Success must come from this poll's own result — _connection is shared
        // with the heartbeat/flush loops, so it can flip between our call and
        // this check (e.g. clearing the assignment because a heartbeat failed).
        var poll = await RunBackend(async token => (Ok: true, Poll: await _client.GetAssignmentAsync(token)));

        // The one comparison neither side can make alone: the number this computer
        // was installed as against the rig its token actually belongs to. Recorded
        // BEFORE the gate is released - a waiter let go first reads the verdict that
        // has not been written yet, which is the same race one line further on.
        if (poll.Ok) SetWrongRig(RigIdentity.Check(_config.RigNumber, poll.Poll!.Rig));

        // Released whatever the poll answered, including a failure: a rig that
        // cannot reach the backend at all would otherwise never heartbeat or deliver
        // again, and an unanswerable question is not evidence about which rig this is.
        _identityChecked.TrySetResult();

        if (!poll.Ok) return;

        // Whoever is checked in over at the rig this token names is not the person
        // sitting here, so their name must never reach this screen - and a lap
        // queued now must not be stamped with their check-in, or it would be
        // refused outright once this machine is re-enrolled with its own token.
        _assignment = _wrongRig is null ? poll.Poll.Assignment : null;
        PublishStatus();
    }

    private async Task FlushQueueTick(CancellationToken ct)
    {
        // Every lap this computer sends would be credited to the rig its token
        // names, and to whoever is checked in there. Holding them in this machine's
        // own outbox loses nothing: they deliver themselves, and land on the right
        // rig, the moment somebody re-enrols this one (RigIdentity).
        //
        // Waited on for the same reason as the heartbeat, and it matters more here:
        // the realistic sequence is a machine enrolled wrongly, laps piling up, and
        // somebody rebooting it - so the very first flush after a restart is a full
        // outbox emptying onto another rig's customer before anything has asked who
        // this computer is.
        await _identityChecked.Task.WaitAsync(_cts.Token);
        if (_wrongRig is not null) return;

        var batch = _queue.PendingBatch(FlushBatchSize);
        if (batch.Count == 0) return;

        var submission = await RunBackend(token => _client.SendLapsAsync(batch, token));
        if (submission is null) return;

        if (submission.Settled.Count > 0) _queue.Remove(submission.Settled);

        // An event the backend will not parse can never carry, and it sits at
        // the head of the queue holding every lap behind it. Setting it aside
        // is what keeps the rig scoring; the log line is what lets somebody
        // work out afterwards why one lap did not.
        if (submission.Rejected.Count > 0)
        {
            foreach (var rejected in submission.Rejected)
            {
                _log.Error($"[agent] lap {rejected.EventId} rejected by the backend, quarantined: {rejected.Reason}");
                _queue.Quarantine(new[] { rejected.EventId }, rejected.Reason);
            }
        }

        // The backend will not credit a lap to a customer while two computers are
        // claiming this rig, so every lap stays queued and nothing is lost - but
        // a rig quietly stacking laps is the shape of failure this whole agent is
        // built to avoid, so it says why on its own screen and in its log.
        var conflicted = submission.HeldForRigConflict > 0;
        if (conflicted != _rigTokenShared)
        {
            _rigTokenShared = conflicted;
            if (conflicted)
                _log.Error($"[agent] the backend is holding {submission.HeldForRigConflict} lap(s): "
                    + "another computer is using this rig's token. Give each rig its own token "
                    + "(agent.config.json) - the laps deliver themselves once it does.");
            else
                _log.Info("[agent] this rig's token is no longer shared; queued laps are delivering.");
        }

        if (submission.Settled.Count > 0 || submission.Rejected.Count > 0 || conflicted) PublishStatus();
    }

    /// <summary>
    /// How often the seat is judged: every five seconds for the venue's ten-minute
    /// period, and proportionally faster for a shorter one, so the countdown a rig
    /// shows is never coarser than a quarter of the period it is counting down.
    /// </summary>
    private static TimeSpan IdleInterval(TimeSpan endAfter) =>
        endAfter / 4 < MaxIdleInterval ? endAfter / 4 : MaxIdleInterval;

    /// <summary>
    /// Ends the check-in of a customer who has gone home.
    ///
    /// Nobody at Oasis tells this system when a customer's paid time is up, so an
    /// unattended rig keeps the last name on its screen and hands the next walk-in's
    /// laps to whoever drove before them. <see cref="IdleWatch"/> owns the rule; this
    /// only carries the verdict out, and it names the assignment it judged so a
    /// customer who checks in during the countdown cannot be signed out by it.
    /// </summary>
    private async Task IdleTick(CancellationToken ct)
    {
        var assignment = _assignment;
        var verdict = _idle.Observe(
            assignment?.Id,
            SimHealthReading.Of(_telemetry.SimRunning, _telemetry.SimUnusableReason),
            _uptime.Elapsed);

        var warning = verdict.Action == IdleAction.Warn ? verdict.Remaining.Ticks : -1;
        if (Interlocked.Exchange(ref _idleSignOutTicks, warning) != warning) PublishStatus();

        if (verdict.Action != IdleAction.EndSession) return;

        // Offline this returns default(bool) - false - and the watch says the same
        // thing again on the next tick, so a rig that lost the network signs the
        // session out as soon as it is back rather than dropping the decision.
        var ended = await RunBackend(token => _client.CheckoutAsync(verdict.AssignmentId, "idle_timeout", token));
        if (!ended) return;

        var who = assignment?.Id == verdict.AssignmentId ? assignment!.DriverDisplayName : "the checked-in driver";
        _log.Info($"[agent] signed {who} out: iRacing has been closed for "
            + $"{IdleWatch.Describe(_idle.EndAfter)}. The rig is available again.");

        // Only if it is still the assignment we ended. A poll between the decision and
        // the response can have brought a new customer, and clearing that would blank
        // their name on the rig's screen until the next poll put it back.
        if (_assignment?.Id == verdict.AssignmentId) _assignment = null;
        Interlocked.Exchange(ref _idleSignOutTicks, -1);
        PublishStatus();
    }

    /// <summary>Runs a backend call, flipping connection state on success/failure.
    /// Returns default(T) if the call throws (offline) — callers must treat that
    /// as "no update".
    ///
    /// One of those failures is not an outage. A backend that answers and refuses
    /// this rig's token leaves the machine looking exactly like one whose network
    /// dropped, and it is the opposite situation: permanent, invisible from the
    /// staff dashboard because a rig that cannot authenticate cannot appear on it,
    /// and fixed by walking back to this machine rather than by waiting. So the
    /// verdict is kept, and the rig says it (<see cref="BackendReach"/>).</summary>
    private async Task<T?> RunBackend<T>(Func<CancellationToken, Task<T>> call)
    {
        try
        {
            var result = await call(_cts.Token);
            SetBackendRefusal(null);
            SetConnection(ConnectionState.Online);
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (BackendRejectedException rejected)
        {
            // Recorded before the state flip so the status this publishes already
            // carries the reason, rather than showing a bare "offline" first.
            SetBackendRefusal(rejected.Verdict);
            SetConnection(ConnectionState.Offline);
            return default;
        }
        catch
        {
            // An ordinary outage says nothing about the token, so a refusal
            // already recorded stands: the network coming and going must not
            // erase the reason this rig is not delivering laps.
            SetConnection(ConnectionState.Offline);
            return default;
        }
    }

    /// <summary>Records whether this computer is the rig it says it is, once per
    /// change. The poll runs every ten seconds all night, and a line per poll would
    /// bury the one explanation of why this machine stopped under thousands of
    /// copies of itself.</summary>
    private void SetWrongRig(RigIdentityVerdict? verdict)
    {
        if (Equals(_wrongRig, verdict)) return;
        _wrongRig = verdict;
        if (verdict is null)
            _log.Info("[agent] this computer is the rig it is installed as again; queued laps are delivering.");
        else
            _log.Error($"[agent] THIS RIG IS NOT DELIVERING LAPS — {verdict.Instruction}");
    }

    /// <summary>Records the backend's verdict on this rig's identity, and writes
    /// it down once per change rather than once per call - the three loops between
    /// them make a call every couple of seconds, all night.</summary>
    private void SetBackendRefusal(BackendReachVerdict? verdict)
    {
        if (ReferenceEquals(_backendRefusal, verdict)) return;
        _backendRefusal = verdict;
        if (verdict is null)
            _log.Info("[agent] the backend accepted this rig's token; queued laps are delivering.");
        else
            _log.Error($"[agent] THIS RIG IS NOT DELIVERING LAPS — {verdict.Instruction}");
        PublishStatus();
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
            _log.Error($"[agent] tick failed: {ex.Message}");
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
            SimUnusableReason = _telemetry.SimUnusableReason,
            PendingLaps = _queue.PendingCount(),
            QuarantinedLaps = _queue.QuarantinedCount(),
            ClockOffset = _clock.Offset,
            BackendRefusal = _backendRefusal?.Summary,
            WrongRig = _wrongRig?.Summary,
            RigTokenShared = _rigTokenShared,
            IdleSignOutIn = IdleSignOutIn,
        });
    }

    public async ValueTask DisposeAsync()
    {
        await _cts.CancelAsync();
        // Anything still waiting to learn which rig this is must be let go, or the
        // heartbeat loop never returns and shutdown hangs.
        _identityChecked.TrySetResult();
        _telemetry.Stop();
        foreach (var loop in _loops)
        {
            try { await loop; } catch { /* shutting down */ }
        }
        _cts.Dispose();
    }
}
