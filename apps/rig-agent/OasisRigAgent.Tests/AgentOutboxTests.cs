using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Whole-agent behaviour when the outbox holds a lap the backend will not take.
///
/// This is a fleet problem rather than a lap problem. The backend validates a
/// submission as one document, so a single event it cannot parse fails the whole
/// batch — and the batch is the head of a durable queue that is resent every five
/// seconds. Left alone, one bad lap on one rig means that rig stops scoring for
/// the rest of the day and reads as offline on the staff dashboard, with twenty
/// more machines nobody is watching closely enough to notice quickly.
/// </summary>
public sealed class AgentOutboxTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-outbox-{Guid.NewGuid():N}.db");

    /// <summary>Nobody is checked in and heartbeats are fine; the interesting
    /// part is the event post, which is refused outright whenever the batch
    /// carries the poison event and accepted in full otherwise.</summary>
    private sealed class PoisonBackend(string poison) : HttpMessageHandler
    {
        public int LapPosts;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/assignment", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, """{"assignment":null}""");

            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var events = JsonNode.Parse(body)!["events"]!.AsArray();
            if (events.Any(e => e!["type"]!.GetValue<string>() == "RIG_HEARTBEAT"))
                return Respond(HttpStatusCode.OK, """{"results":[{"type":"RIG_HEARTBEAT","status":"ok"}]}""");

            Interlocked.Increment(ref LapPosts);
            if (body.Contains(poison, StringComparison.Ordinal))
            {
                return Respond(
                    HttpStatusCode.BadRequest,
                    """{"error":"invalid_input","detail":[{"path":["events",0,"trackName"],"message":"too big"}]}""");
            }

            var results = new JsonArray();
            foreach (var e in events)
            {
                results.Add(new JsonObject
                {
                    ["type"] = "LAP_COMPLETED",
                    ["eventId"] = e!["eventId"]!.GetValue<string>(),
                    ["status"] = "accepted",
                });
            }
            return Respond(HttpStatusCode.OK, new JsonObject { ["results"] = results }.ToJsonString());
        }

        private static HttpResponseMessage Respond(HttpStatusCode status, string body) =>
            new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private sealed class IdleTelemetry : ITelemetrySource
    {
        public bool SimRunning => false;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() => _ = LapCompleted;
        public void Stop() { }
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

    /// <summary>Waits for the agent to publish a status matching
    /// <paramref name="reached"/>, so the assertions never race the flush loop.</summary>
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

    [Fact]
    public async Task One_lap_the_backend_refuses_does_not_stop_the_rig_scoring()
    {
        // The laps behind the bad one are ordinary customer times. They have to
        // reach the leaderboard on this flush, not after somebody drives to the
        // venue and clears a database by hand.
        var backend = new PoisonBackend("evt-poison");
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-poison"));
        queue.Enqueue(Lap("evt-0003"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry());

        var status = await RunUntil(agent, s => s.PendingLaps == 0 && s.QuarantinedLaps == 1);

        Assert.Equal(ConnectionState.Online, status.Connection);
        Assert.Equal(0, queue.PendingCount());
        Assert.Equal(1, queue.QuarantinedCount());
    }

    [Fact]
    public async Task A_refused_lap_is_not_posted_again_on_the_next_flush()
    {
        // The failure this exists to stop is a retry loop, so the proof is that
        // the retries stop. A queue that has quarantined its bad lap has nothing
        // left to send, and the agent goes quiet until the next real lap.
        var backend = new PoisonBackend("evt-poison");
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-poison"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry());

        await RunUntil(agent, s => s.QuarantinedLaps == 1);
        var postsAfterFirstFlush = backend.LapPosts;
        await Task.Delay(TimeSpan.FromSeconds(6)); // longer than the flush interval

        Assert.Equal(postsAfterFirstFlush, backend.LapPosts);
    }

    [Fact]
    public async Task A_rejection_is_written_where_somebody_can_find_it()
    {
        // The rig is unattended and the lap is gone from the queue, so the log
        // line is the only account of why one customer's time never appeared.
        var backend = new PoisonBackend("evt-poison");
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-poison"));

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new IdleTelemetry(),
            log);

        await RunUntil(agent, s => s.QuarantinedLaps == 1);

        var line = Assert.Single(log.Lines, l => l.Contains("evt-poison", StringComparison.Ordinal));
        Assert.Contains("invalid_input", line);
    }

    private sealed class RecordingLog : IAgentLog
    {
        private readonly object _lock = new();
        private readonly List<string> _lines = new();
        public IReadOnlyList<string> Lines { get { lock (_lock) return _lines.ToList(); } }
        public void Write(string level, string message)
        {
            lock (_lock) _lines.Add($"{level} {message}");
        }
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
