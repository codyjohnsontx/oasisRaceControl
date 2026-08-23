using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Whole-agent behaviour on a rig the backend will not authenticate.
///
/// This is the enrolment mistake. A rig's identity is a secret typed at a command
/// line once per machine, twenty-plus times in an evening, and one mistyped
/// character produces a computer that queues every lap of the night into its own
/// outbox and never appears on the staff dashboard at all - because a rig that
/// cannot authenticate cannot heartbeat, and the dashboard's whole picture of a
/// rig is built from heartbeats.
///
/// The agent's job in that state is the same as under a shared token: lose
/// nothing, keep every lap, and say plainly that waiting will not fix it. What it
/// used to say instead was "offline", which is the same word it uses when the
/// venue's wifi drops - and on a night when one machine says offline and twenty
/// say online, the wrong word is the difference between somebody walking back to
/// this rig and nobody ever doing so.
/// </summary>
public sealed class AgentTokenRefusedTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-refused-{Guid.NewGuid():N}.db");

    /// <summary>A backend that refuses this rig's token until somebody fixes it,
    /// and accepts everything after - which is exactly what a re-enrolment looks
    /// like from here.</summary>
    private sealed class RefusingBackend : HttpMessageHandler
    {
        public volatile bool TokenWrong = true;
        public HttpStatusCode Refusal = HttpStatusCode.Unauthorized;
        public int Calls;

        /// <summary>Set to fail the transport instead, which is what an ordinary
        /// outage looks like: no status at all, because nothing answered.</summary>
        public volatile bool NetworkDown;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            if (NetworkDown) throw new HttpRequestException("No such host is known.");
            if (TokenWrong)
                return new HttpResponseMessage(Refusal)
                {
                    Content = new StringContent("""{"error":"unauthorized"}""", Encoding.UTF8, "application/json"),
                };

            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/assignment", StringComparison.Ordinal))
                return Respond("""{"assignment":null}""");

            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            var events = JsonNode.Parse(body)!["events"]!.AsArray();
            var results = new JsonArray();
            foreach (var e in events)
            {
                var type = e!["type"]!.GetValue<string>();
                var result = new JsonObject { ["type"] = type, ["status"] = type == "RIG_HEARTBEAT" ? "ok" : "accepted" };
                if (type != "RIG_HEARTBEAT") result["eventId"] = e["eventId"]!.GetValue<string>();
                results.Add(result);
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
        RigToken = "dev-rig-1-secert",
        RigNumber = 1,
    };

    private static AgentService Agent(RefusingBackend backend, EventQueue queue, IAgentLog? log = null) =>
        new(Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "dev-rig-1-secert"),
            queue,
            new IdleTelemetry(),
            log);

    private static async Task<AgentStatus> RunUntil(AgentService agent, Func<AgentStatus, bool> reached)
    {
        var done = new TaskCompletionSource<AgentStatus>();
        agent.StatusChanged += status => { if (reached(status)) done.TrySetResult(status); };
        agent.Start();
        return await done.Task.WaitAsync(TimeSpan.FromSeconds(20));
    }

    private static async Task<AgentStatus> WaitFor(AgentService agent, Func<AgentStatus, bool> reached)
    {
        var done = new TaskCompletionSource<AgentStatus>();
        agent.StatusChanged += status => { if (reached(status)) done.TrySetResult(status); };
        return await done.Task.WaitAsync(TimeSpan.FromSeconds(20));
    }

    [Fact]
    public async Task The_rig_says_its_token_was_refused_rather_than_that_it_is_offline()
    {
        // The whole point. Both situations stop laps and both used to produce the
        // one word "offline"; only one of them is fixed by waiting.
        var backend = new RefusingBackend();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.BackendRefusal is not null);

        Assert.Contains("does not accept this rig's token", status.BackendRefusal!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_dropped_network_is_still_only_offline()
    {
        // The other half of the same claim: if an ordinary outage also produced a
        // refusal, the new line would mean nothing. Twenty rigs behind one flaky
        // venue router must not all report a token problem.
        var backend = new RefusingBackend { NetworkDown = true };
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.Connection == ConnectionState.Offline);

        Assert.Null(status.BackendRefusal);
    }

    [Fact]
    public async Task A_forbidden_answer_reads_the_same_as_an_unauthorized_one()
    {
        // 401 and 403 differ in what the server meant and not at all in what the
        // person standing at the rig does about it.
        var backend = new RefusingBackend { Refusal = HttpStatusCode.Forbidden };
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.BackendRefusal is not null);

        Assert.Equal(BackendReach.Refused.Summary, status.BackendRefusal);
    }

    [Fact]
    public async Task Every_lap_stays_in_the_rigs_own_outbox()
    {
        // Nothing is settled and nothing is quarantined: these are customers' real
        // times and the refusal reverses itself the moment the token is right.
        var backend = new RefusingBackend();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-0002"));
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.BackendRefusal is not null);

        Assert.Equal(2, queue.PendingCount());
        Assert.Equal(0, queue.QuarantinedCount());
    }

    [Fact]
    public async Task A_refused_batch_is_never_split_looking_for_a_bad_lap()
    {
        // The 400 path halves a batch until one event is alone and quarantines it.
        // Run against a refusal that covers every call, that would set aside good
        // customer times to explain a mistyped token.
        var backend = new RefusingBackend();
        var batch = new[] { "evt-1", "evt-2", "evt-3", "evt-4" }.Select(Lap).ToList();
        using var queue = new EventQueue(_dbPath);
        foreach (var lap in batch) queue.Enqueue(lap);

        var client = new BackendClient(new HttpClient(backend), "https://x.test", "t");
        await Assert.ThrowsAsync<BackendRejectedException>(() =>
            client.SendLapsAsync(queue.PendingBatch(50), CancellationToken.None));

        Assert.Equal(1, backend.Calls);
    }

    [Fact]
    public async Task The_log_says_what_to_do_about_it()
    {
        // The rig's log is the only account of a night on an unattended machine,
        // and the fix is not something the reader can guess: the token is a secret
        // they cannot see, on a machine that looks like every other one.
        var backend = new RefusingBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue, log);

        await RunUntil(agent, s => s.BackendRefusal is not null);

        var lines = log.Snapshot();
        Assert.Contains(lines, l => l.Contains("refused this rig's identity", StringComparison.Ordinal));
        Assert.Contains(lines, l => l.Contains("agent.config.json", StringComparison.Ordinal));
        Assert.Contains(lines, l => l.Contains("Install-RigAgent.ps1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task It_says_it_once_rather_than_every_couple_of_seconds()
    {
        // Three loops call the backend between them, the fastest every five
        // seconds, all night. One line per call buries the reason it was written
        // for under thousands of copies of itself before anybody reads it.
        var backend = new RefusingBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        await using var agent = Agent(backend, queue, log);

        await RunUntil(agent, s => s.BackendRefusal is not null);
        await Task.Delay(TimeSpan.FromSeconds(11)); // two more flushes and a poll

        Assert.True(backend.Calls >= 3, $"expected the agent to keep trying, saw {backend.Calls} calls");
        Assert.Single(log.Snapshot(), l => l.Contains("refused this rig's identity", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_flaky_network_does_not_erase_the_reason()
    {
        // A venue rig that is refused AND on a network that comes and goes must
        // not lose the verdict every time a call fails at the transport, or the
        // machine spends the night flickering back to the word that reads as
        // "wait for the wifi".
        var backend = new RefusingBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue, log);

        // Every status the rig publishes from here on, because the claim is about
        // what it never says rather than about what it says next - a verdict the
        // outage erased would show up as one clear/re-set pair per failed call.
        var published = new List<AgentStatus>();
        agent.StatusChanged += s => { lock (published) published.Add(s); }; 

        await RunUntil(agent, s => s.BackendRefusal is not null);
        backend.NetworkDown = true;

        // Give every loop a chance to fail at the transport instead.
        await Task.Delay(TimeSpan.FromSeconds(11));

        var seen = backend.Calls;
        Assert.True(seen >= 3, $"expected the loops to keep calling, saw {seen}");
        lock (published)
        {
            var cleared = published.SkipWhile(s => s.BackendRefusal is null).Where(s => s.BackendRefusal is null);
            Assert.Empty(cleared);
        }
        Assert.DoesNotContain(log.Snapshot(), l => l.Contains("accepted this rig's token", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Re_enrolling_the_rig_clears_it_and_the_queued_laps_deliver()
    {
        // The reason for holding rather than refusing: the fix is a command at the
        // rig, and no customer's time should need recovering by hand afterwards.
        var backend = new RefusingBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-0002"));
        await using var agent = Agent(backend, queue, log);

        await RunUntil(agent, s => s.BackendRefusal is not null);
        backend.TokenWrong = false;

        var status = await WaitFor(agent, s => s.BackendRefusal is null && s.PendingLaps == 0);

        Assert.Equal(ConnectionState.Online, status.Connection);
        Assert.Equal(0, queue.PendingCount());
        Assert.Equal(0, queue.QuarantinedCount());
        Assert.Contains(log.Snapshot(), l => l.Contains("accepted this rig's token", StringComparison.Ordinal));
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* best effort */ }
    }
}
