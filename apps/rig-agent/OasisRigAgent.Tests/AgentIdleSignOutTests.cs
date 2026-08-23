using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Whole-agent behaviour when a customer leaves without signing out.
///
/// Nobody at Oasis tells this system when a customer's time is up: staff sell it at
/// the desk, and a walk-in who is finished stands up and goes. Their check-in stays
/// open, their name stays on the rig, and the next person to sit down almost never
/// scans a machine that already has a session loaded - so every lap they drive is
/// credited to the customer before them, on the phone, the dashboard and the wall.
/// <see cref="IdleWatch"/> owns the rule; these cover the agent carrying it out
/// against a backend, including what it must refuse to do.
/// </summary>
public sealed class AgentIdleSignOutTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-idle-{Guid.NewGuid():N}.db");

    /// <summary>A backend with one rig, one check-in, and a record of every
    /// checkout request the agent made.</summary>
    private sealed class VenueBackend : HttpMessageHandler
    {
        public volatile string? OpenAssignmentId = "11111111-1111-4111-8111-111111111111";
        public readonly List<string> CheckoutBodies = new();

        public string[] Checkouts() { lock (CheckoutBodies) return CheckoutBodies.ToArray(); }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;

            if (path.EndsWith("/checkout", StringComparison.Ordinal))
            {
                var body = request.Content is null
                    ? ""
                    : await request.Content.ReadAsStringAsync(cancellationToken);
                lock (CheckoutBodies) CheckoutBodies.Add(body);

                var named = body.Length > 0 ? JsonNode.Parse(body)?["assignmentId"]?.GetValue<string>() : null;
                // The backend closes the named check-in or nothing - exactly what
                // apps/web/src/app/api/agent/checkout does.
                var ended = OpenAssignmentId is not null && (named is null || named == OpenAssignmentId);
                if (ended) OpenAssignmentId = null;
                return Respond($$"""{"ended":{{(ended ? "true" : "false")}}}""");
            }

            if (path.EndsWith("/assignment", StringComparison.Ordinal))
            {
                var open = OpenAssignmentId;
                return Respond(open is null
                    ? """{"assignment":null}"""
                    : """{"assignment":{"id":"@ID@","driver":{"id":"d1","displayName":"Walkaway Wendy"},"startedAt":"2026-08-19T19:00:00Z"}}"""
                        .Replace("@ID@", open, StringComparison.Ordinal));
            }

            return Respond("""{"results":[{"type":"RIG_HEARTBEAT","status":"ok"}]}""");
        }

        private static HttpResponseMessage Respond(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    /// <summary>A rig whose simulator state the test drives directly.</summary>
    private sealed class SwitchableTelemetry : ITelemetrySource
    {
        public volatile bool Running;
        public volatile string? Unusable;

        public bool SimRunning => Running;
        public string? SimUnusableReason => Unusable;
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

    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "t",
        RigNumber = 1,
        // Short enough for a test, long enough to see the warning first.
        IdleTimeoutSeconds = 6,
        IdleWarningSeconds = 5,
    };

    /// <summary>Polls until the agent has done the thing, or the test gives up. The
    /// status event cannot be used for the sign-out itself: "no driver" is also the
    /// state the agent starts in, before its first poll finds the check-in.</summary>
    private static async Task<T> Eventually<T>(Func<T> read, Func<T, bool> done)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(25);
        while (true)
        {
            var value = read();
            if (done(value)) return value;
            if (DateTime.UtcNow > deadline) throw new TimeoutException("The agent never got there.");
            await Task.Delay(100);
        }
    }

    private static async Task<AgentStatus> Until(AgentService agent, Func<AgentStatus, bool> reached)
    {
        var done = new TaskCompletionSource<AgentStatus>();
        agent.StatusChanged += status =>
        {
            if (reached(status)) done.TrySetResult(status);
        };
        return await done.Task.WaitAsync(TimeSpan.FromSeconds(25));
    }

    [Fact]
    public async Task A_rig_left_with_iRacing_closed_signs_the_customer_out_and_says_who()
    {
        var backend = new VenueBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new SwitchableTelemetry(),
            log);

        var warned = Until(agent, s => s.IdleSignOutIn is not null);
        agent.Start();

        // The rig says so on its own screen first, while a customer who is still
        // there can restart the sim and keep their session.
        Assert.Equal("Walkaway Wendy", (await warned).Assignment?.DriverDisplayName);

        var checkouts = await Eventually(() => backend.Checkouts(), c => c.Length > 0);
        Assert.NotEmpty(checkouts);
        var request = JsonNode.Parse(checkouts[0])!;
        Assert.Equal("idle_timeout", request["reason"]!.GetValue<string>());
        Assert.Equal("11111111-1111-4111-8111-111111111111", request["assignmentId"]!.GetValue<string>());
        Assert.Null(backend.OpenAssignmentId);

        // The log is the only account of an unattended machine's night, and "rig 7
        // cleared itself at 21:14" is what settles a customer asking why.
        Assert.Contains(log.Snapshot(), l =>
            l.Contains("signed Walkaway Wendy out", StringComparison.Ordinal)
            && l.Contains("6 second(s)", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_walk_in_who_checks_in_during_the_countdown_is_not_signed_out()
    {
        // The gap between deciding and asking is small, and the rig is in a room
        // with a queue: somebody scans the QR code, the rig is theirs, and a
        // checkout that meant "whoever is checked in" would end the session of the
        // customer who has just sat down. So the request names the check-in it
        // judged, and a stale name closes nothing.
        var backend = new VenueBackend();
        using var queue = new EventQueue(_dbPath);

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new SwitchableTelemetry());

        var warned = Until(agent, s => s.IdleSignOutIn is not null);
        agent.Start();
        await warned;

        const string walkIn = "22222222-2222-4222-8222-222222222222";
        backend.OpenAssignmentId = walkIn;

        var checkouts = await Eventually(() => backend.Checkouts(), c => c.Length > 0);
        Assert.Equal(
            "11111111-1111-4111-8111-111111111111",
            JsonNode.Parse(checkouts[0])!["assignmentId"]!.GetValue<string>());
        Assert.Equal(walkIn, backend.OpenAssignmentId);

        // And the rig goes back to showing them, rather than blanking the name of
        // somebody standing in front of it.
        var showsWalkIn = await Until(agent, s => s.Assignment?.Id == walkIn);
        Assert.Equal("Walkaway Wendy", showsWalkIn.Assignment?.DriverDisplayName);
    }

    [Fact]
    public async Task The_sign_out_button_still_ends_whoever_is_checked_in()
    {
        // The person pressing it is standing at the machine, so "whoever is checked
        // in here" is exactly what they mean - and an agent too old to send a body
        // at all must keep working against this backend.
        var backend = new VenueBackend();
        using var queue = new EventQueue(_dbPath);

        await using var agent = new AgentService(
            Config() with { IdleTimeoutSeconds = 0 },
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new SwitchableTelemetry { Running = true });

        var seen = Until(agent, s => s.Assignment is not null);
        agent.Start();
        await seen;

        Assert.True(await agent.SwitchDriverAsync());
        Assert.Equal(new[] { "" }, backend.Checkouts());
        Assert.Null(backend.OpenAssignmentId);
    }

    [Fact]
    public async Task A_customer_who_is_driving_is_never_signed_out()
    {
        var backend = new VenueBackend();
        using var queue = new EventQueue(_dbPath);
        var telemetry = new SwitchableTelemetry { Running = true };

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            telemetry);

        var seen = Until(agent, s => s.Assignment is not null);
        agent.Start();
        await seen;

        // Several idle periods with the simulator up.
        await Task.Delay(TimeSpan.FromSeconds(12));

        Assert.Empty(backend.Checkouts());
        Assert.NotNull(backend.OpenAssignmentId);
    }

    [Fact]
    public async Task A_rig_that_cannot_see_its_simulator_signs_nobody_out()
    {
        // This is the failure that arrives on every machine at once: an agent
        // started where iRacing's shared memory is invisible to it reads exactly
        // like a rig with the sim closed. Signing out on that reading would end
        // every check-in in the venue one idle period after the fleet went in -
        // while all of them were driving.
        var backend = new VenueBackend();
        using var queue = new EventQueue(_dbPath);
        var telemetry = new SwitchableTelemetry
        {
            Unusable = "iRacing is running but this agent cannot see it from here",
        };

        await using var agent = new AgentService(
            Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            telemetry);

        var seen = Until(agent, s => s.Assignment is not null);
        agent.Start();
        await seen;

        await Task.Delay(TimeSpan.FromSeconds(12));

        Assert.Empty(backend.Checkouts());
        Assert.NotNull(backend.OpenAssignmentId);
    }

    [Fact]
    public async Task A_venue_that_clears_its_own_rigs_can_turn_it_off()
    {
        var backend = new VenueBackend();
        using var queue = new EventQueue(_dbPath);

        await using var agent = new AgentService(
            Config() with { IdleTimeoutSeconds = 0 },
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            new SwitchableTelemetry());

        var seen = Until(agent, s => s.Assignment is not null);
        agent.Start();
        await seen;

        await Task.Delay(TimeSpan.FromSeconds(12));

        Assert.Empty(backend.Checkouts());
        Assert.NotNull(backend.OpenAssignmentId);
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* best effort */ }
    }
}
