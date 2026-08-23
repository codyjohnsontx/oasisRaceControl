using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using OasisRigAgent.Tests.IRacing;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Whole-agent behaviour around lap ownership. The venue's core invariant is
/// that every lap is attributed to the correct driver, exactly once, and never
/// reassigned — so the agent has to name the driver at the moment the lap is
/// driven, not at the moment the lap finally reaches the backend.
/// </summary>
public sealed class AgentServiceTests : IDisposable
{
    private const string AliceAssignment = "3f1c0a7e-2b44-4d19-9c8a-11d2f0a5b6c7";
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-agent-{Guid.NewGuid():N}.db");

    /// <summary>Serves the assignment poll from a swappable value; every event
    /// post fails, so the flush loop can never drain the outbox out from under
    /// an assertion.</summary>
    private sealed class BackendStub : HttpMessageHandler
    {
        public volatile string? AssignmentId;

        /// <summary>Heartbeat bodies as they went over the wire. What the staff
        /// dashboard ends up showing is decided by these bytes, so the test reads
        /// them rather than the agent's own idea of its state.</summary>
        public ConcurrentQueue<JsonNode> Heartbeats { get; } = new();

        /// <summary>Lap bodies as they went over the wire. Whether a lap counts is
        /// decided by the backend from these bytes, so what the agent believes about
        /// the lap is not the thing to assert on.</summary>
        public ConcurrentQueue<JsonNode> Laps { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/events", StringComparison.Ordinal) && request.Content is not null)
            {
                var body = request.Content.ReadAsStringAsync(cancellationToken).GetAwaiter().GetResult();
                foreach (var e in JsonNode.Parse(body)!["events"]!.AsArray())
                {
                    if ((string?)e!["type"] == "RIG_HEARTBEAT") Heartbeats.Enqueue(e);
                    else if ((string?)e!["type"] == "LAP_COMPLETED") Laps.Enqueue(e);
                }
            }
            if (path.EndsWith("/assignment", StringComparison.Ordinal))
            {
                var id = AssignmentId;
                var assignment = id is null ? null : new JsonObject
                {
                    ["id"] = id,
                    ["startedAt"] = DateTimeOffset.UtcNow.ToString("o"),
                    ["driver"] = new JsonObject { ["id"] = "d1", ["displayName"] = "Alice" },
                };
                return Respond(
                    HttpStatusCode.OK,
                    new JsonObject { ["assignment"] = assignment }.ToJsonString());
            }
            if (path.EndsWith("/checkout", StringComparison.Ordinal))
            {
                return Respond(HttpStatusCode.OK, """{"ended":true}""");
            }
            return Respond(HttpStatusCode.InternalServerError, "{}");
        }

        private static Task<HttpResponseMessage> Respond(HttpStatusCode status, string body) =>
            Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
    }

    /// <summary>Raises laps on demand, standing in for the live iRacing reader.</summary>
    private sealed class FakeTelemetry : ITelemetrySource
    {
        public bool SimRunning { get; set; } = true;
        public string? SimUnusableReason { get; set; }
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { }
        public void Emit(string eventId, bool offTrackSeen = false) => LapCompleted?.Invoke(new LapCompleted
        {
            EventId = eventId,
            TrackName = "Spa-Francorchamps",
            CarName = "Porsche 911 GT3 R",
            LapTimeMs = 138_103,
            IncidentDelta = 0,
            OffTrackSeen = offTrackSeen,
            CompletedAt = DateTimeOffset.UtcNow,
        });
    }

    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "t",
        RigNumber = 1,
    };

    /// <summary>Starts the agent and returns once its assignment poll has
    /// reported <paramref name="expected"/>, so tests never race the loop.</summary>
    private static async Task StartAndSettle(AgentService agent, string? expected)
    {
        var settled = new TaskCompletionSource();
        agent.StatusChanged += status =>
        {
            if (status.Assignment?.Id == expected) settled.TrySetResult();
        };
        agent.Start();
        await settled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static string? StampedAssignment(EventQueue queue, string eventId)
    {
        var payload = queue.PendingBatch(50).Single(e => e.EventId == eventId).Payload;
        return payload["rigAssignmentId"]?.GetValue<string>();
    }

    [Fact]
    public async Task A_lap_is_stamped_with_the_driver_checked_in_when_it_was_driven()
    {
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        var telemetry = new FakeTelemetry();
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        await StartAndSettle(agent, AliceAssignment);
        telemetry.Emit("evt-alice-0001");

        // The rig changes hands while the lap is still stuck in the outbox.
        stub.AssignmentId = null;

        Assert.Equal(AliceAssignment, StampedAssignment(queue, "evt-alice-0001"));
    }

    [Fact]
    public async Task A_lap_that_went_off_the_road_says_so_in_the_bytes_the_backend_reads()
    {
        // The backend, not the agent, decides whether a lap counts, and it can only
        // decide from what arrives. A lap that ran wide with no incident charged is
        // indistinguishable from a clean one unless this field carries.
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        var telemetry = new FakeTelemetry();
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        await StartAndSettle(agent, AliceAssignment);
        telemetry.Emit("evt-wide-0001", offTrackSeen: true);
        telemetry.Emit("evt-clean-0002");

        // The outbox is flushed on a five-second cadence and the first flush has
        // already been and gone by the time a lap is emitted, so the wait has to
        // outlast a whole interval or it is a coin toss on a loaded machine.
        await Until(() => stub.Laps.Count >= 2, "both laps to reach the wire", seconds: 20);

        var byId = stub.Laps.ToDictionary(e => (string)e["eventId"]!, e => e);
        Assert.True((bool)byId["evt-wide-0001"]["offTrackSeen"]!);
        Assert.False((bool)byId["evt-clean-0002"]["offTrackSeen"]!);
    }

    [Fact]
    public async Task A_lap_driven_with_nobody_checked_in_claims_no_driver()
    {
        var stub = new BackendStub { AssignmentId = null };
        var telemetry = new FakeTelemetry();
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        await StartAndSettle(agent, null);
        telemetry.Emit("evt-walkup-0001");

        Assert.Null(StampedAssignment(queue, "evt-walkup-0001"));
    }

    [Fact]
    public async Task Switching_driver_stops_the_agent_claiming_the_departed_driver()
    {
        // "Switch driver" on the rig ends the assignment locally. A lap driven
        // after that must not still name the driver who just left.
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        var telemetry = new FakeTelemetry();
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        await StartAndSettle(agent, AliceAssignment);
        stub.AssignmentId = null;
        await agent.SwitchDriverAsync();
        telemetry.Emit("evt-after-switch-0001");

        Assert.Null(StampedAssignment(queue, "evt-after-switch-0001"));
    }

    /// <summary>Waits for a condition the agent's own read thread brings about, so the
    /// live path is exercised rather than stepped by hand.</summary>
    private static async Task Until(Func<bool> condition, string what, int seconds = 5)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return;
            await Task.Delay(10);
        }

        Assert.Fail($"Timed out waiting for {what}.");
    }

    /// <summary>
    /// The whole agent against a simulator that publishes everything except the pit
    /// channel — what an iRacing update that renames one looks like on a rig.
    ///
    /// Driven through the real telemetry reader on its own thread rather than a
    /// stand-in, because the thing being checked is the whole chain: the sim is read,
    /// the shortfall is found, the laps are withheld, and the reason reaches the line
    /// staff read off the rig. Before this, that rig published its in-laps as real
    /// times and every screen the venue has said it was fine.
    /// </summary>
    [Fact]
    public async Task A_rig_whose_sim_cannot_be_judged_says_so_and_queues_nothing()
    {
        var sim = new FakeSim(omitted: ["OnPitRoad"]);
        using var telemetry = new IRacingTelemetrySource(1, new FakeSimConnectionFactory(sim));
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        var statuses = new List<AgentStatus>();
        agent.StatusChanged += statuses.Add;
        await StartAndSettle(agent, AliceAssignment);
        await Until(() => telemetry.Channels is not null, "the rig to check the sim it attached to");

        sim.CrossTheLine(4, 138.5f);
        await Task.Delay(50);
        sim.OnPitRoad(true).NextFrame();          // through the pits, unseen by the agent
        await Task.Delay(50);
        sim.CrossTheLine(5, 300.0f);              // the in-lap crosses the line
        await Task.Delay(200);

        Assert.Empty(queue.PendingBatch(50));
        Assert.False(telemetry.SimRunning);
        var reason = telemetry.SimUnusableReason;
        Assert.NotNull(reason);
        Assert.Contains("OnPitRoad", reason);

        // And it is on the status the rig shows, not only in a log on the machine.
        await agent.SwitchDriverAsync();
        Assert.Contains(statuses, status => status.SimUnusableReason == reason);
    }

    /// <summary>The same rig with a sim it can read: the reason is absent and the lap
    /// lands in the outbox on its way to the leaderboard, stamped with the driver who
    /// drove it. A check that only ever said "no" would be indistinguishable from the
    /// bug it replaced.</summary>
    [Fact]
    public async Task A_rig_whose_sim_checks_out_scores_normally()
    {
        var sim = new FakeSim();
        using var telemetry = new IRacingTelemetrySource(1, new FakeSimConnectionFactory(sim));
        var laps = new List<LapCompleted>();
        var rejected = new List<LapDetection>();
        telemetry.LapCompleted += laps.Add;
        telemetry.LapRejected += rejected.Add;
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        await StartAndSettle(agent, AliceAssignment);
        await Until(() => rejected.Count >= 1, "the agent to join the lap already under way");

        sim.CrossTheLine(4, 138.5f);
        await Until(() => rejected.Count >= 2, "the crossing that starts the first watchable lap");

        sim.CrossTheLine(5, 138.2f);
        await Until(() => laps.Count == 1, "the first judgeable lap");
        await Until(() => queue.PendingBatch(50).Count == 1, "that lap to reach the outbox");

        Assert.Null(telemetry.SimUnusableReason);
        Assert.True(telemetry.SimRunning);
        var queued = Assert.Single(queue.PendingBatch(50));
        Assert.Equal(AliceAssignment, queued.Payload["rigAssignmentId"]?.GetValue<string>());
        Assert.Equal(138_200, queued.Payload["lapTimeMs"]?.GetValue<int>());
    }

    /// <summary>
    /// The chain the staff dashboard actually reads: a rig that cannot judge a lap
    /// says so on its heartbeat, naming the channels, so a machine that is up and
    /// scoring nothing stops looking like a machine between customers.
    /// </summary>
    [Theory]
    [InlineData(true, null, "scoring", null)]
    [InlineData(false, null, "no_sim", null)]
    [InlineData(false, "the simulator does not publish OnPitRoad", "unreadable", "OnPitRoad")]
    // A rig Windows started outside the signed-in user's session: it reports the sim
    // as not running, exactly like the idle machines around it, and the only thing
    // that tells them apart on /staff is this reason travelling with the heartbeat.
    [InlineData(false, "this agent was started outside the rig's signed-in Windows session (it is in session 0), where iRacing's telemetry cannot be opened", "unreadable", "session 0")]
    // A rig whose iRacing publishes a telemetry layout this agent was not written
    // for. It arrives on the whole room on the same forced seasonal update, and the
    // machine reports the sim as not running exactly like the idle ones around it.
    [InlineData(false, "iRacing on this rig publishes telemetry format 3, and this agent reads format 2 - the agent needs updating", "unreadable", "format 3")]
    public async Task The_heartbeat_tells_the_dashboard_what_this_rig_can_do_with_its_sim(
        bool simRunning, string? reason, string expected, string? namesChannel)
    {
        var telemetry = new FakeTelemetry { SimRunning = simRunning, SimUnusableReason = reason };
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, telemetry);

        await StartAndSettle(agent, AliceAssignment);
        await Until(() => !stub.Heartbeats.IsEmpty, "the rig's first heartbeat");

        Assert.True(stub.Heartbeats.TryDequeue(out var heartbeat));
        Assert.Equal(expected, (string?)heartbeat!["simHealth"]);
        if (namesChannel is null) Assert.Null(heartbeat["simHealthDetail"]);
        else Assert.Contains(namesChannel, (string?)heartbeat["simHealthDetail"]);
    }

    /// <summary>
    /// The dashboard's answer to "which machines took the update" is written by this
    /// field, and the update is a walk round twenty-plus rigs. It has to be the build
    /// that is running: agent.config.json is the one file an update does NOT overwrite
    /// (it holds this rig's token), so a version read from there is frozen at install.
    /// </summary>
    [Fact]
    public async Task The_heartbeat_names_the_build_this_rig_is_running_not_one_its_config_claims()
    {
        var stub = new BackendStub { AssignmentId = AliceAssignment };
        using var queue = new EventQueue(_dbPath);
        // A config from an install that still writes the retired field, which is what
        // every rig updated from an earlier build actually has on disk.
        var config = Config() with { IgnoredConfigVersion = "rig-agent/0.1-skeleton" };
        await using var agent = new AgentService(
            config, new BackendClient(new HttpClient(stub), "https://x.test", "t"), queue, new FakeTelemetry());

        await StartAndSettle(agent, AliceAssignment);
        await Until(() => !stub.Heartbeats.IsEmpty, "the rig's first heartbeat");

        Assert.True(stub.Heartbeats.TryDequeue(out var heartbeat));
        Assert.Equal(AgentVersionInfo.Current, (string?)heartbeat!["agentVersion"]);
        Assert.NotEqual("rig-agent/0.1-skeleton", (string?)heartbeat["agentVersion"]);
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
