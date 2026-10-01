using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using OasisRigAgent.Core.Iracing;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rig half of the live race board: what one rig reports about its own car,
/// when, and what happens when the site does not take it. The wire shape is
/// <c>raceStatusEvent</c> in apps/web/src/lib/events.ts.
/// </summary>
public sealed class RaceStatusTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-race-{Guid.NewGuid():N}.db");
    private long _now = 1_000_000;
    private static readonly DateTimeOffset At = DateTimeOffset.Parse("2026-10-07T19:30:00Z");

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { File.Delete(_dbPath); } catch (IOException) { }
    }

    /// <summary>A car mid-race: third, on lap 5, 2.341 s behind the leader.</summary>
    private static RaceTick Racing() => new()
    {
        SessionUniqueId = 4242,
        SessionNum = 2,
        SessionState = 4,
        SessionFlags = 0x0004_0000u,
        SessionTimeRemain = 1234.56,
        SessionLapsRemainEx = 12,
        PlayerCarIdx = 7,
        PlayerCarPosition = 3,
        PlayerCarClassPosition = 3,
        Lap = 5,
        LapCompleted = 4,
        LapDistPct = 0.37219f,
        OnPitRoad = false,
        IsReplayPlaying = false,
        PlayerCarMyIncidentCount = 2,
        F2Time = 2.3414f,
        LastLapTime = 102.341f,
        BestLapTime = 101.9f,
    };

    private RaceStatusSampler Sampler(RaceTick? tick = null)
    {
        var sampler = new RaceStatusSampler(() => _now)
        {
            SessionTypes = new Dictionary<int, string> { [0] = "Practice", [1] = "Open Qualify", [2] = "Race" },
        };
        if (tick is not null) sampler.Observe(tick);
        return sampler;
    }

    [Fact]
    public void A_car_in_a_race_reports_its_own_row_as_iRacing_has_it()
    {
        var row = Sampler(Racing()).RaceStatus(At);

        Assert.NotNull(row);
        Assert.Equal(At, row!.SampledAt);
        Assert.Equal((4242, 2, "Race", 4, 0x0004_0000u), (row.SessionUniqueId, row.SessionNum, row.SessionType, row.SessionState, row.SessionFlags));
        Assert.Equal(1234.6, row.SessionTimeRemainS);
        Assert.Equal(12, row.SessionLapsRemain);
        Assert.Equal((7, 3, 3), (row.CarIdx, row.Position, row.ClassPosition));
        Assert.Equal((5, 4), (row.Lap, row.LapsCompleted));
        Assert.Equal(0.3722, row.LapDistPct);
        Assert.Equal(2.341, row.GapToLeaderS);
        Assert.Equal((102_341, 101_900), (row.LastLapMs, row.BestLapMs));
        Assert.False(row.OnPitRoad);
        Assert.Equal(2, row.Incidents);
    }

    [Fact]
    public void The_session_type_is_the_one_for_this_SessionNum_and_null_until_named()
    {
        var sampler = Sampler(Racing() with { SessionNum = 1 });
        Assert.Equal("Open Qualify", sampler.RaceStatus(At)!.SessionType);
        // Outside a race the same variable holds a lap time; it goes as read,
        // and the server only treats it as a gap when the type says Race.
        Assert.Equal(2.341, sampler.RaceStatus(At)!.GapToLeaderS);

        sampler.SessionTypes = new Dictionary<int, string>();
        Assert.Null(sampler.RaceStatus(At)!.SessionType);
    }

    [Theory]
    [InlineData(0)]   // invalid: not in a session
    [InlineData(7)]   // not a state the SDK has
    public void No_row_outside_a_session_state(int state)
        => Assert.Null(Sampler(Racing() with { SessionState = state }).RaceStatus(At));

    [Fact]
    public void No_row_without_a_session_a_car_or_a_known_state()
    {
        Assert.Null(Sampler().RaceStatus(At));
        Assert.Null(Sampler(Racing() with { SessionState = null }).RaceStatus(At));
        Assert.Null(Sampler(Racing() with { SessionUniqueId = null }).RaceStatus(At));
        Assert.Null(Sampler(Racing() with { SessionUniqueId = -1 }).RaceStatus(At));
        Assert.Null(Sampler(Racing() with { SessionNum = null }).RaceStatus(At));
        Assert.Null(Sampler(Racing() with { PlayerCarIdx = null }).RaceStatus(At));
        Assert.Null(Sampler(Racing() with { PlayerCarIdx = 64 }).RaceStatus(At));
    }

    [Fact]
    public void No_row_while_a_replay_plays_because_the_channels_describe_the_replay()
        => Assert.Null(Sampler(Racing() with { IsReplayPlaying = true }).RaceStatus(At));

    [Fact]
    public void A_sim_that_stops_ticking_stops_reporting_so_the_board_can_dim_it()
    {
        var sampler = Sampler(Racing());
        _now += (long)RaceStatusSampler.StaleAfter.TotalMilliseconds;
        Assert.NotNull(sampler.RaceStatus(At));
        _now += 1;
        Assert.Null(sampler.RaceStatus(At));

        sampler.Observe(Racing());
        Assert.NotNull(sampler.RaceStatus(At));
    }

    [Fact]
    public void Reset_forgets_the_tick_and_the_session_types()
    {
        var sampler = Sampler(Racing());
        sampler.Reset();
        Assert.Null(sampler.RaceStatus(At));
        sampler.Observe(Racing());
        Assert.Null(sampler.RaceStatus(At)!.SessionType);
    }

    [Fact]
    public void iRacing_sentinels_go_out_as_null()
    {
        var row = Sampler(Racing() with
        {
            PlayerCarPosition = 0,        // not classified yet
            PlayerCarClassPosition = 0,
            Lap = -1,
            LapCompleted = -1,
            LapDistPct = -1f,             // not in the world
            F2Time = -1f,
            LastLapTime = -1f,            // no time yet
            BestLapTime = 0f,
            SessionTimeRemain = 604_800,  // untimed
            SessionLapsRemainEx = 32_767, // unlimited laps
        }).RaceStatus(At)!;

        Assert.Null(row.Position);
        Assert.Null(row.ClassPosition);
        Assert.Null(row.Lap);
        Assert.Null(row.LapsCompleted);
        Assert.Null(row.LapDistPct);
        Assert.Null(row.GapToLeaderS);
        Assert.Null(row.LastLapMs);
        Assert.Null(row.BestLapMs);
        Assert.Null(row.SessionTimeRemainS);
        Assert.Null(row.SessionLapsRemain);
    }

    [Fact]
    public void A_session_number_past_the_contracts_bound_reports_nothing()
    {
        Assert.Equal(63, Sampler(Racing() with { SessionNum = RaceStatusReport.MaxSessionNum }).RaceStatus(At)!.SessionNum);
        Assert.Null(Sampler(Racing() with { SessionNum = RaceStatusReport.MaxSessionNum + 1 }).RaceStatus(At));
    }

    [Fact]
    public void Unknown_channels_never_crash_and_the_two_required_ones_fall_back()
    {
        var row = Sampler(new RaceTick { SessionUniqueId = 1, SessionNum = 0, SessionState = 1, PlayerCarIdx = 0 }).RaceStatus(At)!;
        Assert.Equal(0u, row.SessionFlags);
        Assert.False(row.OnPitRoad);
        Assert.Equal(0, row.Incidents);
        Assert.Null(row.Position);
        Assert.Null(row.GapToLeaderS);
    }

    [Fact]
    public void Values_past_the_contract_are_clamped_or_dropped_rather_than_refused()
    {
        var sampler = Sampler(Racing() with
        {
            PlayerCarMyIncidentCount = 12_345,
            F2Time = 1e6f,
            LapDistPct = 1.2f,
            PlayerCarPosition = 65,
            LastLapTime = 30 * 60 + 1,
            SessionTimeRemain = double.NaN,
        });
        sampler.SessionTypes = new Dictionary<int, string> { [2] = new string('R', 60) };
        var row = sampler.RaceStatus(At)!;

        Assert.Equal(RaceStatusReport.MaxIncidents, row.Incidents);
        Assert.Equal(RaceStatusReport.MaxGapSeconds, row.GapToLeaderS);
        Assert.Equal(1.0, row.LapDistPct);
        Assert.Null(row.Position);
        Assert.Null(row.LastLapMs);
        Assert.Null(row.SessionTimeRemainS);
        Assert.Equal(RaceStatusReport.MaxSessionTypeLength, row.SessionType!.Length);
    }

    /// <summary>Every key of raceStatusEvent, each always present: the schema's
    /// nullable fields are not optional, so leaving one out is a 400.</summary>
    [Fact]
    public void The_wire_shape_carries_every_contract_key_null_included()
    {
        var json = Sampler(Racing() with { PlayerCarPosition = 0 }).RaceStatus(At)!.ToJson();

        Assert.Equal(
            new[]
            {
                "sampledAt", "sessionUniqueId", "sessionNum", "sessionType", "sessionState", "sessionFlags",
                "sessionTimeRemainS", "sessionLapsRemain", "carIdx", "position", "classPosition", "lap",
                "lapsCompleted", "lapDistPct", "gapToLeaderS", "lastLapMs", "bestLapMs", "onPitRoad", "incidents",
            }.Order(),
            json.Select(p => p.Key).Order());
        Assert.True(json.ContainsKey("position"));
        Assert.Null(json["position"]);
        Assert.Equal(3, json["classPosition"]!.GetValue<int>());
        Assert.Equal("Race", json["sessionType"]!.GetValue<string>());
        Assert.Equal(0x0004_0000u, json["sessionFlags"]!.GetValue<uint>());
        Assert.False(json["onPitRoad"]!.GetValue<bool>());
        Assert.Equal(At, DateTimeOffset.Parse(json["sampledAt"]!.GetValue<string>()));
    }

    [Fact]
    public void A_bitfield_with_the_top_bit_set_goes_as_the_unsigned_number()
    {
        var json = Sampler(Racing() with { SessionFlags = 0x8000_0001u }).RaceStatus(At)!.ToJson();
        Assert.Equal("2147483649", json["sessionFlags"]!.ToJsonString());
    }

    [Fact]
    public void An_unchanged_row_waits_for_the_keepalive_and_a_changed_one_goes_at_once()
    {
        var throttle = new RaceStatusThrottle();
        var row = Sampler(Racing()).RaceStatus(At)!;
        Assert.True(throttle.ShouldSend(row, 0));
        throttle.Sent(row, 0);

        // The clock and the session timer move every sample; neither is a change.
        var later = row with { SampledAt = At.AddSeconds(2.5), SessionTimeRemainS = 1232.1 };
        Assert.False(throttle.ShouldSend(later, 2_500));
        Assert.False(throttle.ShouldSend(later, (long)RaceStatusThrottle.KeepAlive.TotalMilliseconds - 1));
        Assert.True(throttle.ShouldSend(later, (long)RaceStatusThrottle.KeepAlive.TotalMilliseconds));

        // Two cars swapping places is a change.
        Assert.True(throttle.ShouldSend(row with { Position = 2 }, 2_500));
        Assert.True(throttle.ShouldSend(row with { LapDistPct = 0.4 }, 2_500));
    }

    [Fact]
    public void The_keepalive_lands_inside_the_feeds_ten_second_ceiling()
    {
        // Sampled every interval, an unchanged row goes on the first tick at
        // or past the keepalive - which must come before ten seconds.
        var ticks = Math.Ceiling(RaceStatusThrottle.KeepAlive / RaceStatusThrottle.Interval);
        Assert.True(ticks * RaceStatusThrottle.Interval.TotalSeconds < 10);
        Assert.InRange(RaceStatusThrottle.Interval.TotalSeconds, 2, 3);
    }

    /// <summary>Records every race-status post; answers with the status the test sets.</summary>
    private sealed class RaceBackend : HttpMessageHandler
    {
        private readonly object _gate = new();
        private readonly List<JsonObject> _posts = new();
        public volatile int Status = 200;
        public volatile bool Down;

        public IReadOnlyList<JsonObject> Posts
        {
            get { lock (_gate) return _posts.ToArray(); }
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/race-status"))
            {
                Assert.Equal(HttpMethod.Post, request.Method);
                Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                lock (_gate) _posts.Add(body);
                if (Down) throw new HttpRequestException("venue network is down");
                return new HttpResponseMessage((HttpStatusCode)Status);
            }
            var answer = path.EndsWith("/assignment") ? """{"assignment":null}""" : """{"results":[]}""";
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(answer, Encoding.UTF8, "application/json") };
        }
    }

    private sealed class SourceOf(Func<DateTimeOffset, RaceStatusReport?> row) : IRaceStatusSource
    {
        public RaceStatusReport? RaceStatus(DateTimeOffset sampledAt) => row(sampledAt);
    }

    private static BackendClient Client(RaceBackend backend) => new(new HttpClient(backend), "https://x.test", "rig-token");

    [Fact]
    public async Task The_reporter_posts_the_row_to_the_race_status_route_and_nothing_outside_a_session()
    {
        var backend = new RaceBackend();
        RaceStatusReport? current = null;
        var reporter = new RaceStatusReporter(new SourceOf(_ => current), Client(backend), _ => { }, () => _now);

        await reporter.TickAsync(CancellationToken.None);
        Assert.Empty(backend.Posts);

        current = Sampler(Racing()).RaceStatus(At);
        await reporter.TickAsync(CancellationToken.None);
        var post = Assert.Single(backend.Posts);
        Assert.Equal(3, post["position"]!.GetValue<int>());
        Assert.Equal(4242, post["sessionUniqueId"]!.GetValue<int>());

        // Unchanged: nothing until the keepalive.
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Single(backend.Posts);
        _now += (long)RaceStatusThrottle.KeepAlive.TotalMilliseconds;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(2, backend.Posts.Count);

        // Overtaken: goes on the next sample.
        current = current! with { Position = 4 };
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(4, backend.Posts[^1]["position"]!.GetValue<int>());
    }

    [Fact]
    public async Task A_single_timeout_or_5xx_is_dropped_and_the_next_interval_posts_again()
    {
        var backend = new RaceBackend { Status = 500 };
        var notices = new List<string>();
        var row = Sampler(Racing()).RaceStatus(At);
        var reporter = new RaceStatusReporter(new SourceOf(_ => row), Client(backend), notices.Add, () => _now);

        await reporter.TickAsync(CancellationToken.None);
        Assert.Single(backend.Posts);

        // Not recorded as sent, so the same row goes again on the next
        // interval: a blip mid-race costs one sample, not a dimmed car.
        backend.Status = 200;
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(2, backend.Posts.Count);

        // A success between failures starts the count again: two failures,
        // a success, two more never back off.
        backend.Down = true;
        for (var i = 0; i < 2; i++)
        {
            row = row! with { Position = 4 + i };
            _now += 2_500;
            await reporter.TickAsync(CancellationToken.None);
        }
        backend.Down = false;
        row = row! with { Position = 1 };
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        backend.Status = 503;
        for (var i = 0; i < 2; i++)
        {
            row = row! with { Position = 2 + i };
            _now += 2_500;
            await reporter.TickAsync(CancellationToken.None);
        }
        backend.Status = 200;
        row = row! with { Position = 7 };
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);

        Assert.Equal(8, backend.Posts.Count);
        Assert.Equal(7, backend.Posts[^1]["position"]!.GetValue<int>());
        Assert.Empty(notices);
    }

    [Fact]
    public async Task Three_failures_in_a_row_back_off_for_thirty_seconds_then_a_fresh_sample_goes()
    {
        var backend = new RaceBackend { Status = 500 };
        var notices = new List<string>();
        var row = Sampler(Racing()).RaceStatus(At);
        var reporter = new RaceStatusReporter(new SourceOf(_ => row), Client(backend), notices.Add, () => _now);
        var backoff = (long)RaceStatusReporter.FailureBackoff.TotalMilliseconds;
        Assert.InRange(RaceStatusReporter.FailureBackoff.TotalSeconds, 30, double.MaxValue);

        await reporter.TickAsync(CancellationToken.None);
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        backend.Down = true;
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(RaceStatusReporter.FailuresBeforeBackoff, backend.Posts.Count);
        var notice = Assert.Single(notices);
        Assert.Contains("laps are unaffected", notice);

        // Even a changed row waits out the backoff.
        row = row! with { Position = 2 };
        _now += backoff - 1;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(3, backend.Posts.Count);

        // Still failing after it: back off again at once, without a second notice.
        _now += 1;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(4, backend.Posts.Count);
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(4, backend.Posts.Count);
        Assert.Single(notices);

        // Taken after the next backoff: back to the ordinary cadence.
        backend.Down = false;
        backend.Status = 200;
        _now += backoff;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(5, backend.Posts.Count);
        Assert.Equal(2, backend.Posts[^1]["position"]!.GetValue<int>());
        row = row! with { Position = 1 };
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(6, backend.Posts.Count);
    }

    [Fact]
    public async Task A_404_backs_off_at_once_because_the_site_has_no_route()
    {
        var backend = new RaceBackend { Status = 404 };
        var notices = new List<string>();
        var row = Sampler(Racing()).RaceStatus(At);
        var reporter = new RaceStatusReporter(new SourceOf(_ => row), Client(backend), notices.Add, () => _now);
        var backoff = (long)RaceStatusReporter.FailureBackoff.TotalMilliseconds;

        await reporter.TickAsync(CancellationToken.None);
        Assert.Single(backend.Posts);
        Assert.Contains("HTTP 404", Assert.Single(notices));

        row = row! with { Position = 2 };
        for (var waited = 2_500L; waited < backoff; waited += 2_500)
        {
            _now += 2_500;
            await reporter.TickAsync(CancellationToken.None);
        }
        Assert.Single(backend.Posts);

        // The route deployed: the first sample after the backoff goes, and a
        // fresh outage after recovering is worth saying again.
        backend.Status = 200;
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(2, backend.Posts.Count);
        backend.Status = 404;
        row = row! with { Position = 3 };
        _now += 2_500;
        await reporter.TickAsync(CancellationToken.None);
        Assert.Equal(2, notices.Count);
        Assert.Contains("HTTP 404", notices[^1]);
    }

    private sealed class RacingTelemetry(Func<RaceStatusReport?> row) : ITelemetrySource, IRaceStatusSource
    {
        public bool SimRunning => true;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { _ = LapCompleted; }
        public RaceStatusReport? RaceStatus(DateTimeOffset sampledAt) => row() is { } r ? r with { SampledAt = sampledAt } : null;
    }

    [Fact]
    public async Task The_agent_runs_the_reporter_on_its_own_loop_and_its_failures_never_mark_the_rig_offline()
    {
        var backend = new RaceBackend { Status = 404 };
        var row = Sampler(Racing()).RaceStatus(At);
        using var queue = new EventQueue(_dbPath);
        var notices = new List<string>();
        var offline = false;
        await using var agent = new AgentService(
            new AgentConfig { BackendBaseUrl = "https://x.test", RigToken = "t", RigNumber = 1 },
            Client(backend), queue, new RacingTelemetry(() => row));
        agent.Notice += n => { lock (notices) notices.Add(n); };
        agent.StatusChanged += s => { if (s.Connection == ConnectionState.Offline) offline = true; };
        agent.Start();

        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (backend.Posts.Count < 1 && DateTime.UtcNow < deadline) await Task.Delay(100);
        Assert.Single(backend.Posts);

        // Two more intervals: the loop keeps ticking, and the backoff holds it.
        await Task.Delay(RaceStatusThrottle.Interval * 2);
        Assert.Single(backend.Posts);
        Assert.False(offline);
        Assert.Equal(ConnectionState.Online, agent.CurrentStatus().Connection);
        lock (notices) Assert.Single(notices, n => n.Contains("live race position"));
    }

    [Fact]
    public async Task With_the_race_status_switched_off_the_agent_posts_none()
    {
        var backend = new RaceBackend();
        var row = Sampler(Racing()).RaceStatus(At);
        using var queue = new EventQueue(_dbPath);
        await using var agent = new AgentService(
            new AgentConfig { BackendBaseUrl = "https://x.test", RigToken = "t", RigNumber = 1, RaceStatus = false },
            Client(backend), queue, new RacingTelemetry(() => row));
        agent.Start();

        await Task.Delay(RaceStatusThrottle.Interval * 2);
        Assert.Empty(backend.Posts);
    }

    [Fact]
    public void The_switch_is_on_unless_the_config_file_turns_it_off()
    {
        var path = Path.Combine(Path.GetTempPath(), $"oasis-race-config-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(path, """{ "backendBaseUrl": "https://x.test", "rigToken": "t", "rigNumber": 1 }""");
            Assert.True(AgentConfig.Load(path).RaceStatus);
            File.WriteAllText(path, """{ "backendBaseUrl": "https://x.test", "rigToken": "t", "rigNumber": 1, "raceStatus": false }""");
            Assert.False(AgentConfig.Load(path).RaceStatus);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void A_switched_off_iracing_source_never_has_a_row()
    {
        using var source = new IracingTelemetrySource(raceStatus: false);
        Assert.Null(source.RaceSampler);
        Assert.Null(source.RaceStatus(At));
    }
}
