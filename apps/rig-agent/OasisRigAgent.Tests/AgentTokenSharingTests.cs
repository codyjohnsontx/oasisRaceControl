using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Whole-agent behaviour on a rig whose token a second computer is also using.
///
/// This is the fleet's install mistake, not a per-machine fault: twenty-plus
/// simulators are set up by copying one machine's folder, and copying
/// agent.config.json with it puts two rigs on one token. The backend can no
/// longer say whose customer drove a lap, so it refuses to attribute any of
/// them - from either machine. The agent's job in that state is to lose
/// nothing, keep every held lap in its own durable outbox, and say plainly
/// that waiting will not fix it.
/// </summary>
public sealed class AgentTokenSharingTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-conflict-{Guid.NewGuid():N}.db");

    /// <summary>A backend that answers every lap with `rig_conflict` until the
    /// second machine is given its own token, and accepts everything after.</summary>
    private sealed class ConflictedBackend : HttpMessageHandler
    {
        public volatile bool TokenStillShared = true;
        public int LapPosts;
        public string? LastHeartbeatBody;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/assignment", StringComparison.Ordinal))
                return Respond("""{"assignment":null}""");

            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var events = JsonNode.Parse(body)!["events"]!.AsArray();
            if (events.Any(e => e!["type"]!.GetValue<string>() == "RIG_HEARTBEAT"))
            {
                LastHeartbeatBody = body;
                return Respond("""{"results":[{"type":"RIG_HEARTBEAT","status":"ok"}]}""");
            }

            Interlocked.Increment(ref LapPosts);
            var results = new JsonArray();
            foreach (var e in events)
            {
                results.Add(new JsonObject
                {
                    ["type"] = "LAP_COMPLETED",
                    ["eventId"] = e!["eventId"]!.GetValue<string>(),
                    ["status"] = TokenStillShared ? "rig_conflict" : "accepted",
                });
            }
            return Respond(new JsonObject { ["results"] = results }.ToJsonString());
        }

        private static HttpResponseMessage Respond(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private sealed class IdleTelemetry : ITelemetrySource
    {
        public bool SimRunning => false;
        public string? SimUnusableReason => null;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() => _ = LapCompleted;
        public void Stop() { }
    }

    private sealed class RecordingLog : IAgentLog
    {
        public readonly List<string> Lines = new();
        public void Write(string level, string message) { lock (Lines) Lines.Add(message); }
        public string[] Snapshot() { lock (Lines) return Lines.ToArray(); }
    }

    private static LapCompleted Lap(string eventId) => new()
    {
        EventId = eventId,
        TrackName = "Spa-Francorchamps",
        CarName = "Porsche 911 GT3 R",
        LapNumber = 4,
        LapTimeMs = 138_103,
        IncidentDelta = 0,
        CompletedAt = DateTimeOffset.UtcNow,
    };

    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "t",
        RigNumber = 1,
    };

    private static async Task<AgentStatus> RunUntil(AgentService agent, Func<AgentStatus, bool> reached)
    {
        var done = new TaskCompletionSource<AgentStatus>();
        agent.StatusChanged += status =>
        {
            if (reached(status)) done.TrySetResult(status);
        };
        agent.Start();
        return await done.Task.WaitAsync(TimeSpan.FromSeconds(20));
    }

    private static async Task<AgentStatus> WaitFor(AgentService agent, Func<AgentStatus, bool> reached)
    {
        var done = new TaskCompletionSource<AgentStatus>();
        agent.StatusChanged += status =>
        {
            if (reached(status)) done.TrySetResult(status);
        };
        return await done.Task.WaitAsync(TimeSpan.FromSeconds(20));
    }

    [Fact]
    public async Task Every_held_lap_stays_in_the_rigs_own_outbox()
    {
        var backend = new ConflictedBackend();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-0002"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry());

        var status = await RunUntil(agent, s => s.RigTokenShared);

        // Nothing settled, nothing quarantined: these are two customers' real
        // times and the refusal reverses itself as soon as the config is fixed.
        Assert.Equal(2, queue.PendingCount());
        Assert.Equal(0, queue.QuarantinedCount());
        Assert.Equal(2, status.PendingLaps);
        Assert.Equal(ConnectionState.Online, status.Connection);
    }

    [Fact]
    public async Task The_rig_says_why_it_is_stacking_laps_rather_than_looking_patient()
    {
        // A queue that grows on a rig that is online reads as an outage, and an
        // outage is something you wait out. This one is not: somebody has to give
        // the second machine its own token, and nobody will if nothing says so.
        var backend = new ConflictedBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry(),
            log);

        await RunUntil(agent, s => s.RigTokenShared);

        var lines = log.Snapshot();
        Assert.Contains(lines, l => l.Contains("another computer is using this rig's token", StringComparison.Ordinal));
        Assert.Contains(lines, l => l.Contains("agent.config.json", StringComparison.Ordinal));
    }

    [Fact]
    public async Task It_says_it_once_rather_than_every_five_seconds()
    {
        // The log is the only account of a night on an unattended machine. One
        // line every flush would bury the reason it was written for under a
        // thousand copies of itself before anybody reads it.
        var backend = new ConflictedBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry(),
            log);

        await RunUntil(agent, s => s.RigTokenShared);
        await Task.Delay(TimeSpan.FromSeconds(11)); // two more flushes

        Assert.True(backend.LapPosts >= 2, $"expected the agent to keep retrying, saw {backend.LapPosts} posts");
        Assert.Single(
            log.Snapshot(),
            l => l.Contains("another computer is using this rig's token", StringComparison.Ordinal));
    }

    [Fact]
    public async Task The_held_laps_deliver_themselves_once_each_rig_has_its_own_token()
    {
        // The whole reason for holding rather than refusing: the fix is a config
        // edit at the desk, and no customer's time should need recovering by hand
        // afterwards.
        var backend = new ConflictedBackend();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-0002"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry());

        await RunUntil(agent, s => s.RigTokenShared);
        backend.TokenStillShared = false;
        var recovered = await WaitFor(agent, s => s.PendingLaps == 0);

        Assert.False(recovered.RigTokenShared);
        Assert.Equal(0, queue.PendingCount());
        Assert.Equal(0, queue.QuarantinedCount());
    }

    [Fact]
    public async Task Every_heartbeat_says_which_computer_this_is()
    {
        // The backend cannot see the clash at all unless this is on the wire, so
        // this asserts the bytes rather than the object that produced them.
        var backend = new ConflictedBackend();
        using var queue = new EventQueue(_dbPath);
        var identity = new InstallationIdentity("aaaaaaaabbbbbbbbccccccccdddddddd", "RIG-03");

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry(),
            null,
            null,
            identity);

        agent.Start();
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (backend.LastHeartbeatBody is null && DateTime.UtcNow < deadline)
            await Task.Delay(50);

        var heartbeat = JsonNode.Parse(backend.LastHeartbeatBody!)!["events"]![0]!;
        Assert.Equal("aaaaaaaabbbbbbbbccccccccdddddddd", (string?)heartbeat["installationId"]);
        Assert.Equal("RIG-03", (string?)heartbeat["machineName"]);
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { }
    }
}
