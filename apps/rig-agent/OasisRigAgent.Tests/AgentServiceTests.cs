using System.Net;
using System.Text;
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
    /// posts always answer with an empty result list so the flush loop never
    /// settles (and therefore never deletes) what the test is inspecting.</summary>
    private sealed class StubBackend : HttpMessageHandler
    {
        private volatile string? _assignmentId;
        private volatile bool _offline;
        private long _startedAtTicks = DefaultStartedAt.UtcTicks;

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

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (_offline) throw new HttpRequestException("venue network is down");

            var path = request.RequestUri!.AbsolutePath;
            var body = path.EndsWith("/assignment")
                ? AssignmentBody(
                    _assignmentId,
                    new DateTimeOffset(Interlocked.Read(ref _startedAtTicks), TimeSpan.Zero))
                : path.EndsWith("/checkout")
                    ? """{"ended":true}"""
                    : """{"results":[]}""";

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
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
        Assert.True(await agent.SwitchDriverAsync());
        backend.Assign(null);

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

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
