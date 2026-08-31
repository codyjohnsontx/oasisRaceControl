using System.Net;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
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

            if (path.EndsWith("/events") && ValidatesLapTimes)
                return await IngestEvents(request, cancellationToken);

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

        /// <summary>Opt in to the route's lapTimeMs bound. Off by default so the
        /// tests above keep their "nothing ever settles" backend, which is what
        /// lets them inspect an outbox the flush loop would otherwise drain.</summary>
        public bool ValidatesLapTimes { get; init; }

        /// <summary>MAX_LAP_TIME_MS from apps/web/src/lib/events.ts: thirty
        /// minutes. A lap past it is not a slow lap, it is a session timer or
        /// the wrong unit read as one.</summary>
        private const int MaxLapTimeMs = 30 * 60_000;

        private readonly object _storedLock = new();
        private readonly List<string> _stored = new();

        /// <summary>The laps this backend actually stored, in arrival order.</summary>
        public IReadOnlyList<string> StoredLapIds
        {
            get { lock (_storedLock) return _stored.ToArray(); }
        }

        /// <summary>What `POST /api/agent/events` does with a batch, faithfully
        /// enough for the wedge: the body is validated WHOLE, so one lap over
        /// the bound rejects all of them with 400 `invalid_input` and zod's
        /// issue list naming the offender by its position in the batch. Only a
        /// batch that passes stores anything.</summary>
        private async Task<HttpResponseMessage> IngestEvents(
            HttpRequestMessage request, CancellationToken ct)
        {
            var events = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!["events"]!.AsArray();

            var issues = new JsonArray();
            for (var i = 0; i < events.Count; i++)
            {
                var lapTimeMs = events[i]?["lapTimeMs"]?.GetValue<int>();
                if (lapTimeMs is null or <= MaxLapTimeMs) continue;
                issues.Add(new JsonObject
                {
                    ["origin"] = "number",
                    ["code"] = "too_big",
                    ["maximum"] = MaxLapTimeMs,
                    ["path"] = new JsonArray("events", i, "lapTimeMs"),
                    ["message"] = $"Too big: expected number to be <={MaxLapTimeMs}",
                });
            }
            if (issues.Count > 0)
                return Json(HttpStatusCode.BadRequest, new JsonObject
                {
                    ["error"] = "invalid_input",
                    ["detail"] = issues,
                });

            var results = new JsonArray();
            foreach (var e in events)
            {
                var type = e!["type"]!.GetValue<string>();
                if (type != "LAP_COMPLETED")
                {
                    results.Add(new JsonObject { ["type"] = type, ["status"] = "ok" });
                    continue;
                }
                var eventId = e["eventId"]!.GetValue<string>();
                lock (_storedLock) _stored.Add(eventId);
                results.Add(new JsonObject
                {
                    ["type"] = type, ["eventId"] = eventId, ["status"] = "accepted",
                });
            }
            return Json(HttpStatusCode.OK, new JsonObject { ["results"] = results });
        }

        private static HttpResponseMessage Json(HttpStatusCode status, JsonNode body) =>
            new(status)
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
            };

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

        var delivered = WaitForStatus(agent, s => s.Checkout == CheckoutDelivery.None, TimeSpan.FromSeconds(30));
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
            s => s.Assignment?.Id == nextAssignmentId && s.Checkout == CheckoutDelivery.None,
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

        var settled = WaitForStatus(agent, s => s.Checkout == CheckoutDelivery.None, TimeSpan.FromSeconds(30));
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
            s => s.AssignmentKnown && s.Checkout == CheckoutDelivery.None,
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

    /// <summary>The press this agent can do nothing about. The rig PC came up
    /// during the outage and has never polled, so it cannot name the stint the
    /// backend still holds open from the driver's own phone check-in: there is
    /// nothing to queue, and nothing will reach the backend when the link
    /// returns. Reporting it as a queued sign-out would tell staff the one thing
    /// that is not true - that this is handled - while the stale stint sits
    /// there ready to credit the next person's laps to whoever left.</summary>
    [Fact]
    public async Task Switch_driver_with_no_stint_to_name_promises_the_backend_nothing()
    {
        var backend = new StubBackend();
        backend.Assign(AssignmentId);
        backend.SetOffline(true);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var offline = WaitForStatus(agent, s => s.Connection == ConnectionState.Offline);
        agent.Start();
        await offline;

        AgentStatus? latest = null;
        agent.StatusChanged += s => latest = s;

        Assert.Equal(SwitchDriverResult.EndedNotQueued, await agent.SwitchDriverAsync());

        // The display must agree with what the driver was told: nothing is
        // waiting to be delivered, on this run or after a reboot. Not even the
        // in-memory marker - this press left no retry running to name.
        Assert.NotNull(latest);
        Assert.Equal(CheckoutDelivery.None, latest!.Checkout);
        Assert.Null(queue.ReadPendingCheckout());
    }

    /// <summary>The durable write is the whole reason the queued sign-out
    /// survives a rig reboot, so a press that could not record one must not
    /// claim the backend is going to be told. The retry still runs for as long
    /// as this agent lives, but the driver is pointed at the staff screen,
    /// because a restart before the link returns would lose it and let the
    /// first poll re-adopt the departed stint - the very misattribution this
    /// change exists to remove, one layer down.</summary>
    [Fact]
    public async Task A_sign_out_that_could_not_be_recorded_does_not_promise_delivery()
    {
        if (OperatingSystem.IsWindows()) return;

        await WithUnwritableOutbox(async queue =>
        {
            var backend = new StubBackend();
            backend.Assign(AssignmentId);
            var telemetry = new FakeTelemetrySource();
            using var http = new HttpClient(backend);
            var client = new BackendClient(http, "https://x.test", "t");
            await using var agent = new AgentService(Config(), client, queue, telemetry);

            var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
            agent.Start();
            await assigned;

            AgentStatus? last = null;
            agent.StatusChanged += s => last = s;

            backend.SetOffline(true);
            var result = await agent.SwitchDriverAsync();

            // Not EndedPendingSync: nothing on disk will make this happen after
            // a reboot, so the console must point at the staff screen instead.
            Assert.Equal(SwitchDriverResult.EndedNotQueued, result);
            Assert.Null(queue.ReadPendingCheckout());

            // The local clear still stands. It is the half that must never
            // depend on the outbox being writable.
            Assert.NotNull(last);
            Assert.Null(last!.Assignment);

            // And the line staff read all night has to say what the press said.
            // A sign-out held only in memory IS outstanding - that retry runs
            // for as long as this agent lives - so the display names it rather
            // than hiding it, but names it as one a restart would lose, not as
            // a delivery the backend is going to get.
            Assert.Equal(CheckoutDelivery.NotQueued, last.Checkout);
        });
    }

    /// <summary>The same bad outbox with the link UP, which is the half no
    /// outage is needed to reach. The backend accepts the sign-out, and the
    /// agent then has to forget it - another write to the same file. Escaping
    /// the press, that one lands in the console host's fire-and-forget input
    /// loop, where nothing catches it: no result line is printed and neither
    /// the button nor the quit key works again for the rest of the run. Losing
    /// reboot survival is what a bad outbox may cost; losing the button is the
    /// failure this whole path exists to remove.</summary>
    [Fact]
    public async Task A_delivered_sign_out_does_not_break_the_button_on_an_unwritable_outbox()
    {
        if (OperatingSystem.IsWindows()) return;

        await WithUnwritableOutbox(async queue =>
        {
            var backend = new StubBackend();
            backend.Assign(AssignmentId);
            var telemetry = new FakeTelemetrySource();
            using var http = new HttpClient(backend);
            var client = new BackendClient(http, "https://x.test", "t");
            await using var agent = new AgentService(Config(), client, queue, telemetry);

            var assigned = WaitForStatus(agent, s => s.Assignment?.Id == AssignmentId);
            agent.Start();
            await assigned;

            AgentStatus? last = null;
            agent.StatusChanged += s => last = s;

            Assert.Equal(SwitchDriverResult.Ended, await agent.SwitchDriverAsync());
            Assert.Null(backend.OpenAssignmentId);

            // The backend has it, so nothing is outstanding and the display
            // says so - an in-memory retry left running against a stint that is
            // already closed would ask every poll for the rest of the night.
            Assert.NotNull(last);
            Assert.Equal(CheckoutDelivery.None, last!.Checkout);
        });
    }

    /// <summary>Runs <paramref name="body"/> against an outbox whose schema is
    /// <summary>A lap already in the outbox when the agent starts - a rig coming
    /// back from an outage with a backlog, which is exactly when a bad lap is
    /// sitting in front of good ones.</summary>
    private static LapCompleted Backlog(string eventId, int lapTimeMs) => new()
    {
        EventId = eventId,
        TrackName = "Spa-Francorchamps",
        TrackConfig = "Grand Prix Pits",
        CarName = "Porsche 911 GT3 R",
        LapNumber = 1,
        LapTimeMs = lapTimeMs,
        IncidentDelta = 0,
        CompletedAt = DateTimeOffset.UtcNow,
    };

    /// <summary>The wedge, end to end at the agent.
    ///
    /// The backend validates a batch whole, so one lap it will not accept fails
    /// all fifty. The agent could not tell that 400 from the venue's network
    /// being down: it marked the rig offline and the next flush re-sent the
    /// identical batch five seconds later, and again, and again - every lap
    /// queued behind the bad one going nowhere for the rest of the night.
    ///
    /// The over-bound lap here is the case PR #23's review found to be reachable
    /// with real telemetry rather than only with corrupt data: iRacing's
    /// LapLastLapTime includes pit-box time, so a driver who parks for half an
    /// hour and comes back out produces a genuine in-lap past the thirty-minute
    /// bound.</summary>
    [Fact]
    public async Task A_lap_the_backend_refuses_is_parked_and_the_laps_behind_it_go_through()
    {
        var backend = new StubBackend { ValidatesLapTimes = true };
        backend.Assign(AssignmentId);
        var telemetry = new FakeTelemetrySource();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Backlog("evt-flying-lap", 138_400), AssignmentId);
        queue.Enqueue(Backlog("evt-pit-in-lap", 2_190_000), AssignmentId);
        queue.Enqueue(Backlog("evt-out-lap", 137_900), AssignmentId);

        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        var seen = new List<ConnectionState>();
        agent.StatusChanged += status => { lock (seen) seen.Add(status.Connection); };
        agent.Start();

        // Two flush rounds five seconds apart: the first is refused and parks
        // the bad lap, the second carries the two good ones.
        await WaitForStatus(
            agent, s => s.PendingLaps == 0 && s.RejectedLaps == 1, TimeSpan.FromSeconds(30));

        Assert.Equal(new[] { "evt-flying-lap", "evt-out-lap" }, backend.StoredLapIds);
        var parked = Assert.Single(queue.RejectedEvents());
        Assert.Equal("evt-pit-in-lap", parked.EventId);
        // Kept with the reason, because somebody has to decide what becomes of it.
        Assert.Contains("lapTimeMs", parked.Reason);

        // A refusal is not an outage. The backend answered - it answered "no" -
        // and a rig that reports itself offline over that sends staff looking
        // for a network problem that is not there.
        lock (seen) Assert.DoesNotContain(ConnectionState.Offline, seen);
    }

    /// <summary>The refusal is final. Once parked, the lap is never offered
    /// again - not on the next flush, and not after the rig PC reboots, which
    /// would otherwise re-wedge the outbox on every restart.</summary>
    [Fact]
    public async Task A_parked_lap_is_not_offered_again_after_a_restart()
    {
        var backend = new StubBackend { ValidatesLapTimes = true };
        backend.Assign(AssignmentId);
        using var http = new HttpClient(backend);
        var client = new BackendClient(http, "https://x.test", "t");

        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Backlog("evt-pit-in-lap", 2_190_000), AssignmentId);
            await using var agent = new AgentService(Config(), client, queue, new FakeTelemetrySource());
            // Subscribed before Start: the only lap here is the bad one, so the
            // first flush parks it and publishes the final numbers straight
            // away - a wait attached afterwards would have missed them and hung.
            var parked = WaitForStatus(agent, s => s.PendingLaps == 0 && s.RejectedLaps == 1);
            agent.Start();
            await parked;
        }
        // Disposing a SqliteConnection returns it to the pool with the file
        // handle open, so the reopened queue must not inherit it.
        SqliteConnection.ClearAllPools();

        using var reopened = new EventQueue(_dbPath);
        // The next night's first lap. It is the probe: if the restarted agent
        // put the parked lap back in the batch, this good lap would 400 with it
        // and never drain - which is the wedge, one reboot later.
        reopened.Enqueue(Backlog("evt-next-night", 138_100), AssignmentId);
        await using var restarted = new AgentService(Config(), client, reopened, new FakeTelemetrySource());
        var drained = WaitForStatus(restarted, s => s.PendingLaps == 0);
        restarted.Start();
        await drained;

        Assert.Equal(new[] { "evt-next-night" }, backend.StoredLapIds);
        Assert.Equal(1, reopened.RejectedCount());
    }

    /// in place but whose file cannot be written, the way a read-only or a full
    /// disk makes every write fail. Reads still work, which is what the status
    /// line and these assertions need.
    ///
    /// Unix-only, so callers return early on Windows. The rig runs there, but
    /// the behaviour under test is platform-independent and the whole suite runs
    /// on the developer machines that build the agent.</summary>
    [UnsupportedOSPlatform("windows")]
    private async Task WithUnwritableOutbox(Func<EventQueue, Task> body)
    {
        using (var setup = new EventQueue(_dbPath)) { }
        // Disposing a SqliteConnection returns it to the pool with the file
        // handle still open, so without this the EventQueue below would reuse a
        // handle opened while the file was still writable and the writes would
        // succeed - the test would pass while proving nothing.
        SqliteConnection.ClearAllPools();
        // SetUnixFileMode rather than SetAttributes(ReadOnly): the latter does
        // not clear the write bit here.
        File.SetUnixFileMode(
            _dbPath, UnixFileMode.UserRead | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
        try
        {
            using var queue = new EventQueue(_dbPath);
            await body(queue);
        }
        finally
        {
            // So Dispose can delete it.
            File.SetUnixFileMode(
                _dbPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite
                    | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
        }
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
