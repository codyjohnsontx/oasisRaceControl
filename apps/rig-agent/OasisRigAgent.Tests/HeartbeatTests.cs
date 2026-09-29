using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using OasisRigAgent.Core;
using OasisRigAgent.Core.Iracing;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The heartbeat v2 report: what the rig tells the server-side monitor once a
/// minute, how it backs off while the backend is away, and what it keeps until
/// a heartbeat actually gets through. The shape is pinned against
/// <c>heartbeatEvent</c> in apps/web/src/lib/events.ts.
/// </summary>
public sealed class HeartbeatTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-heartbeat-{Guid.NewGuid():N}.db");
    private const string AssignmentId = "3f1b0c8e-3a1c-4f6d-9c2f-1a2b3c4d5e6f";

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        foreach (var file in new[] { _dbPath, _dbPath + "-wal", _dbPath + "-shm" })
            if (File.Exists(file)) File.Delete(file);
    }

    [Fact]
    public void TheHeartbeatIsEveryMinuteAndDoublesToFiveMinutesWhileTheBackendIsAway()
    {
        Assert.Equal(TimeSpan.FromSeconds(60), HeartbeatSchedule.Delay(0, 0.5));
        Assert.Equal(TimeSpan.FromSeconds(120), HeartbeatSchedule.Delay(1, 0.5));
        Assert.Equal(TimeSpan.FromSeconds(240), HeartbeatSchedule.Delay(2, 0.5));
        Assert.Equal(TimeSpan.FromSeconds(300), HeartbeatSchedule.Delay(3, 0.5));
        Assert.Equal(TimeSpan.FromSeconds(300), HeartbeatSchedule.Delay(10_000, 0.5));
    }

    [Fact]
    public void BackoffIsJitteredByTenPercentButTheHealthyMinuteIsNot()
    {
        Assert.Equal(TimeSpan.FromSeconds(108), HeartbeatSchedule.Delay(1, 0));
        Assert.Equal(132, HeartbeatSchedule.Delay(1, 0.999999).TotalSeconds, precision: 3);
        Assert.Equal(TimeSpan.FromSeconds(60), HeartbeatSchedule.Delay(0, 0));
        Assert.Equal(TimeSpan.FromSeconds(60), HeartbeatSchedule.Delay(0, 0.999999));
    }

    [Fact]
    public void TheStartLogCountsTheLastDaysStartsAndForgetsOlderOnes()
    {
        var now = DateTimeOffset.Parse("2026-10-04T21:00:00Z");
        using (var queue = new EventQueue(_dbPath))
        {
            Assert.Equal(1, queue.RecordStart(now - TimeSpan.FromHours(30)));
            Assert.Equal(2, queue.RecordStart(now - TimeSpan.FromHours(23)));
        }
        // A new process on the same outbox, as after a crash.
        using (var queue = new EventQueue(_dbPath))
        {
            Assert.Equal(2, queue.RecordStart(now));
            Assert.Equal(3, queue.RecordStart(now + TimeSpan.FromMinutes(1)));
        }

        using var db = new SqliteConnection($"Data Source={_dbPath}");
        db.Open();
        using var count = db.CreateCommand();
        count.CommandText = "select count(*) from start_log";
        Assert.Equal(3L, count.ExecuteScalar());
    }

    [Fact]
    public void TheOldestPendingAgeIgnoresParkedLaps()
    {
        using var queue = new EventQueue(_dbPath);
        Assert.Null(queue.OldestPendingAge(DateTimeOffset.UtcNow));

        queue.Enqueue(Lap("evt-parked-000"), null);
        queue.Reject([new RejectedEvent("evt-parked-000", "lapTimeMs: Too big")]);
        Assert.Null(queue.OldestPendingAge(DateTimeOffset.UtcNow));

        queue.Enqueue(Lap("evt-waiting-01"), null);
        var age = queue.OldestPendingAge(DateTimeOffset.UtcNow + TimeSpan.FromMinutes(5));
        Assert.NotNull(age);
        Assert.InRange(age.Value.TotalSeconds, 299, 310);
    }

    [Fact]
    public void CpuIsTheShareOfOneCoreSinceThePreviousSample()
    {
        var cpu = TimeSpan.Zero;
        long ticks = 0;
        var footprint = new ProcessFootprint(() => (cpu, 40L * 1024 * 1024), () => ticks);

        var first = footprint.Sample();
        Assert.Null(first.CpuPercent);
        Assert.Equal(40, first.MemoryMb);

        cpu += TimeSpan.FromMilliseconds(120);
        ticks += Stopwatch.Frequency * 60;
        Assert.Equal(0.2, footprint.Sample().CpuPercent);
    }

    [Theory]
    [InlineData("/api/auth/login", 401, null)]
    [InlineData("/api/auth/login", 200, null)]
    [InlineData("/api/auth/login", 429, SignInFailureKind.Locked)]
    [InlineData("/api/auth/login", 400, SignInFailureKind.WrongPinOrName)]
    [InlineData("/api/auth/login", 500, SignInFailureKind.Other)]
    [InlineData("/api/auth/register", 409, SignInFailureKind.WrongPinOrName)]
    [InlineData("/api/auth/register", 429, SignInFailureKind.RateLimited)]
    [InlineData("/api/auth/register", 503, SignInFailureKind.Other)]
    [InlineData("/api/checkin", 429, SignInFailureKind.RateLimited)]
    [InlineData("/api/checkin", 404, SignInFailureKind.Other)]
    [InlineData("/api/checkin", 200, null)]
    [InlineData("/api/agent/events", 500, null)]
    public void SignInAnswersAreClassifiedByRouteAndStatus(string path, int status, SignInFailureKind? expected)
        => Assert.Equal(expected, SignInFailureWatch.Classify(path, (HttpStatusCode)status));

    /// <summary>The walk-up client's own sequence for a name registered to a
    /// different PIN: a 401 login, then a 409 register. One failed sign-in is
    /// one count, and a network that is not there is another kind - with the
    /// failure still reaching the caller exactly as it would without the
    /// watch.</summary>
    [Fact]
    public async Task TheWatchCountsOneFailurePerRefusedSignInAndPassesTransportErrorsOn()
    {
        var recorded = new List<SignInFailureKind>();
        var offline = false;
        var backend = new Answering(request =>
        {
            if (offline) throw new HttpRequestException("venue network is down");
            return request.RequestUri!.AbsolutePath.EndsWith("/login")
                ? HttpStatusCode.Unauthorized
                : HttpStatusCode.Conflict;
        });
        using var http = new HttpClient(new SignInFailureWatch(recorded.Add, backend)) { BaseAddress = new Uri("https://x.test/") };

        (await http.PostAsync("api/auth/login", null)).Dispose();
        (await http.PostAsync("api/auth/register", null)).Dispose();
        offline = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => http.PostAsync("api/auth/login", null));

        Assert.Equal([SignInFailureKind.WrongPinOrName, SignInFailureKind.Unreachable], recorded);
    }

    /// <summary>Everything the monitor needs, from state the agent already
    /// holds: the sim's session and health from the telemetry source's own
    /// events, the stamp laps are getting, the outbox counts, the last lap,
    /// sign-in failures and notices since the previous heartbeat, and the
    /// agent's own footprint. No driver name.</summary>
    [Fact]
    public async Task TheReportCarriesTheRigsStateAndNoDriverName()
    {
        var backend = new RecordingBackend { Assignment = AssignmentId };
        using var queue = new EventQueue(_dbPath);
        var telemetry = new FakeSim();
        var client = new BackendClient(new HttpClient(backend), "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, telemetry);

        agent.Start();
        await Eventually(() => agent.CurrentStatus().Assignment is not null && backend.Heartbeats.Count >= 1);
        telemetry.RaiseCombo(new SessionCombo("Circuit of the Americas", "Grand Prix", "FIA F4", 0, "cota gp", 1, 2));
        telemetry.RaiseMissing(["LapLastLapTime"]);
        telemetry.Emit("evt-heartbeat-01");
        agent.RecordSignInFailure(SignInFailureKind.WrongPinOrName);
        agent.RecordSignInFailure(SignInFailureKind.WrongPinOrName);
        agent.RecordSignInFailure(SignInFailureKind.Locked);
        telemetry.RaiseFault(new IOException("the map could not be read"));

        var json = agent.BuildHeartbeat(shuttingDown: false).Report.ToEvent();

        Assert.Equal("RIG_HEARTBEAT", Text(json, "type"));
        Assert.Equal("rig-agent/0.4-monitor", Text(json, "agentVersion"));
        Assert.True(DateTimeOffset.TryParse(Text(json, "sentAt"), out _));
        Assert.True(DateTimeOffset.TryParse(Text(json, "processStartedAt"), out _));
        Assert.Equal(1, json["startCount"]!.GetValue<int>());
        Assert.True(json["osUptimeS"]!.GetValue<long>() > 0);
        Assert.Equal("iracing", Text(json, "telemetryMode"));
        Assert.True(json["simConnected"]!.GetValue<bool>());
        Assert.True(json["telemetryFaulted"]!.GetValue<bool>());
        Assert.Equal(["LapLastLapTime"], Strings(json, "missingVariables"));
        Assert.Equal("Circuit of the Americas", Text(json["session"]!, "trackName"));
        Assert.Equal("Grand Prix", Text(json["session"]!, "trackConfig"));
        Assert.Equal("FIA F4", Text(json["session"]!, "carName"));
        Assert.Equal(AssignmentId, Text(json, "assignmentId"));
        Assert.True(json["assignmentKnown"]!.GetValue<bool>());
        Assert.Equal(1, json["pendingLaps"]!.GetValue<int>());
        Assert.True(json["oldestPendingAgeS"]!.GetValue<double>() >= 0);
        Assert.Equal(0, json["rejectedLaps"]!.GetValue<int>());
        Assert.Equal("none", Text(json, "checkout"));
        Assert.True(DateTimeOffset.TryParse(Text(json, "lastLapCapturedAt"), out _));
        Assert.Null(json["lastLapPostedAt"]);
        Assert.Equal(3, json["signInFailures"]!.GetValue<int>());
        Assert.Equal(["wrong_pin_or_name", "locked"], Strings(json, "signInFailureKinds"));
        Assert.Contains(Strings(json, "notices"), n => n.Contains("lap reading stopped"));
        Assert.True(json["agentCpuPercent"]!.GetValue<double>() >= 0);
        Assert.True(json["agentMemoryMb"]!.GetValue<double>() > 0);
        Assert.False(json["shuttingDown"]!.GetValue<bool>());
        Assert.DoesNotContain("Mike", json.ToJsonString());

        // The session is what iRacing is in right now: gone with the sim.
        telemetry.Disconnect();
        var idle = agent.BuildHeartbeat(shuttingDown: false).Report.ToEvent();
        Assert.Null(idle["session"]);
        Assert.False(idle["simConnected"]!.GetValue<bool>());
        Assert.Empty(Strings(idle, "missingVariables"));
    }

    /// <summary>A notice or a sign-in failure during an outage arrives with the
    /// first heartbeat that gets through, and only once.</summary>
    [Fact]
    public async Task WhatAHeartbeatReportsIsKeptUntilOneIsDelivered()
    {
        var backend = new RecordingBackend();
        using var queue = new EventQueue(_dbPath);
        var client = new BackendClient(new HttpClient(backend), "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, new FakeSim());
        agent.Start();
        await Eventually(() => backend.Heartbeats.Count >= 1);

        backend.Offline = true;
        agent.RecordSignInFailure(SignInFailureKind.Unreachable);
        Assert.False(await agent.SendHeartbeatAsync(shuttingDown: false));

        backend.Offline = false;
        Assert.True(await agent.SendHeartbeatAsync(shuttingDown: false));
        Assert.Equal(1, backend.Heartbeats[^1]["signInFailures"]!.GetValue<int>());

        Assert.True(await agent.SendHeartbeatAsync(shuttingDown: false));
        Assert.Equal(0, backend.Heartbeats[^1]["signInFailures"]!.GetValue<int>());
    }

    /// <summary>A backend whose schema disagrees with this report must still
    /// hear that the rig is alive, and the item it could not take must not
    /// be offered forever.</summary>
    [Fact]
    public async Task AReportTheBackendRefusesFallsBackToTheBareHeartbeatOnce()
    {
        var backend = new RecordingBackend();
        using var queue = new EventQueue(_dbPath);
        var client = new BackendClient(new HttpClient(backend), "https://x.test", "t");
        var notices = new List<string>();
        await using var agent = new AgentService(Config(), client, queue, new FakeSim());
        agent.Notice += notices.Add;
        agent.Start();
        await Eventually(() => backend.Heartbeats.Count >= 1);

        backend.RefuseReports = true;
        agent.RecordSignInFailure(SignInFailureKind.Other);
        Assert.True(await agent.SendHeartbeatAsync(shuttingDown: false));
        var bare = backend.Heartbeats[^1];
        Assert.Equal(["type", "agentVersion"], bare.Select(p => p.Key));
        Assert.Single(notices, n => n.Contains("bare heartbeat"));

        Assert.True(await agent.SendHeartbeatAsync(shuttingDown: false));
        Assert.Single(notices, n => n.Contains("bare heartbeat"));

        backend.RefuseReports = false;
        Assert.True(await agent.SendHeartbeatAsync(shuttingDown: false));
        Assert.Equal(0, backend.Heartbeats[^1]["signInFailures"]!.GetValue<int>());
    }

    [Fact]
    public async Task TheGoodbyeSaysTheAgentIsShuttingDownAndSoDoesAnythingAfterIt()
    {
        var backend = new RecordingBackend();
        using var queue = new EventQueue(_dbPath);
        var client = new BackendClient(new HttpClient(backend), "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, new FakeSim());
        agent.Start();
        await Eventually(() => backend.Heartbeats.Count >= 1);
        Assert.False(backend.Heartbeats[0]["shuttingDown"]!.GetValue<bool>());

        await agent.SendGoodbyeAsync(TimeSpan.FromSeconds(3));

        Assert.True(backend.Heartbeats[^1]["shuttingDown"]!.GetValue<bool>());
        Assert.True(agent.BuildHeartbeat(shuttingDown: false).Report.ShuttingDown);
    }

    [Fact]
    public async Task TheGoodbyeGivesUpWithinItsLimitWhenTheBackendDoesNotAnswer()
    {
        var backend = new RecordingBackend { Hang = true };
        using var queue = new EventQueue(_dbPath);
        var client = new BackendClient(new HttpClient(backend), "https://x.test", "t");
        await using var agent = new AgentService(Config(), client, queue, new FakeSim());

        var clock = Stopwatch.StartNew();
        await agent.SendGoodbyeAsync(TimeSpan.FromMilliseconds(300));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), clock.Elapsed.ToString());
    }

    /// <summary>The wire takes ten notices of two hundred characters; the
    /// newest are the ones kept, and a long one is clipped rather than
    /// costing the rig its heartbeat.</summary>
    [Fact]
    public void ListsAndStringsStayInsideTheBackendsBounds()
    {
        var report = new HeartbeatReport
        {
            AgentVersion = "rig-agent/0.4-monitor",
            SentAt = DateTimeOffset.UtcNow,
            OsUptimeS = 1,
            TelemetryMode = TelemetryMode.Iracing,
            SimConnected = true,
            TelemetryFaulted = false,
            MissingVariables = Enumerable.Range(0, 12).Select(i => $"Var{i}" + new string('x', 80)).ToArray(),
            Session = new SessionCombo(new string('t', 130), null, "car", 0, null, null, null),
            AssignmentKnown = true,
            Checkout = CheckoutDelivery.None,
            SignInFailures = 12,
            SignInFailureKinds = Enumerable.Repeat(SignInFailureKind.Locked, 12).ToArray(),
            Notices = Enumerable.Range(0, 15).Select(i => $"notice {i} " + new string('n', 300)).ToArray(),
            ShuttingDown = false,
        };

        var json = report.ToEvent();

        var notices = Strings(json, "notices");
        Assert.Equal(10, notices.Count);
        Assert.StartsWith("notice 5 ", notices[0]);
        Assert.All(notices, n => Assert.True(n.Length <= 200));
        Assert.All(Strings(json, "missingVariables"), v => Assert.True(v.Length <= 64));
        Assert.Equal(10, Strings(json, "missingVariables").Count);
        Assert.Equal(120, Text(json["session"]!, "trackName").Length);
        Assert.Null(json["session"]!["trackConfig"]);
        Assert.Equal(["locked"], Strings(json, "signInFailureKinds"));
        Assert.False(json.ContainsKey("pendingLaps"));
        Assert.False(json.ContainsKey("oldestPendingAgeS"));
    }

    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://x.test",
        RigToken = "t",
        RigNumber = 1,
        Telemetry = "iracing",
    };

    private static LapCompleted Lap(string eventId) => new()
    {
        EventId = eventId,
        TrackName = "Circuit of the Americas",
        TrackConfig = "Grand Prix",
        CarName = "FIA F4",
        LapNumber = 1,
        LapTimeMs = 137_217,
        CompletedAt = DateTimeOffset.UtcNow,
    };

    private static string Text(JsonNode node, string key) => node[key]!.GetValue<string>();

    private static List<string> Strings(JsonNode node, string key)
        => node[key]!.AsArray().Select(n => n!.GetValue<string>()).ToList();

    private static async Task Eventually(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("never happened");
            await Task.Delay(20);
        }
    }

    /// <summary>Telemetry the test drives by hand, with the sim-health events
    /// the iRacing source raises.</summary>
    private sealed class FakeSim : ITelemetrySource, ISimHealthSource
    {
        private volatile bool _running = true;
        public bool SimRunning => _running;
        public event Action<LapCompleted>? LapCompleted;
        public event Action<bool>? ConnectionChanged;
        public event Action<SessionCombo>? ComboChanged;
        public event Action<IReadOnlyList<string>>? MissingVariables;
        public event Action<Exception>? Faulted;
        public void Start() { }
        public void Stop() { }

        public void Emit(string eventId) => LapCompleted?.Invoke(Lap(eventId));
        public void RaiseCombo(SessionCombo combo) => ComboChanged?.Invoke(combo);
        public void RaiseMissing(IReadOnlyList<string> names) => MissingVariables?.Invoke(names);
        public void RaiseFault(Exception ex) => Faulted?.Invoke(ex);

        public void Disconnect()
        {
            _running = false;
            ConnectionChanged?.Invoke(false);
        }
    }

    /// <summary>The agent routes, recording every heartbeat it receives. Laps
    /// are answered with no results, so the outbox keeps what the test
    /// inspects.</summary>
    private sealed class RecordingBackend : HttpMessageHandler
    {
        private readonly List<JsonObject> _heartbeats = new();
        public volatile string? Assignment;
        public volatile bool Offline;
        public volatile bool RefuseReports;
        public volatile bool Hang;

        public IReadOnlyList<JsonObject> Heartbeats { get { lock (_heartbeats) return _heartbeats.ToList(); } }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (Hang) await Task.Delay(Timeout.Infinite, ct);
            if (Offline) throw new HttpRequestException("venue network is down");
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/assignment"))
                return Json(Assignment is null
                    ? """{"assignment":null}"""
                    : "{\"assignment\":{\"id\":\"" + Assignment + "\",\"startedAt\":\"2026-07-12T00:00:00Z\",\"driver\":{\"id\":\"d-mike\",\"displayName\":\"Mike\"}}}");
            if (path.EndsWith("/checkout")) return Json("""{"ended":false}""");

            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!;
            var events = body["events"]!.AsArray();
            if (events[0]!["type"]!.GetValue<string>() != "RIG_HEARTBEAT") return Json("""{"results":[]}""");
            var heartbeat = events[0]!.AsObject();
            if (RefuseReports && heartbeat.ContainsKey("sentAt"))
                return new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    Content = new StringContent("""{"error":"invalid_body"}""", Encoding.UTF8, "application/json"),
                };
            lock (_heartbeats) _heartbeats.Add((JsonObject)heartbeat.DeepClone());
            return Json("""{"results":[]}""");
        }

        private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    private sealed class Answering(Func<HttpRequestMessage, HttpStatusCode> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(new HttpResponseMessage(answer(request)));
    }
}
