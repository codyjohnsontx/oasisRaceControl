using OasisRigAgent.Core.Iracing;

namespace OasisRigAgent.Core;

/// <summary>
/// Orchestrates the rig agent: queues detected laps, and runs the background
/// loops - heartbeat, assignment poll, queue flush, and the sim-state check.
/// The heartbeat is also the rig's whole report to the server-side monitor
/// (<see cref="HeartbeatReport"/>): built from state this class already
/// holds, once a minute, and nothing on the rig decides whether it is healthy.
/// Exposes a StatusChanged event the UI renders, and a Notice event for
/// one-line problems the host prints. All backend calls funnel through
/// RunBackend so one place owns the online/offline state transition.
/// </summary>
public sealed class AgentService : IAsyncDisposable
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan SimStateInterval = TimeSpan.FromSeconds(1);
    private const int FlushBatchSize = 50;
    private bool _publishedSimRunning;

    private readonly AgentConfig _config;
    private readonly BackendClient _client;
    private readonly EventQueue _queue;
    private readonly ITelemetrySource _telemetry;
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _loops = new();

    private ConnectionState _connection = ConnectionState.Connecting;

    // Completed when a backend call brings the connection back from offline.
    // Replaced by the heartbeat loop before each send, so it only ever says
    // "the backend returned since this heartbeat was attempted".
    private TaskCompletionSource _backendReturned = new(TaskCreationOptions.RunContinuationsAsynchronously);

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

    // Walk-up mode (the rig is the check-in): the only stint this agent will
    // stamp a lap with is one its own check-in created in this process. A poll
    // can end that stint here but never hand over another - not one a previous
    // run left open, and not a phone check-in either.
    private readonly bool _ownStintsOnly;

    // What the heartbeat reports beyond AgentStatus. The sim's side is written
    // by the telemetry thread's events and only ever replaced whole, so a
    // volatile reference is enough; the counters and notices are drained by
    // the heartbeat that delivered them and share one lock.
    private readonly ProcessFootprint _footprint;
    private readonly DateTimeOffset? _processStartedAt;
    private int? _startCount;
    private volatile SessionCombo? _session;
    private volatile IReadOnlyList<string> _missingVariables = Array.Empty<string>();
    private volatile bool _telemetryFaulted;
    private readonly object _reportLock = new();
    private DateTimeOffset? _lastLapCapturedAt;
    private DateTimeOffset? _lastLapPostedAt;
    private long _reportSequence;
    private readonly List<(long Seq, string Text)> _unreportedNotices = new();
    private readonly List<(long Seq, SignInFailureKind Kind)> _unreportedSignInFailures = new();
    private volatile bool _shuttingDown;
    private bool _reportedBareHeartbeat;

    // A sign-in failure count is a number, so unlike the notices it is not
    // capped at the ten the wire takes: a long outage keeps counting. The
    // list itself is capped so a rig nobody can sign into for a night does
    // not grow without bound; past it only the oldest kinds are forgotten.
    private const int MaxUnreportedSignInFailures = 1000;

    public event Action<AgentStatus>? StatusChanged;

    /// <summary>A lap was queued with the stint it was stamped with (null:
    /// nobody was in the seat, so the backend will store it unclaimed). Not
    /// raised for a lap held unresolved until the first poll.</summary>
    public event Action<LapCompleted, string?>? LapQueued;

    /// <summary>The backend has these queued events now, by event id.</summary>
    public event Action<IReadOnlyList<string>>? LapsPosted;

    /// <summary>Something went wrong that the person at the rig or staff
    /// should read - a lap the backend refused, the outbox failing - as one
    /// line for whichever console the host shows.</summary>
    public event Action<string>? Notice;

    public AgentService(
        AgentConfig config, BackendClient client, EventQueue queue, ITelemetrySource telemetry,
        ProcessFootprint? footprint = null)
    {
        _config = config;
        _client = client;
        _queue = queue;
        _telemetry = telemetry;
        _footprint = footprint ?? new ProcessFootprint();
        _processStartedAt = ProcessStartedAt();
        _ownStintsOnly = config.RigQrToken is not null;
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
            lock (_reportLock) _lastLapCapturedAt = DateTimeOffset.UtcNow;
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
                string? stamp = null;
                var stamped = false;
                lock (_stampLock)
                {
                    if (_hasPolled || _ownStintsOnly)
                    {
                        stamp = _assignment?.Id;
                        _queue.Enqueue(lap, stamp);
                        stamped = true;
                    }
                    else _queue.EnqueueUnresolved(lap);
                }
                if (stamped) LapQueued?.Invoke(lap, stamp);
                PublishStatus();
            }
            catch (Exception ex)
            {
                RaiseNotice($"[agent] failed to queue lap {lap.EventId}: {ex.Message}");
            }
        };
        if (_telemetry is ISimHealthSource sim)
        {
            // Raised on the telemetry thread: each handler only swaps a
            // reference, so the sim never waits on the agent.
            sim.ConnectionChanged += up =>
            {
                if (up) return;
                _session = null;
                _missingVariables = Array.Empty<string>();
            };
            sim.ComboChanged += combo => _session = combo;
            sim.MissingVariables += names => _missingVariables = names.ToArray();
            sim.Faulted += ex =>
            {
                _telemetryFaulted = true;
                // For the heartbeat only: both consoles already print the
                // source's own Faulted line.
                RememberNotice($"[telemetry] lap reading stopped: {ex.Message}");
            };
        }
        // Counted before the first heartbeat goes, so that heartbeat already
        // says how many times this rig has started today. An outbox that
        // cannot record it costs the count, not the start.
        try
        {
            _startCount = _queue.RecordStart(DateTimeOffset.UtcNow);
        }
        catch (Exception ex)
        {
            RaiseNotice($"[agent] failed to record this start: {ex.Message}");
        }
        _telemetry.Start();

        _loops.Add(HeartbeatLoop());
        _loops.Add(RunLoop(PollInterval, PollAssignmentTick, runImmediately: true));
        _loops.Add(RunLoop(FlushInterval, FlushQueueTick, runImmediately: true));
        // The sim's state is not an event the telemetry contract carries, and
        // the walk-up screen shows a warning while iRacing is not in a session
        // - one that has to go away the moment it is. A once-a-second check
        // publishes the change; nothing else republishes on the sim's account.
        _loops.Add(RunLoop(SimStateInterval, SimStateTick, runImmediately: false));
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
    public Task<SwitchDriverResult> SwitchDriverAsync() => SwitchDriverAsync(onlyIfSeated: false);

    /// <summary>The switch-driver, but only when this agent has a driver in the
    /// seat; otherwise nothing, not even a call. For the way out of the
    /// program, where nobody asked for a checkout: with no stint to name, the
    /// checkout would mean "close whatever is open on this rig", which can be a
    /// stint staff or a phone opened since, or race the log-out that just
    /// ended the seat. Decided under the same lock that clears the seat, so a
    /// log-out between the check and the switch cannot turn it into that
    /// unqualified checkout.</summary>
    public Task<SwitchDriverResult> SignOutSeatedDriverAsync() => SwitchDriverAsync(onlyIfSeated: true);

    private async Task<SwitchDriverResult> SwitchDriverAsync(bool onlyIfSeated)
    {
        string? ending;
        bool owedToBackend;
        lock (_stampLock)
        {
            ending = _assignment?.Id;
            if (onlyIfSeated && ending is null) return SwitchDriverResult.NoActiveSession;
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
                    RaiseNotice(
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

    /// <summary>Walk-up mode: put the driver this rig just checked in into the
    /// seat, so the very next lap is stamped with their stint. The generation
    /// bump drops a poll already in flight, which describes the rig before
    /// this check-in.</summary>
    public void SeatCheckedInDriver(DriverCheckIn checkIn)
    {
        lock (_stampLock)
        {
            Interlocked.Increment(ref _assignmentGeneration);
            _assignment = new Assignment(checkIn.AssignmentId, checkIn.DriverId, checkIn.DisplayName, DateTimeOffset.UtcNow);
        }
        PublishStatus();
    }

    /// <summary>Walk-up mode, on start: end whatever stint is open on this rig -
    /// one a previous run of this agent left behind when it was closed without
    /// a sign-out landing, or a phone check-in. True once the backend has
    /// answered, whether or not there was anything to end.</summary>
    public async Task<bool> EmptySeatAsync()
    {
        var result = await RunBackend(async ct => (Ok: true, Ended: await _client.CheckoutAsync(null, ct)));
        return result.Ok;
    }

    private Task SimStateTick(CancellationToken ct)
    {
        var running = _telemetry.SimRunning;
        if (running != _publishedSimRunning) PublishStatus();
        return Task.CompletedTask;
    }

    /// <summary>One heartbeat now, then one a minute - further apart while the
    /// backend does not answer (<see cref="HeartbeatSchedule"/>). A Task.Delay
    /// between sends rather than a timer: nothing wakes in between, and the
    /// gap can grow. After a heartbeat that did not get through, the poll or
    /// the flush reaching the backend again ends the wait and the backoff, so
    /// the rig is seen again within seconds of the link returning. Ends when
    /// the agent is disposed or a goodbye has gone.</summary>
    private async Task HeartbeatLoop()
    {
        var failures = 0;
        while (!_cts.IsCancellationRequested && !_shuttingDown)
        {
            var backendReturned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Volatile.Write(ref _backendReturned, backendReturned);
            bool? delivered;
            try
            {
                delivered = await SendHeartbeatAsync(shuttingDown: false);
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // Building the report failed locally; that is no reason to
                // back off from a backend that may be answering fine.
                RaiseNotice($"[agent] tick failed: {ex.Message}");
                delivered = null;
            }
            if (delivered is { } ok) failures = ok ? 0 : failures + 1;

            using var wait = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            var delay = Task.Delay(HeartbeatSchedule.Delay(failures, Random.Shared.NextDouble()), wait.Token);
            var woke = await Task.WhenAny(delay, failures > 0 ? backendReturned.Task : delay);
            wait.Cancel();
            if (_cts.IsCancellationRequested) return;
            if (woke != delay) failures = 0;
        }
    }

    /// <summary>Send one heartbeat. True once the backend has it (the full
    /// report or, if it refused that, the bare one), false when it could not be
    /// reached. What it reported is forgotten only then, so a notice or a
    /// sign-in failure from an outage arrives with the first heartbeat that
    /// gets through.</summary>
    internal async Task<bool> SendHeartbeatAsync(bool shuttingDown)
    {
        var (report, reportedUpTo) = BuildHeartbeat(shuttingDown);
        var sent = await RunBackend(async token => (Ok: true, Full: await _client.HeartbeatAsync(report, token)));
        if (!sent.Ok) return false;

        lock (_reportLock)
        {
            // Dropped even when only the bare heartbeat got through: whatever
            // in them the backend could not take would otherwise be offered
            // again every minute, and the report would never get through.
            _unreportedNotices.RemoveAll(n => n.Seq <= reportedUpTo);
            _unreportedSignInFailures.RemoveAll(f => f.Seq <= reportedUpTo);
            if (sent.Full || _reportedBareHeartbeat) return true;
            _reportedBareHeartbeat = true;
        }
        RaiseNotice("[agent] the backend refused this rig's status report and got the bare heartbeat instead - "
            + "the rig shows as online, but the agent and the site disagree on the report's shape.");
        return true;
    }

    /// <summary>The goodbye: one heartbeat saying this agent is shutting down,
    /// so a rig that was closed reads differently from one that lost power.
    /// Bounded by <paramref name="limit"/> because it runs on the way out,
    /// where a backend that does not answer must not hold the window open;
    /// no heartbeat follows it.</summary>
    public async Task SendGoodbyeAsync(TimeSpan limit)
    {
        _shuttingDown = true;
        try
        {
            await SendHeartbeatAsync(shuttingDown: true).WaitAsync(limit);
        }
        catch (Exception)
        {
            // Nothing more can be done on the way out; the monitor reads the
            // silence that follows as a rig that went away unannounced.
        }
    }

    /// <summary>A walk-up sign-in that seated nobody, counted for the next
    /// heartbeat (see <see cref="SignInFailureWatch"/>).</summary>
    public void RecordSignInFailure(SignInFailureKind kind)
    {
        lock (_reportLock)
        {
            _unreportedSignInFailures.Add((++_reportSequence, kind));
            if (_unreportedSignInFailures.Count > MaxUnreportedSignInFailures) _unreportedSignInFailures.RemoveAt(0);
        }
    }

    private void RaiseNotice(string message)
    {
        RememberNotice(message);
        Notice?.Invoke(message);
    }

    /// <summary>Keep a notice for the next heartbeat; only the newest ten go.</summary>
    private void RememberNotice(string message)
    {
        lock (_reportLock)
        {
            _unreportedNotices.Add((++_reportSequence, message));
            if (_unreportedNotices.Count > HeartbeatReport.MaxListItems) _unreportedNotices.RemoveAt(0);
        }
    }

    /// <summary>This minute's report, and the sequence number of the last
    /// notice or sign-in failure in it.</summary>
    internal (HeartbeatReport Report, long ReportedUpTo) BuildHeartbeat(bool shuttingDown)
    {
        var now = DateTimeOffset.UtcNow;
        (double? CpuPercent, double MemoryMb) footprint;
        lock (_footprint) footprint = _footprint.Sample();
        // The outbox is the one file read here. A disk that fails leaves those
        // counts out of the report rather than the report out of the minute.
        int? pending = Outbox(_queue.PendingCount);
        int? rejected = Outbox(_queue.RejectedCount);
        double? oldest = null;
        try { oldest = _queue.OldestPendingAge(now)?.TotalSeconds; }
        catch (Exception) { }
        var pendingCheckout = _pendingCheckout;

        lock (_reportLock)
        {
            var report = new HeartbeatReport
            {
                AgentVersion = _config.AgentVersion,
                SentAt = now,
                ProcessStartedAt = _processStartedAt,
                StartCount = _startCount,
                OsUptimeS = Environment.TickCount64 / 1000,
                TelemetryMode = _config.TelemetryMode,
                SimConnected = _telemetry.SimRunning,
                TelemetryFaulted = _telemetryFaulted,
                MissingVariables = _missingVariables,
                Session = _telemetry.SimRunning ? _session : null,
                AssignmentId = _assignment?.Id,
                AssignmentKnown = _hasPolled,
                PendingLaps = pending,
                OldestPendingAgeS = oldest,
                RejectedLaps = rejected,
                Checkout = pendingCheckout is null
                    ? CheckoutDelivery.None
                    : _pendingCheckoutIsDurable ? CheckoutDelivery.Queued : CheckoutDelivery.NotQueued,
                LastLapCapturedAt = _lastLapCapturedAt,
                LastLapPostedAt = _lastLapPostedAt,
                SignInFailures = _unreportedSignInFailures.Count,
                SignInFailureKinds = _unreportedSignInFailures.Select(f => f.Kind).ToArray(),
                Notices = _unreportedNotices.Select(n => n.Text).ToArray(),
                AgentCpuPercent = footprint.CpuPercent,
                AgentMemoryMb = footprint.MemoryMb,
                // Once a goodbye is under way, a heartbeat that was already
                // being built says so too: it may land after the goodbye, and
                // must not read as the rig coming back.
                ShuttingDown = shuttingDown || _shuttingDown,
            };
            return (report, _reportSequence);
        }

        static T? Outbox<T>(Func<T> read) where T : struct
        {
            try { return read(); }
            catch (Exception) { return null; }
        }
    }

    private static DateTimeOffset? ProcessStartedAt()
    {
        try
        {
            using var process = System.Diagnostics.Process.GetCurrentProcess();
            return new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero);
        }
        catch (Exception)
        {
            return null;
        }
    }

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
            if (_ownStintsOnly && assignment is not null && assignment.Id != _assignment?.Id) assignment = null;

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
        await SettlePendingCheckoutAsync();
    }

    /// <summary>Deliver a checkout the backend could not be told about when the
    /// driver pressed the button.
    ///
    /// It names the assignment it is closing, so it can only ever close that
    /// one. By the time it lands the seat may legitimately belong to the next
    /// driver, or staff may have cleared the rig, or that driver's own check-in
    /// may have taken the stint over - in every one of those cases the backend
    /// finds nothing to close, answers false, and this stops asking. Only a
    /// backend that could not be reached at all leaves it queued.
    ///
    /// Walk-up mode runs it before every check-in: the backend answers a
    /// check-in on a stint still open for the same driver with that same
    /// stint, and seating one this rig still owes a sign-out for would have
    /// the next poll end it under the driver. True once nothing is owed.</summary>
    public async Task<bool> SettlePendingCheckoutAsync()
    {
        var pending = _pendingCheckout;
        if (pending is null) return true;

        var result = await RunBackend(async ct => (Ok: true, Ended: await _client.CheckoutAsync(pending, ct)));
        if (result.Ok) ClearPendingCheckout(pending);
        return result.Ok;
    }

    /// <summary>Forget a checkout the backend has now accounted for. Scoped to
    /// the assignment it settled: a second sign-out during the round trip
    /// records a newer debt, and that one is still owed.</summary>
    private void ClearPendingCheckout(string assignmentId)
    {
        lock (_stampLock)
        {
            // Contained for the same reason the durable write is, and it is the
            // same outbox that fails: this runs on the press's own path, where
            // an escaped exception would take the console's input loop with it
            // and the button would stop working at all. A delete is a write, so
            // no outage is needed to reach it - a backend that answers gets
            // here too. The in-memory clear below happens regardless, so a bad
            // outbox costs this sign-out its reboot survival and nothing more.
            try
            {
                _queue.ClearPendingCheckout(assignmentId);
            }
            catch (Exception ex)
            {
                RaiseNotice(
                    $"[agent] failed to forget delivered sign-out {assignmentId}: {ex.Message}");
            }
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

        // Null means the backend could not be reached at all, which is the one
        // case where re-sending this exact batch is the right thing to do.
        var outcome = await RunBackend(token => _client.SendLapsAsync(batch, token));
        if (outcome is null) return;

        if (outcome.Rejected.Count > 0) Quarantine(outcome.Rejected);
        if (outcome.Settled.Count > 0)
        {
            lock (_reportLock) _lastLapPostedAt = DateTimeOffset.UtcNow;
            _queue.Remove(outcome.Settled);
            PublishStatus();
            LapsPosted?.Invoke(outcome.Settled);
        }
    }

    /// <summary>Park laps the backend refused by name, so the next flush carries
    /// the rest of the queue instead of the same refusal.
    ///
    /// The backend validates a batch whole: one lap it will not accept fails all
    /// fifty, and until that lap stops being offered every lap queued behind it
    /// is stuck with it. Parking is what lets the queue drain past it. The lap
    /// itself is kept - the outbox holds the only copy of it that has ever
    /// existed - and it is never offered again, because offering it again is the
    /// wedge.
    ///
    /// Logged once per lap, from what the outbox actually parked rather than
    /// from what was refused, so the line is printed by the call that changed
    /// something and a re-run cannot print it twice.</summary>
    private void Quarantine(IReadOnlyList<RejectedEvent> rejected)
    {
        foreach (var lap in _queue.Reject(rejected))
            RaiseNotice(
                $"[agent] the backend will not accept lap {lap.EventId} ({lap.Reason}). "
                + "It is kept in the outbox and will not be sent again; the rest of the "
                + "queue is now free to flush.");
        PublishStatus();
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
        catch (OperationCanceledException) when (_cts.IsCancellationRequested)
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
        catch (OperationCanceledException) when (_cts.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception ex)
        {
            RaiseNotice($"[agent] tick failed: {ex.Message}");
            return true;
        }
    }

    private void SetConnection(ConnectionState state)
    {
        if (_connection == state) return;
        var returned = _connection == ConnectionState.Offline && state == ConnectionState.Online;
        _connection = state;
        PublishStatus();
        if (returned) Volatile.Read(ref _backendReturned).TrySetResult();
    }

    private void PublishStatus()
    {
        var status = CurrentStatus();
        _publishedSimRunning = status.SimRunning;
        StatusChanged?.Invoke(status);
    }

    /// <summary>What the agent knows right now - the same snapshot
    /// <see cref="StatusChanged"/> publishes, for a screen that has just been
    /// redrawn.</summary>
    public AgentStatus CurrentStatus()
    {
        return new AgentStatus
        {
            RigNumber = _config.RigNumber,
            Connection = _connection,
            Assignment = _assignment,
            AssignmentKnown = _hasPolled,
            SimRunning = _telemetry.SimRunning,
            PendingLaps = _queue.PendingCount(),
            RejectedLaps = _queue.RejectedCount(),
            // Durability decides which of the two "outstanding" answers this
            // is. Reporting a sign-out held only in memory as queued would make
            // the line staff read all night contradict what the driver was told
            // at the press, and promise a delivery a reboot would drop.
            Checkout = _pendingCheckout is null
                ? CheckoutDelivery.None
                : _pendingCheckoutIsDurable ? CheckoutDelivery.Queued : CheckoutDelivery.NotQueued,
        };
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
