using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Whole-agent behaviour on a computer holding another rig's token.
///
/// This is the enrolment mistake that does not announce itself. A refused token
/// at least stops everything; here the machine works perfectly - it authenticates,
/// it heartbeats, it polls, it delivers laps - and every one of those laps is
/// credited to a rig somewhere else in the room, to a customer who is not the one
/// sitting here. The customer at this station scanned this station's QR code and
/// watches a board their times never reach. Nothing in the database looks unusual
/// and neither machine's screen says anything is wrong.
///
/// Three behaviours are the fix, and each is here because leaving it out puts the
/// cost on somebody: hold the laps rather than score them onto the wrong rig, stop
/// claiming a rig this computer is not (a heartbeat is a claim, and a contested rig
/// stops scoring - one wrong paste must not take a working machine off the air),
/// and never show the other rig's customer on this screen.
/// </summary>
public sealed class AgentWrongRigTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-wrongrig-{Guid.NewGuid():N}.db");

    /// <summary>AgentService's own heartbeat period. Any claim about a rig having
    /// stopped heartbeating has to be measured across one of these, or it is green
    /// against an agent that never stopped.</summary>
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);

    /// <summary>A backend that authenticates this token happily and answers with
    /// the rig it belongs to - which is the situation, not a failure of it.</summary>
    private sealed class MixedUpBackend : HttpMessageHandler
    {
        /// <summary>The rig the backend says this token is. Set to the configured
        /// number to be the same machine re-enrolled correctly, or to null to be a
        /// backend older than this agent, which does not report it at all.</summary>
        public volatile int TokenBelongsToRig = 7;
        public volatile bool ReportsRig = true;

        /// <summary>Fails at the transport instead of answering, which is what an
        /// ordinary outage looks like: no status at all, because nothing replied.</summary>
        public volatile bool NetworkDown;

        /// <summary>How long the assignment poll takes to answer.
        ///
        /// Not decoration. In-process this handler completes without ever yielding,
        /// so the poll finishes before the flush loop has even been created and no
        /// startup race is reachable - a test written without it is green against an
        /// agent with the guard deleted. A real backend across a real network is the
        /// slow case, and it is the one the venue runs.</summary>
        public TimeSpan PollDelay = TimeSpan.Zero;

        private int _heartbeats;
        private int _lapPosts;
        private int _polls;

        public int Heartbeats => Volatile.Read(ref _heartbeats);
        public int LapPosts => Volatile.Read(ref _lapPosts);
        public int Polls => Volatile.Read(ref _polls);

        /// <summary>Whoever is checked in on the rig the token names. Not the person
        /// at this computer.</summary>
        public volatile string? OtherRigsDriver = "Someone Else";

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (NetworkDown) throw new HttpRequestException("No such host is known.");

            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/assignment", StringComparison.Ordinal))
            {
                if (PollDelay > TimeSpan.Zero) await Task.Delay(PollDelay, cancellationToken);
                Interlocked.Increment(ref _polls);
                var body = new JsonObject();
                if (ReportsRig)
                    body["rig"] = new JsonObject
                    {
                        ["number"] = TokenBelongsToRig,
                        ["displayName"] = $"Rig {TokenBelongsToRig:D2}",
                    };
                body["assignment"] = OtherRigsDriver is null
                    ? null
                    : new JsonObject
                    {
                        ["id"] = "assignment-on-the-other-rig",
                        ["startedAt"] = DateTimeOffset.UtcNow.AddMinutes(-5).ToString("O"),
                        ["driver"] = new JsonObject { ["id"] = "d9", ["displayName"] = OtherRigsDriver },
                    };
                return Respond(body.ToJsonString());
            }

            var posted = await request.Content!.ReadAsStringAsync(cancellationToken);
            var events = JsonNode.Parse(posted)!["events"]!.AsArray();
            var results = new JsonArray();
            foreach (var e in events)
            {
                var type = e!["type"]!.GetValue<string>();
                if (type == "RIG_HEARTBEAT") Interlocked.Increment(ref _heartbeats);
                else Interlocked.Increment(ref _lapPosts);
                var result = new JsonObject { ["type"] = type, ["status"] = type == "RIG_HEARTBEAT" ? "ok" : "accepted" };
                if (type != "RIG_HEARTBEAT") result["eventId"] = e["eventId"]!.GetValue<string>();
                results.Add(result);
            }
            return Respond(new JsonObject { ["results"] = results }.ToJsonString());
        }

        private static HttpResponseMessage Respond(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    /// <summary>A simulator that produces a lap exactly when the test says so, so
    /// the lap goes through the agent's own detected-lap path rather than being
    /// placed in the queue by hand.</summary>
    private sealed class DrivableTelemetry : ITelemetrySource
    {
        public bool SimRunning => true;
        public string? SimUnusableReason => null;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { }
        public void Drive(LapCompleted lap) => LapCompleted?.Invoke(lap);
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

    /// <summary>This computer was enrolled as rig 4. What its token is depends on
    /// the backend.</summary>
    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "the-token-meant-for-the-machine-next-door",
        RigNumber = 4,
        IdleTimeoutSeconds = 0,
    };

    private static AgentService Agent(
        MixedUpBackend backend, EventQueue queue, IAgentLog? log = null, ITelemetrySource? telemetry = null) =>
        new(Config(),
            new BackendClient(new HttpClient(backend), "https://x.test", "t"),
            queue,
            telemetry ?? new DrivableTelemetry(),
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
    public async Task The_rig_says_its_token_belongs_to_another_rig()
    {
        // Nothing else in the system can say this. The backend sees a valid token
        // making valid requests; only this computer knows which station it is.
        var backend = new MixedUpBackend();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.WrongRig is not null);

        Assert.Contains("WRONG RIG", status.WrongRig!, StringComparison.Ordinal);
        Assert.Contains("04", status.WrongRig!, StringComparison.Ordinal);
        Assert.Contains("07", status.WrongRig!, StringComparison.Ordinal);
        // Not the word for a token the backend would not accept: that one is fixed
        // by retyping a secret, and this one by re-running the right command here.
        Assert.Null(status.BackendRefusal);
    }

    [Fact]
    public async Task The_matching_rig_is_left_completely_alone()
    {
        // The other half of the claim. Every rig in the venue runs this code, so a
        // check that fired on a correctly enrolled machine would stop the room.
        var backend = new MixedUpBackend { TokenBelongsToRig = 4 };
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.PendingLaps == 0 && s.Assignment is not null);

        Assert.Null(status.WrongRig);
        Assert.True(backend.Heartbeats >= 1, "a correctly enrolled rig still heartbeats");
        Assert.Equal("Someone Else", status.Assignment!.DriverDisplayName);
    }

    [Fact]
    public async Task A_backend_that_does_not_report_the_rig_changes_nothing()
    {
        // Rigs are updated one at a time and the backend is deployed once. An agent
        // ahead of its backend must behave exactly as it did before this existed.
        var backend = new MixedUpBackend { ReportsRig = false };
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.PendingLaps == 0);

        Assert.Null(status.WrongRig);
        Assert.True(backend.Heartbeats >= 1, "an agent ahead of its backend still heartbeats");
    }

    [Fact]
    public async Task Every_lap_stays_in_this_machines_own_outbox()
    {
        // Delivering them is the damage, not the fix: they would be scored onto the
        // other rig's customer, and nothing afterwards could tell them apart from
        // that customer's own laps.
        var backend = new MixedUpBackend();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-0002"));
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.WrongRig is not null);
        await Task.Delay(TimeSpan.FromSeconds(11)); // two more flush ticks

        Assert.Equal(0, backend.LapPosts);
        Assert.Equal(2, queue.PendingCount());
        Assert.Equal(0, queue.QuarantinedCount());
    }

    [Fact]
    public async Task It_stops_claiming_the_rig_it_is_not()
    {
        // A heartbeat is a claim on a rig: a second live installation puts that rig
        // into conflict and holds ITS laps too. So the machine that knows it is in
        // the wrong place is the one that has to stand down - otherwise one wrong
        // paste at enrolment takes a working rig, with a customer on it, off the air.
        var backend = new MixedUpBackend();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.WrongRig is not null);
        var claimed = backend.Heartbeats;
        // Past a whole heartbeat interval, not just past a poll: a shorter wait is
        // green against an agent that never stopped, because the next beat was not
        // due yet either way.
        await Task.Delay(HeartbeatInterval + TimeSpan.FromSeconds(5));

        // It keeps polling, which is the only way it can learn the token was fixed.
        Assert.True(backend.Polls > 1, $"expected the poll to keep running, saw {backend.Polls}");
        Assert.Equal(claimed, backend.Heartbeats);
    }

    [Fact]
    public async Task A_full_outbox_is_not_emptied_onto_the_other_rig_when_the_machine_restarts()
    {
        // The realistic sequence, and the one that costs a customer their night:
        // the machine is enrolled wrongly, laps pile up in its outbox, and somebody
        // reboots it - or it simply restarts at logon the next morning. Every loop
        // runs immediately at startup, so the first flush raced the one call that
        // learns which rig this is, and won: four of this customer's laps were
        // posted to the other rig before anything had asked.
        var backend = new MixedUpBackend { PollDelay = TimeSpan.FromMilliseconds(500) };
        using var queue = new EventQueue(_dbPath);
        foreach (var id in new[] { "evt-1", "evt-2", "evt-3", "evt-4" }) queue.Enqueue(Lap(id));
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.WrongRig is not null);
        await Task.Delay(TimeSpan.FromSeconds(2)); // let a racing first flush land

        Assert.Equal(0, backend.LapPosts);
        Assert.Equal(4, queue.PendingCount());
    }

    [Fact]
    public async Task It_never_claims_the_other_rig_even_once_at_startup()
    {
        // Found by running this for real rather than by a unit test. Both loops run
        // immediately at startup, and the heartbeat won: one beat went out before
        // the first poll answered, which stamped a conflict onto the rig being
        // impersonated and held THAT rig's laps until the claim aged out - three
        // minutes of a working machine, with a customer on it, not scoring, every
        // time somebody reboots the mis-enrolled one.
        var backend = new MixedUpBackend { PollDelay = TimeSpan.FromMilliseconds(500) };
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.WrongRig is not null);
        await Task.Delay(TimeSpan.FromSeconds(2)); // let a racing first beat land

        Assert.Equal(0, backend.Heartbeats);
    }

    [Fact]
    public async Task A_rig_that_cannot_reach_the_backend_still_heartbeats_when_it_comes_back()
    {
        // The other side of waiting for that answer: an unanswerable question is not
        // evidence about which rig this is, so a machine that could not poll must
        // not be left silently never claiming itself.
        var backend = new MixedUpBackend { TokenBelongsToRig = 4, NetworkDown = true };
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.Connection == ConnectionState.Offline);
        backend.NetworkDown = false;
        await Task.Delay(HeartbeatInterval + TimeSpan.FromSeconds(5));

        Assert.True(backend.Heartbeats >= 1, "a rig that lost the network must claim itself once it is back");
    }

    [Fact]
    public async Task The_other_rigs_customer_never_appears_on_this_screen()
    {
        // The person at this machine did not check in here, and showing them a name
        // is worse than showing them nothing: it reads as a working rig.
        var backend = new MixedUpBackend();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        var status = await RunUntil(agent, s => s.WrongRig is not null);

        Assert.Null(status.Assignment);
    }

    [Fact]
    public async Task A_lap_driven_here_is_never_stamped_with_the_other_rigs_check_in()
    {
        // The lasting damage if it were, and it lands at the moment of the fix. A
        // queued lap carrying an assignment that belongs to another rig is answered
        // assignment_mismatch once this machine is re-enrolled - which the agent
        // treats as settled and drops. The customer's time would be lost by the
        // repair rather than by the fault, which is the worst possible place to
        // lose it.
        var backend = new MixedUpBackend();
        var telemetry = new DrivableTelemetry();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue, telemetry: telemetry);

        await RunUntil(agent, s => s.WrongRig is not null);
        telemetry.Drive(Lap("evt-0001"));

        var queued = Assert.Single(queue.PendingBatch(10));
        Assert.Null(queued.Payload["rigAssignmentId"]);
    }

    [Fact]
    public async Task It_says_it_once_rather_than_every_ten_seconds()
    {
        // The poll runs all night. One line per poll buries the only explanation of
        // why this machine stopped under thousands of copies of itself.
        var backend = new MixedUpBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue, log);

        await RunUntil(agent, s => s.WrongRig is not null);
        await Task.Delay(TimeSpan.FromSeconds(11));

        Assert.True(backend.Polls > 1, $"expected the poll to keep running, saw {backend.Polls}");
        Assert.Single(log.Snapshot(), l => l.Contains("token in its", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Re_enrolling_this_computer_clears_it_and_the_queued_laps_deliver()
    {
        // The reason for holding rather than refusing: the fix is one command at
        // this machine, and no customer's time should need recovering by hand.
        var backend = new MixedUpBackend();
        var log = new RecordingLog();
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-0001"));
        queue.Enqueue(Lap("evt-0002"));
        await using var agent = Agent(backend, queue, log);

        await RunUntil(agent, s => s.WrongRig is not null);
        backend.TokenBelongsToRig = 4;

        var status = await WaitFor(agent, s => s.WrongRig is null && s.PendingLaps == 0);

        Assert.Equal(ConnectionState.Online, status.Connection);
        Assert.Equal(2, backend.LapPosts);
        Assert.Equal(0, queue.QuarantinedCount());
        Assert.Contains(log.Snapshot(), l => l.Contains("the rig it is installed as again", StringComparison.Ordinal));
    }

    [Fact]
    public async Task It_starts_heartbeating_again_once_it_is_the_right_rig()
    {
        // Otherwise the fix leaves a machine that scores laps and is still absent
        // from the staff dashboard, which is its own night of confusion.
        var backend = new MixedUpBackend();
        using var queue = new EventQueue(_dbPath);
        await using var agent = Agent(backend, queue);

        await RunUntil(agent, s => s.WrongRig is not null);
        var whileWrong = backend.Heartbeats;
        backend.TokenBelongsToRig = 4;
        await WaitFor(agent, s => s.WrongRig is null);
        await Task.Delay(HeartbeatInterval + TimeSpan.FromSeconds(5));

        Assert.True(backend.Heartbeats > whileWrong,
            $"expected the rig to claim itself again, saw {backend.Heartbeats} heartbeats");
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* best effort */ }
    }
}
