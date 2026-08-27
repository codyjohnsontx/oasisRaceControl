using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The agent half of the attribution invariant: a lap is stamped with the
/// assignment this rig had when the lap was captured, so a lap that waits in
/// the outbox can never be credited to whoever checks in later.
/// </summary>
public sealed class AgentServiceTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-agent-{Guid.NewGuid():N}.db");

    private const string AssignmentId = "3f1b0c8e-3a1c-4f6d-9c2f-1a2b3c4d5e6f";

    /// <summary>Telemetry the test drives by hand instead of by timer.</summary>
    private sealed class FakeTelemetrySource : ITelemetrySource
    {
        public bool SimRunning => true;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { }

        public void Emit(string eventId, DateTimeOffset? completedAt = null) =>
            LapCompleted?.Invoke(new LapCompleted
            {
                EventId = eventId,
                TrackName = "Spa-Francorchamps",
                TrackConfig = "Grand Prix Pits",
                CarName = "Porsche 911 GT3 R",
                LapNumber = 1,
                LapTimeMs = 138_000,
                IncidentDelta = 0,
                CompletedAt = completedAt ?? DateTimeOffset.UtcNow,
            });
    }

    /// <summary>Backend stub: the assignment it reports can change mid-test, and
    /// lap posts always answer with an empty result list so the flush loop never
    /// settles (and therefore never deletes) what the test is inspecting.
    ///
    /// Checkout is modelled rather than stubbed, because the retry's whole
    /// correctness is in what the backend does with a late one. It behaves like
    /// api/agent/checkout: a checkout naming an assignment closes that
    /// assignment or nothing, and an unqualified one closes whatever is
    /// open.</summary>
    private sealed class StubBackend : HttpMessageHandler
    {
        private volatile string? _assignmentId;
        private volatile bool _offline;
        private long _startedAtTicks = DefaultStartedAt.UtcTicks;

        private readonly object _checkoutLock = new();
        private readonly List<string?> _checkouts = new();

        /// <summary>Every checkout this backend has received, in order, by the
        /// assignment id it named (null for the unqualified form).</summary>
        public IReadOnlyList<string?> Checkouts
        {
            get { lock (_checkoutLock) return _checkouts.ToArray(); }
        }

        /// <summary>Whoever the backend currently has open on this rig.</summary>
        public string? OpenAssignmentId => _assignmentId;

        /// <summary>Held closed to keep an assignment response in flight while
        /// the test does something else - the only way to make the race between
        /// a poll and a sign-out deterministic rather than timing-dependent.</summary>
        private volatile TaskCompletionSource? _holdAssignment;

        /// <summary>Blocks the next assignment responses until Release is
        /// called, and returns a task that completes once one is waiting.</summary>
        public Task HoldAssignmentResponses()
        {
            var arrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _assignmentArrived = arrived;
            _holdAssignment = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            return arrived.Task;
        }

        public void ReleaseAssignmentResponses() => _holdAssignment?.TrySetResult();

        private volatile TaskCompletionSource? _assignmentArrived;

        /// <summary>Old enough to sit before any lap a test emits, for the cases
        /// that do not care when the driver checked in.</summary>
        private static readonly DateTimeOffset DefaultStartedAt =
            DateTimeOffset.Parse("2026-07-12T00:00:00Z");

        public void Assign(string? assignmentId, DateTimeOffset? startedAt = null)
        {
            Interlocked.Exchange(
                ref _startedAtTicks, (startedAt ?? DefaultStartedAt).UtcTicks);
            _assignmentId = assignmentId;
        }

        /// <summary>The venue's network as a switch. While it is off every call
        /// throws, which is all the agent ever sees during an outage.</summary>
        public void SetOffline(bool offline) => _offline = offline;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (_offline) throw new HttpRequestException("venue network is down");

            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/assignment") && _holdAssignment is { } gate)
            {
                _assignmentArrived?.TrySetResult();
                // Honour the token: a test that fails before releasing this gate
                // would otherwise leave AgentService.DisposeAsync awaiting a poll
                // loop that can never finish, hanging the entire test run rather
                // than failing one case.
                await gate.Task.WaitAsync(cancellationToken);
            }

            var body = path.EndsWith("/assignment")
                ? AssignmentBody(
                    _assignmentId,
                    new DateTimeOffset(Interlocked.Read(ref _startedAtTicks), TimeSpan.Zero))
                : path.EndsWith("/checkout")
                    ? Checkout(await ReadAssignmentId(request, cancellationToken))
                    : """{"results":[]}""";

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }

        /// <summary>The route's rule: close the named assignment if it is the
        /// one open here, or whatever is open when none is named.</summary>
        private string Checkout(string? target)
        {
            lock (_checkoutLock)
            {
                _checkouts.Add(target);
                var open = _assignmentId;
                var ends = open is not null && (target is null || target == open);
                if (ends) _assignmentId = null;
                return ends ? """{"ended":true}""" : """{"ended":false}""";
            }
        }

        private static async Task<string?> ReadAssignmentId(
            HttpRequestMessage request, CancellationToken ct)
        {
            if (request.Content is null) return null;
            var raw = await request.Content.ReadAsStringAsync(ct);
            if (string.IsNullOrWhiteSpace(raw)) return null;
            return JsonNode.Parse(raw)?["assignmentId"]?.GetValue<string>();
        }

        private static string AssignmentBody(string? assignmentId, DateTimeOffset startedAt) =>
            assignmentId is null
                ? """{"assignment":null}"""
                : """{"assignment":{"id":"""
                  + $"\"{assignmentId}\",\"startedAt\":\"{startedAt:o}\""
                  + ""","driver":{"id":"d1","displayName":"AuditDriver"}}}""";
    }

    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "t",
        RigNumber = 1,
    };

    /// <summary>Waits until a published status satisfies <paramref name="predicate"/>.
    /// The assignment poll is asynchronous, so a test that fires a lap without
    /// waiting would be racing it.</summary>
    private static async Task WaitForStatus(
        AgentService agent, Func<AgentStatus, bool> predicate, TimeSpan? timeout = null)
    {
        var reached = new TaskCompletionSource();
        agent.StatusChanged += status =>
        {
            if (predicate(status)) reached.TrySetResult();
        };
        await reached.Task.WaitAsync(timeout ?? TimeSpan.FromSeconds(10));
    }

    /// <summary>The audit's sequence, at the agent: a driver's laps carry their
    /// assignment, and the laps driven after they check out carry no owner at
    /// all rather than waiting to inherit the next driver's.</summary>
    [Fact]
    public async Task Laps_driven_after_checkout_are_not_stamped_with_the_old_assignment()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
        agent.Start();
        await assigned;

        telemetry.Emit("evt-while-checked-in");

        // The driver hits "switch driver": the agent knows immediately, without
        // waiting for the next 10s assignment poll.
        Assert.Equal(SwitchDriverResult.Ended, await agent.SwitchDriverAsync());

        telemetry.Emit("evt-after-checkout");

        var queued = queue.PendingBatch(10);
        Assert.Equal(
            AssignmentId,
            queued.Single(e => e.EventId == "evt-while-checked-in")
                .Payload["rigAssignmentId"]!.GetValue<string>());
        Assert.Null(
            queued.Single(e => e.EventId == "evt-after-checkout")
                .Payload["rigAssignmentId"]);
    }

    /// <summary>A sign-out that happens while an assignment poll is in flight
    /// must win. The poll was answered from the rig's state BEFORE the sign-out,
    /// so applying it would reinstate a stint the driver has ended and stamp
    /// every later lap with it - a lap the server would still accept, because
    /// the assignment's window has 15 minutes of clock-skew grace past its own
    /// ended_at. The response is dropped instead.</summary>
    [Fact]
    public async Task A_poll_answered_before_a_sign_out_does_not_reinstate_the_assignment()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
        agent.Start();
        await assigned;

        // Hold the NEXT assignment response open, and wait until one is actually
        // waiting, so the sign-out below is racing a real in-flight poll.
        var pollInFlight = backend.HoldAssignmentResponses();
        try
        {
            await pollInFlight.WaitAsync(TimeSpan.FromSeconds(30));

            Assert.Equal(SwitchDriverResult.Ended, await agent.SwitchDriverAsync());
        }
        finally
        {
            // The held poll now answers with the pre-sign-out assignment. This
            // runs even if the wait or the checkout failed, so a failing case
            // still lets the agent shut down.
            backend.ReleaseAssignmentResponses();
        }
        await Task.Delay(300);

        telemetry.Emit("evt-after-signout");

        // Stamped with nobody, not with the stint the late response described.
        Assert.Null(
            queue.PendingBatch(10).Single(e => e.EventId == "evt-after-signout")
                .Payload["rigAssignmentId"]);
    }

    /// <summary>A rig nobody has checked into stamps null, and says so
    /// explicitly - an absent key would mean something else to the backend.</summary>
    [Fact]
    public async Task Laps_on_an_unassigned_rig_are_stamped_with_an_explicit_null()
    {
        var backend = new StubBackend();
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        // Wait for a completed poll, so null means "asked and nobody is there".
        // Connection alone would not do: the heartbeat can turn the agent online
        // before the poll comes back, and a lap captured in that gap has no
        // answer to stamp yet.
        var polled = WaitForStatus(agent, s => s.AssignmentKnown);
        agent.Start();
        await polled;

        telemetry.Emit("evt-unassigned");

        var payload = queue.PendingBatch(1).Single().Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
    }

    /// <summary>The outage this deferred stamp exists for. The driver checks in
    /// at 18:30, the venue backend goes unreachable, and the rig PC reboots - so
    /// the agent starts having never polled and cannot say who is in the seat.
    /// Every lap they drive from 18:40 is inside their stint, so all of them
    /// take that driver's assignment once the first poll gets through. Stamping
    /// null instead would tell the backend the rig was empty and lose their laps
    /// for good.</summary>
    [Fact]
    public async Task Laps_captured_before_the_first_poll_take_that_polls_assignment()
    {
        var checkedInAt = DateTimeOffset.Parse("2026-08-22T18:30:00Z");
        var backend = new StubBackend();
        backend.Assign(AssignmentId, checkedInAt);
        backend.SetOffline(true);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var offline = WaitForStatus(agent, s => s.Connection == ConnectionState.Offline);
        agent.Start();
        await offline;

        telemetry.Emit("evt-outage-lap-1", checkedInAt.AddMinutes(10));
        telemetry.Emit("evt-outage-lap-2", checkedInAt.AddMinutes(12));

        // Durably queued, and deliberately unsendable: the agent has no answer
        // to give, and an explicit null would be the wrong one.
        Assert.Equal(2, queue.PendingCount());
        Assert.Empty(queue.PendingBatch(10));

        // The network comes back. The next poll is up to one interval away.
        var assigned = WaitForStatus(
            agent, s => s.Assignment?.Id == AssignmentId, TimeSpan.FromSeconds(30));
        backend.SetOffline(false);
        await assigned;

        var batch = queue.PendingBatch(10);
        Assert.Equal(2, batch.Count);
        Assert.All(
            batch,
            e => Assert.Equal(AssignmentId, e.Payload["rigAssignmentId"]!.GetValue<string>()));
    }

    /// <summary>The morning boot, which the deferred stamp must not turn back
    /// into the defect this whole change removes. The rig PC comes up at 09:00
    /// with the venue network still down, so the agent has never polled. A
    /// walk-up guest drives at 09:05 with nobody checked in. The first customer
    /// checks in at 09:12 from their phone, and the network returns at 09:13.
    /// The guest's lap was driven before that customer sat down, so it belongs
    /// to nobody and must resolve to an explicit null - crediting it to the
    /// customer would put a stranger's time under their name.</summary>
    [Fact]
    public async Task A_lap_driven_before_the_first_polls_check_in_resolves_to_nobody()
    {
        var bootedAt = DateTimeOffset.Parse("2026-08-22T09:00:00Z");
        var backend = new StubBackend();
        backend.SetOffline(true);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var offline = WaitForStatus(agent, s => s.Connection == ConnectionState.Offline);
        agent.Start();
        await offline;

        telemetry.Emit("evt-guest-shakedown", bootedAt.AddMinutes(5));

        // The customer checks in at 09:12, and the network is back at 09:13.
        backend.Assign(AssignmentId, bootedAt.AddMinutes(12));
        var assigned = WaitForStatus(
            agent, s => s.Assignment?.Id == AssignmentId, TimeSpan.FromSeconds(30));
        backend.SetOffline(false);
        await assigned;

        var payload = queue.PendingBatch(10).Single().Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
    }

    /// <summary>The switch-driver button while the venue's link is down. The
    /// driver has left the seat; the backend simply has not been told. Gating
    /// the local clear on the backend's answer left the departed driver in the
    /// seat as far as this agent was concerned, so the next person's laps were
    /// stamped with their assignment and - because that assignment was never
    /// closed either - credited to them as valid, ranking laps once the outbox
    /// drained. The stint ends here whether or not the backend can be
    /// reached.</summary>
    [Fact]
    public async Task Switch_driver_ends_the_stint_locally_when_the_backend_is_unreachable()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
        agent.Start();
        await assigned;

        // The link drops, and the driver presses switch driver anyway.
        backend.SetOffline(true);
        await agent.SwitchDriverAsync();

        // The next person sits down without scanning the QR - which they cannot
        // do anyway, with the venue offline - and drives.
        telemetry.Emit("evt-next-driver-lap");

        var payload = queue.PendingBatch(10)
            .Single(e => e.EventId == "evt-next-driver-lap").Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
    }

    /// <summary>The other half of that press: the backend is still owed a
    /// checkout, and gets it as soon as the link is back. Losing it would leave
    /// the departed driver's stint open all night, which is what let their
    /// assignment go on accepting laps in the first place.</summary>
    [Fact]
    public async Task A_switch_driver_the_backend_missed_is_delivered_when_the_link_returns()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
        agent.Start();
        await assigned;

        backend.SetOffline(true);
        Assert.Equal(SwitchDriverResult.EndedPendingSync, await agent.SwitchDriverAsync());
        Assert.Equal(AssignmentId, queue.ReadPendingCheckout());

        var delivered = WaitForStatus(agent, s => !s.CheckoutPending, TimeSpan.FromSeconds(30));
        backend.SetOffline(false);
        await delivered;

        Assert.Equal(new string?[] { AssignmentId }, backend.Checkouts);
        Assert.Null(backend.OpenAssignmentId);
        Assert.Null(queue.ReadPendingCheckout());
    }

    /// <summary>The retry's sharpest edge. The rig's own link is down, not the
    /// venue's, so the next driver checks in from their phone - which closes the
    /// departed driver's stint and opens theirs. When the rig reconnects, the
    /// queued checkout must end the stint it was pressed for and leave the new
    /// one alone. A checkout meaning "close whatever is open here" would sign
    /// the new driver out of a seat they are sitting in.</summary>
    [Fact]
    public async Task A_queued_checkout_does_not_close_a_stint_the_next_driver_has_started()
    {
        const string nextAssignmentId = "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f";
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
        agent.Start();
        await assigned;

        backend.SetOffline(true);
        await agent.SwitchDriverAsync();

        // The next driver's check-in takes the seat over server-side.
        backend.Assign(nextAssignmentId);

        var reconnected = WaitForStatus(
            agent,
            s => s.Assignment?.Id == nextAssignmentId && !s.CheckoutPending,
            TimeSpan.FromSeconds(30));
        backend.SetOffline(false);
        await reconnected;

        Assert.Equal(new string?[] { AssignmentId }, backend.Checkouts);
        Assert.Equal(nextAssignmentId, backend.OpenAssignmentId);

        // And the new driver is picked up normally: the checkout tombstone
        // suppresses the stint it names, not whoever comes next.
        telemetry.Emit("evt-next-driver-checked-in");
        Assert.Equal(
            nextAssignmentId,
            queue.PendingBatch(10).Single(e => e.EventId == "evt-next-driver-checked-in")
                .Payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>The retry may land after the stint has already been closed some
    /// other way - here staff clear the rig from the dashboard while the agent
    /// is offline. The backend has nothing to close, says so, and the agent
    /// stops asking rather than re-sending a checkout every poll for the rest of
    /// the night.</summary>
    [Fact]
    public async Task A_queued_checkout_is_settled_by_a_backend_that_has_nothing_left_to_close()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
        agent.Start();
        await assigned;

        backend.SetOffline(true);
        await agent.SwitchDriverAsync();

        // Staff clear the rig while the agent cannot see it happen.
        backend.Assign(null);

        var settled = WaitForStatus(agent, s => !s.CheckoutPending, TimeSpan.FromSeconds(30));
        backend.SetOffline(false);
        await settled;

        Assert.Equal(new string?[] { AssignmentId }, backend.Checkouts);
        Assert.Null(queue.ReadPendingCheckout());
    }

    /// <summary>The outage that also takes the rig PC with it. The driver signs
    /// out, the agent cannot deliver the checkout, and the machine reboots
    /// before the link returns. On the way back up the backend still reports
    /// that stint as open, because it was never told - and an agent that had
    /// forgotten the sign-out would adopt the departed driver again and stamp
    /// the next person's laps with them. The checkout is on disk, so it does
    /// not.</summary>
    [Fact]
    public async Task A_checkout_the_backend_never_received_survives_a_rig_restart()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");

        using (var queue = new EventQueue(_dbPath))
        {
            var telemetry = new FakeTelemetrySource();
            await using var agent = new AgentService(Config(), client, queue, telemetry);
            var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
            agent.Start();
            await assigned;

            backend.SetOffline(true);
            Assert.Equal(SwitchDriverResult.EndedPendingSync, await agent.SwitchDriverAsync());
        }

        // The link comes back before the rig PC does, so the agent starts fresh
        // against a backend that still believes the departed driver is in place.
        backend.SetOffline(false);
        Assert.Equal(AssignmentId, backend.OpenAssignmentId);

        using var restarted = new EventQueue(_dbPath);
        Assert.Equal(AssignmentId, restarted.ReadPendingCheckout());

        var rebooted = new FakeTelemetrySource();
        await using var agent2 = new AgentService(Config(), client, restarted, rebooted);
        var caughtUp = WaitForStatus(
            agent2,
            s => s.AssignmentKnown && !s.CheckoutPending,
            TimeSpan.FromSeconds(30));
        agent2.Start();
        await caughtUp;

        Assert.Null(backend.OpenAssignmentId);
        Assert.Equal(new string?[] { AssignmentId }, backend.Checkouts);

        rebooted.Emit("evt-after-reboot");
        var payload = restarted.PendingBatch(10)
            .Single(e => e.EventId == "evt-after-reboot").Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
