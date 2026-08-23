using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The whole agent on a machine whose clock is wrong.
///
/// A lap carries one timestamp, and the backend decides two things with it: which
/// check-in owns the lap, and which venue night it belongs to. Both are judged
/// against the server's clock, so on a rig running behind, laps are refused as
/// belonging to nobody - a final refusal, so the customer's time is gone - and on
/// a rig running ahead they are stored and attributed and then filtered off
/// tonight's leaderboard. The rig looks healthy through all of it.
///
/// These drive the real <see cref="AgentService"/> and the real SQLite outbox,
/// because the thing being checked is what the rig actually puts in the queue
/// that gets posted - not what a clock class computes.
/// </summary>
public sealed class AgentClockTests : IDisposable
{
    private const string Assignment = "3f1c0a7e-2b44-4d19-9c8a-11d2f0a5b6c7";
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-clock-{Guid.NewGuid():N}.db");

    /// <summary>A backend whose responses carry its own clock, the way a real one
    /// does - the agent's whole reading comes from that header.</summary>
    private sealed class BackendStub : HttpMessageHandler
    {
        internal Func<DateTimeOffset> ServerNow = () => DateTimeOffset.UtcNow;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            var body = path.EndsWith("/assignment", StringComparison.Ordinal)
                ? new JsonObject
                {
                    ["assignment"] = new JsonObject
                    {
                        ["id"] = Assignment,
                        ["startedAt"] = ServerNow().ToString("o"),
                        ["driver"] = new JsonObject { ["id"] = "d1", ["displayName"] = "Alice" },
                    },
                }.ToJsonString()
                : "{}";

            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
            // Whole seconds, exactly as HTTP puts it on the wire.
            var now = ServerNow();
            response.Headers.Date = new DateTimeOffset(
                now.Ticks - (now.Ticks % TimeSpan.TicksPerSecond), now.Offset);
            return Task.FromResult(response);
        }
    }

    private sealed class FakeTelemetry : ITelemetrySource
    {
        internal Func<DateTimeOffset> MachineNow = () => DateTimeOffset.UtcNow;
        public bool SimRunning => true;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { }

        /// <summary>A lap stamped the way the live reader stamps one: with the
        /// clock of the computer it is running on.</summary>
        public void Emit(string eventId) => LapCompleted?.Invoke(new LapCompleted
        {
            EventId = eventId,
            TrackName = "Spa-Francorchamps",
            CarName = "Porsche 911 GT3 R",
            LapTimeMs = 138_103,
            IncidentDelta = 0,
            CompletedAt = MachineNow(),
        });
    }

    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "t",
        RigNumber = 1,
    };

    private static DateTimeOffset QueuedCompletion(EventQueue queue, string eventId) =>
        DateTimeOffset.Parse(queue.PendingBatch(50)
            .Single(e => e.EventId == eventId)
            .Payload["completedAt"]!.GetValue<string>());

    /// <summary>Runs the whole agent on a machine whose clock is <paramref name="skew"/>
    /// away from the backend's, and returns the completion time the rig put in its
    /// outbox for one lap - the value that is posted and that the backend judges.</summary>
    private async Task<(DateTimeOffset Queued, DateTimeOffset ServerNow, TimeSpan Reported)> QueueOneLap(
        TimeSpan skew)
    {
        var serverNow = () => DateTimeOffset.UtcNow;
        var machineNow = () => DateTimeOffset.UtcNow + skew;

        var clock = new ServerClock();
        var stub = new BackendStub { ServerNow = serverNow };
        var telemetry = new FakeTelemetry { MachineNow = machineNow };
        using var http = new HttpClient(new ServerClockHandler(clock, stub, machineNow));
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(http, "https://x.test", "t"), queue, telemetry, null, clock);

        // The reading arrives with the agent's first backend call. Waiting for it
        // is the honest ordering: the correction is only as good as the fact that
        // the rig has talked to the backend at least once.
        var settled = new TaskCompletionSource();
        agent.StatusChanged += status => { if (status.Assignment?.Id == Assignment) settled.TrySetResult(); };
        agent.Start();
        await settled.Task.WaitAsync(TimeSpan.FromSeconds(5));

        telemetry.Emit("evt-clock-0001");
        return (QueuedCompletion(queue, "evt-clock-0001"), serverNow(), clock.Offset);
    }

    /// <summary>Readings come from a whole-second header, and the test's own two
    /// clock calls are not simultaneous.</summary>
    private static void AssertWithinTwoSeconds(DateTimeOffset expected, DateTimeOffset actual) =>
        Assert.True((actual - expected).Duration() < TimeSpan.FromSeconds(2),
            $"expected about {expected:o}, queued {actual:o}");

    [Fact]
    public async Task A_rig_running_behind_still_queues_laps_at_the_backends_time()
    {
        // Three minutes slow. Uncorrected, every lap of the first three minutes of
        // each customer's session is stamped before they checked in and refused
        // with assignment_mismatch, which is final - the time is simply lost.
        var (queued, serverNow, reported) = await QueueOneLap(TimeSpan.FromMinutes(-3));

        AssertWithinTwoSeconds(serverNow, queued);
        Assert.True(reported > TimeSpan.FromMinutes(2), $"clock reported as {reported}");
    }

    [Fact]
    public async Task A_rig_running_ahead_still_queues_laps_at_the_backends_time()
    {
        // Six hours fast. Uncorrected, an evening lap is stamped after midnight,
        // stored and attributed correctly, and then filtered off tonight's
        // leaderboard and the TV board because it is on tomorrow's date.
        var (queued, serverNow, reported) = await QueueOneLap(TimeSpan.FromHours(6));

        AssertWithinTwoSeconds(serverNow, queued);
        Assert.True(reported < TimeSpan.FromHours(-5), $"clock reported as {reported}");
    }

    [Fact]
    public async Task A_rig_whose_clock_is_fine_queues_laps_with_its_own_clock()
    {
        // The other nineteen machines. Rolling this out has to be a no-op on them,
        // or a correction is being applied where there is nothing to correct.
        var (queued, serverNow, reported) = await QueueOneLap(TimeSpan.Zero);

        Assert.Equal(TimeSpan.Zero, reported);
        AssertWithinTwoSeconds(serverNow, queued);
    }

    [Fact]
    public async Task An_agent_with_no_clock_of_its_own_behaves_as_it_always_did()
    {
        // AgentService's clock is optional, so every existing caller and test
        // constructs one without it. That has to mean "correct nothing", not
        // "throw" and not "correct by something".
        var machineNow = () => DateTimeOffset.UtcNow + TimeSpan.FromHours(6);
        var stub = new BackendStub();
        var telemetry = new FakeTelemetry { MachineNow = machineNow };
        using var http = new HttpClient(stub);
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(http, "https://x.test", "t"), queue, telemetry);

        agent.Start();
        telemetry.Emit("evt-noclock-0001");

        AssertWithinTwoSeconds(machineNow(), QueuedCompletion(queue, "evt-noclock-0001"));
    }

    [Fact]
    public async Task The_rig_says_how_far_out_its_own_clock_is()
    {
        // Laps are corrected, so nothing is lost - but the machine's time is still
        // wrong, and this is the only place in the system that says so. Without it
        // a rig with a dead CMOS battery is fixed invisibly, forever.
        var clock = new ServerClock();
        var stub = new BackendStub();
        var telemetry = new FakeTelemetry();
        using var http = new HttpClient(new ServerClockHandler(clock, stub, () => DateTimeOffset.UtcNow.AddMinutes(-3)));
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            Config(), new BackendClient(http, "https://x.test", "t"), queue, telemetry, null, clock);

        AgentStatus? seen = null;
        agent.StatusChanged += s => seen = s;
        agent.Start();

        Assert.NotNull(seen);
        Assert.Equal(clock.Offset, seen!.ClockOffset);
    }

    public void Dispose()
    {
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            try { File.Delete(_dbPath + suffix); } catch { /* best effort */ }
        }
    }
}
