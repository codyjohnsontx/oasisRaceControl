using System.Net;
using System.Text;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rig's clock measured against the backend's.
///
/// This exists because both halves of what the backend does with a lap's
/// timestamp are silent when the rig's clock is wrong: a machine running behind
/// has its laps refused as belonging to no check-in (a final refusal - the
/// customer's time is gone), and a machine running ahead has them stored,
/// attributed and then filtered off tonight's leaderboard because they landed on
/// tomorrow. Neither shows as an error on the rig, the dashboard, or the board.
/// </summary>
public sealed class ServerClockTests
{
    private static readonly DateTimeOffset Noon =
        new(2026, 8, 19, 12, 0, 0, TimeSpan.Zero);

    /// <summary>An instantaneous round trip against a server whose clock reads
    /// <paramref name="serverTime"/> while this machine reads <paramref name="localTime"/>.</summary>
    private static ServerClock Measured(DateTimeOffset serverTime, DateTimeOffset localTime)
    {
        var clock = new ServerClock();
        // Date is whole seconds on the wire, so the reading has to survive the
        // truncation the header actually applies.
        Assert.True(clock.Observe(Truncate(serverTime), localTime, localTime));
        return clock;
    }

    private static DateTimeOffset Truncate(DateTimeOffset value) =>
        new(value.Ticks - (value.Ticks % TimeSpan.TicksPerSecond), value.Offset);

    /// <summary>A reading is only ever as precise as the whole-second Date header
    /// it came from, so assertions on one are made to the second.</summary>
    private static void AssertNear(TimeSpan expected, TimeSpan actual) =>
        Assert.True((actual - expected).Duration() <= TimeSpan.FromSeconds(1),
            $"expected about {expected}, measured {actual}");

    [Fact]
    public void An_unmeasured_clock_corrects_nothing()
    {
        var clock = new ServerClock();

        Assert.False(clock.Measured);
        Assert.False(clock.IsSkewed);
        Assert.Equal(Noon, clock.Correct(Noon));
        Assert.Null(clock.Describe());
    }

    [Fact]
    public void A_rig_running_behind_stamps_laps_at_the_backends_time()
    {
        // The failure this is here for: the lap is stamped before the driver
        // checked in, so the backend refuses it outright and finally.
        var clock = Measured(serverTime: Noon, localTime: Noon.AddMinutes(-3));

        AssertNear(TimeSpan.FromMinutes(3), clock.Offset);
        Assert.Equal(Noon, clock.Correct(Noon.AddMinutes(-3)), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void A_rig_running_ahead_stamps_laps_at_the_backends_time()
    {
        // The other failure: the lap lands on tomorrow's date and is silently
        // filtered off tonight's leaderboard and the TV board.
        var clock = Measured(serverTime: Noon, localTime: Noon.AddHours(6));

        AssertNear(TimeSpan.FromHours(-6), clock.Offset);
        Assert.Equal(Noon, clock.Correct(Noon.AddHours(6)), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void A_machine_off_by_a_whole_day_is_corrected_too()
    {
        // A rig with a dead CMOS battery comes back on a date from years ago.
        // Nothing about the correction is bounded, because nothing about the
        // failure is.
        var clock = Measured(serverTime: Noon, localTime: Noon.AddDays(-400));

        Assert.Equal(Noon, clock.Correct(Noon.AddDays(-400)), TimeSpan.FromSeconds(1));
        Assert.Contains("400d", clock.Describe());
        Assert.Contains("behind", clock.Describe());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(900)]
    [InlineData(-1500)]
    public void A_healthy_rig_keeps_stamping_laps_with_its_own_clock(int millisecondsOut)
    {
        // Under the deadband there is no evidence of a wrong clock - only of a
        // whole-second Date header and a round trip that is not instant. A rig
        // that is fine must be left exactly as it was, or rolling this out
        // changes the timestamps on nineteen healthy machines to buy nothing.
        var clock = Measured(serverTime: Noon, localTime: Noon.AddMilliseconds(-millisecondsOut));

        Assert.True(clock.Measured);
        Assert.False(clock.IsSkewed);
        Assert.Equal(TimeSpan.Zero, clock.Offset);
        Assert.Equal(Noon, clock.Correct(Noon));
        Assert.Null(clock.Describe());
    }

    [Fact]
    public void A_reading_is_taken_from_the_middle_of_the_round_trip()
    {
        // Ignoring the round trip would charge the whole of it to the clock:
        // with a two-second call, a rig that is exactly right would read as two
        // seconds behind.
        var clock = new ServerClock();
        var sentAt = Noon;
        var receivedAt = Noon.AddSeconds(2);

        Assert.True(clock.Observe(Truncate(Noon.AddSeconds(1)), sentAt, receivedAt));

        Assert.False(clock.IsSkewed);
    }

    [Fact]
    public void A_slow_round_trip_is_not_evidence_about_a_clock()
    {
        var clock = Measured(serverTime: Noon, localTime: Noon.AddMinutes(-3));
        var before = clock.Offset;

        // The venue's internet has a bad moment. A reading this imprecise must
        // not overwrite a good one; the next call is at most five seconds away.
        Assert.False(clock.Observe(
            Truncate(Noon), Noon.AddMinutes(-3), Noon.AddMinutes(-3).Add(ServerClock.MaxRoundTrip * 2)));

        Assert.Equal(before, clock.Offset);
    }

    [Fact]
    public void A_round_trip_that_runs_backwards_is_discarded()
    {
        // Windows time service resyncing mid-request steps the clock, so the
        // response can arrive "before" the request left.
        var clock = new ServerClock();

        Assert.False(clock.Observe(Truncate(Noon), Noon, Noon.AddSeconds(-30)));

        Assert.False(clock.Measured);
    }

    [Fact]
    public void A_clock_that_gets_fixed_stops_being_corrected()
    {
        // Somebody runs w32tm /resync on the rig without restarting the agent.
        var clock = Measured(serverTime: Noon, localTime: Noon.AddMinutes(-3));
        Assert.True(clock.IsSkewed);

        Assert.True(clock.Observe(Truncate(Noon.AddMinutes(1)), Noon.AddMinutes(1), Noon.AddMinutes(1)));

        Assert.False(clock.IsSkewed);
        Assert.Equal(Noon, clock.Correct(Noon));
    }

    [Fact]
    public void A_wrong_clock_is_reported_once_rather_than_every_request()
    {
        // The agent calls the backend every five seconds all day. One line per
        // change is a log somebody can read; one per request is a log that
        // rotates the evidence away.
        var clock = new ServerClock();
        var changes = 0;
        clock.Changed += _ => changes++;

        for (var i = 0; i < 20; i++)
        {
            var local = Noon.AddSeconds(i).AddMinutes(-3);
            Assert.True(clock.Observe(Truncate(Noon.AddSeconds(i)), local, local));
        }

        Assert.Equal(1, changes);
    }

    [Fact]
    public void A_healthy_rig_never_says_anything_about_its_clock()
    {
        var clock = new ServerClock();
        var changes = 0;
        clock.Changed += _ => changes++;

        for (var i = 0; i < 20; i++)
            Assert.True(clock.Observe(Truncate(Noon.AddSeconds(i)), Noon.AddSeconds(i), Noon.AddSeconds(i)));

        Assert.Equal(0, changes);
    }

    [Fact]
    public void A_clock_being_fixed_is_reported_as_well_as_it_going_wrong()
    {
        var clock = Measured(serverTime: Noon, localTime: Noon.AddMinutes(-3));
        var changes = 0;
        clock.Changed += _ => changes++;

        Assert.True(clock.Observe(Truncate(Noon.AddMinutes(1)), Noon.AddMinutes(1), Noon.AddMinutes(1)));

        Assert.Equal(1, changes);
    }

    [Fact]
    public void A_reading_failure_cannot_take_the_agent_down()
    {
        // The subscriber is the rig's log, and a full disk is a real thing on an
        // unattended machine. It must not fail the backend call it rode in on.
        var clock = new ServerClock();
        clock.Changed += _ => throw new IOException("There is not enough space on the disk.");

        Assert.True(clock.Observe(Truncate(Noon), Noon.AddMinutes(-3), Noon.AddMinutes(-3)));

        Assert.True(clock.IsSkewed);
    }

    [Fact]
    public void The_reading_reads_as_a_direction_a_person_can_act_on()
    {
        Assert.Contains("behind", Measured(Noon, Noon.AddMinutes(-3)).Describe());
        Assert.Contains("ahead", Measured(Noon, Noon.AddMinutes(3)).Describe());
        // Rounded to the second it was measured to: an operator reading
        // "5h 59m" off a machine that is exactly six hours out goes looking for
        // a minute that is not there.
        Assert.Equal("3m 0s behind the venue's", Measured(Noon, Noon.AddMinutes(-3)).Describe());
        Assert.Equal("6h 0m ahead of the venue's", Measured(Noon, Noon.AddHours(6)).Describe());
    }

    /// <summary>A backend that answers with a fixed clock of its own.</summary>
    private sealed class ClockStub : HttpMessageHandler
    {
        internal DateTimeOffset ServerTime;
        internal HttpStatusCode Status = HttpStatusCode.OK;
        internal bool SendDate = true;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var response = new HttpResponseMessage(Status)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
            if (SendDate) response.Headers.Date = Truncate(ServerTime);
            return Task.FromResult(response);
        }
    }

    [Fact]
    public async Task Every_backend_call_measures_the_clock()
    {
        // Sitting in the HTTP pipeline rather than in one method is what makes
        // the heartbeat, the driver poll and the lap flush all readings - and a
        // call added later one too, without anybody remembering to wire it up.
        var clock = new ServerClock();
        var stub = new ClockStub { ServerTime = Noon };
        var local = Noon.AddMinutes(-3);
        using var http = new HttpClient(new ServerClockHandler(clock, stub, () => local));

        using var _ = await http.GetAsync("https://x.test/api/agent/assignment");

        AssertNear(TimeSpan.FromMinutes(3), clock.Offset);
    }

    [Fact]
    public async Task A_failed_backend_call_still_measures_the_clock()
    {
        // An offline or misconfigured rig is exactly the machine whose clock
        // nobody has checked, and the response still carries the header.
        var clock = new ServerClock();
        var stub = new ClockStub { ServerTime = Noon, Status = HttpStatusCode.Unauthorized };
        var local = Noon.AddMinutes(-3);
        using var http = new HttpClient(new ServerClockHandler(clock, stub, () => local));

        using var res = await http.GetAsync("https://x.test/api/agent/assignment");

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.True(clock.IsSkewed);
    }

    [Fact]
    public async Task A_response_with_no_date_is_simply_not_a_reading()
    {
        var clock = new ServerClock();
        var stub = new ClockStub { ServerTime = Noon, SendDate = false };
        using var http = new HttpClient(new ServerClockHandler(clock, stub, () => Noon.AddMinutes(-3)));

        using var _ = await http.GetAsync("https://x.test/api/agent/assignment");

        Assert.False(clock.Measured);
        Assert.False(clock.IsSkewed);
    }
}
