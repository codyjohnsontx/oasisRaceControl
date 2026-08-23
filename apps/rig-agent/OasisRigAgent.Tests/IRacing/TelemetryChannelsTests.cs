using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The failure this fleet is least equipped to notice: the sim does not publish a
/// channel the agent reads.
///
/// The agent addresses channels by name, and a name that is not there decodes to null
/// rather than failing — so whichever rule reads it quietly stands down. Left
/// unchecked that is a rig heartbeating all night with the sim running and no lap ever
/// reaching the leaderboard, or — worse — a rig publishing in-laps through the pits as
/// real times. Both look completely healthy from every screen the venue has.
///
/// Every test here drives the real <see cref="IRacingTelemetrySource"/> against a
/// simulator missing exactly one channel, which is what an iRacing update that renames
/// one looks like from the agent.
/// </summary>
public class TelemetryChannelsTests
{
    private static readonly DateTimeOffset At = DateTimeOffset.Parse("2026-08-19T19:00:00Z");

    private sealed record Run(
        List<LapCompleted> Laps,
        List<LapDetection> Rejected,
        List<TelemetryChannelReport> Checks,
        IRacingTelemetrySource Source);

    /// <summary>Attaches, primes, and drives one clean lap past the line.</summary>
    private static Run DriveACleanLap(FakeSim sim)
    {
        var run = Attach(sim);
        run.Source.Step();                              // attach + first frame
        sim.CrossTheLine(4, 138.5f); run.Source.Step(); // priming crossing
        sim.CrossTheLine(5, 138.2f); run.Source.Step(); // the first judgeable lap
        return run;
    }

    private static Run Attach(FakeSim sim)
    {
        var source = new IRacingTelemetrySource(1, new FakeSimConnectionFactory(sim), () => At, "test");
        var run = new Run([], [], [], source);
        source.LapCompleted += run.Laps.Add;
        source.LapRejected += run.Rejected.Add;
        source.ChannelsChecked += run.Checks.Add;
        return run;
    }

    [Fact]
    public void AGoodSimPasses()
    {
        var run = DriveACleanLap(new FakeSim());

        var report = Assert.Single(run.Checks);
        Assert.True(report.CanScore);
        Assert.Empty(report.Blocking);
        Assert.Empty(report.Degraded);
        Assert.Null(report.BlockingSummary);
        Assert.Null(run.Source.SimUnusableReason);
        Assert.True(run.Source.SimRunning);
        Assert.Single(run.Laps);
        run.Source.Dispose();
    }

    /// <summary>Every channel the agent declares is one the fake sim publishes, and
    /// every channel the fake sim publishes is one the agent declares — so a channel
    /// added to the rules without being declared cannot pass the suite unnoticed.</summary>
    [Fact]
    public void TheDetectorReadsExactlyTheDeclaredChannels()
    {
        Assert.Equal(
            TelemetryChannels.All.Select(c => c.Name).OrderBy(n => n, StringComparer.Ordinal),
            LapDetector.WatchedVariables.OrderBy(n => n, StringComparer.Ordinal));

        var run = DriveACleanLap(new FakeSim());
        Assert.All(Assert.Single(run.Checks).Results, r => Assert.Equal(ChannelStatus.Present, r.Status));
        run.Source.Dispose();
    }

    /// <summary>The whole reason this exists: without the lap counter the rig scored
    /// nothing and said nothing, for as long as nobody happened to look at the
    /// leaderboard.</summary>
    [Fact]
    public void WithoutTheLapCounterTheRigSaysSoInsteadOfGoingQuiet()
    {
        var run = DriveACleanLap(new FakeSim(omitted: ["LapCompleted"]));

        Assert.Empty(run.Laps);
        var report = Assert.Single(run.Checks);
        Assert.False(report.CanScore);
        Assert.Equal("LapCompleted", Assert.Single(report.Blocking).Channel.Name);
        Assert.Contains("LapCompleted", run.Source.SimUnusableReason);
        run.Source.Dispose();
    }

    /// <summary>The worse half: these do not stop laps, they stop laps being judged.
    /// A lap that cannot be judged clean is not a lap the venue keeps, so it is
    /// withheld rather than published as if nothing had happened.</summary>
    [Theory]
    [InlineData("OnPitRoad")]
    [InlineData("IsInGarage")]
    [InlineData("IsOnTrack")]
    [InlineData("IsReplayPlaying")]
    [InlineData("PlayerTrackSurface")]
    [InlineData("PlayerCarMyIncidentCount")]
    [InlineData("LapLastLapTime")]
    public void AValidityChannelMissingWithholdsLapsRatherThanPublishingUnjudgedOnes(string channel)
    {
        var run = DriveACleanLap(new FakeSim(omitted: [channel]));

        Assert.Empty(run.Laps);
        var report = Assert.Single(run.Checks);
        Assert.False(report.CanScore);
        Assert.Equal(channel, Assert.Single(report.Blocking).Channel.Name);
        Assert.False(run.Source.SimRunning, "a rig that cannot keep a lap is not a rig that is scoring");
        run.Source.Dispose();
    }

    /// <summary>The concrete case, driven the way a customer does it: a lap through the
    /// pit lane used to land on the public leaderboard as a five-minute best time.</summary>
    [Fact]
    public void APitLapIsNotPublishedWhenThePitChannelIsMissing()
    {
        var sim = new FakeSim(omitted: ["OnPitRoad"]);
        var run = Attach(sim);

        run.Source.Step();
        sim.CrossTheLine(4, 138.5f); run.Source.Step();
        sim.OnPitRoad(true); run.Source.Step();          // through the pits, unseen
        sim.CrossTheLine(5, 300.0f); run.Source.Step();  // the in-lap crosses the line

        Assert.Empty(run.Laps);
        run.Source.Dispose();
    }

    /// <summary>A channel published under another type decodes to nothing, so it has to
    /// be caught as carefully as one that is absent — and named differently, because
    /// what an operator does about it is different.</summary>
    [Fact]
    public void AChannelPublishedUnderAnotherTypeIsCaughtAndNamed()
    {
        var run = DriveACleanLap(new FakeSim(
            omitted: null,
            retyped: new Dictionary<string, IrsdkVariableType>
            {
                ["PlayerCarMyIncidentCount"] = IrsdkVariableType.Float,
            }));

        Assert.Empty(run.Laps);
        var blocking = Assert.Single(Assert.Single(run.Checks).Blocking);
        Assert.Equal(ChannelStatus.WrongType, blocking.Status);
        Assert.Equal(IrsdkVariableType.Float, blocking.Published);
        Assert.Contains("published as Float", blocking.Describe());
        Assert.Contains("STOPS THIS RIG SCORING", blocking.Describe());
        run.Source.Dispose();
    }

    /// <summary>Over-strictness has its own cost: a rig that stops scoring over a
    /// channel laps do not actually depend on is an outage the venue did not need.
    /// These degrade the description of a lap, not its honesty, so they warn.</summary>
    [Theory]
    [InlineData("Lap")]
    [InlineData("SessionNum")]
    [InlineData("SessionUniqueID")]
    public void AChannelThatOnlyCostsPrecisionWarnsAndKeepsScoring(string channel)
    {
        var run = DriveACleanLap(new FakeSim(omitted: [channel]));

        var report = Assert.Single(run.Checks);
        Assert.True(report.CanScore);
        Assert.Equal(channel, Assert.Single(report.Degraded).Channel.Name);
        Assert.Single(run.Laps);
        Assert.Null(run.Source.SimUnusableReason);
        run.Source.Dispose();
    }

    /// <summary>A rig that cannot score today is one iRacing update away from being
    /// able to again, and nobody restarts twenty-plus agents to find out. So the check
    /// is per attach, not per process.</summary>
    [Fact]
    public void TheCheckRunsAgainWhenTheSimIsRestarted()
    {
        var broken = new FakeSim(omitted: ["OnPitRoad"]);
        var factory = new FakeSimConnectionFactory(broken);
        using var source = new IRacingTelemetrySource(1, factory, () => At, "test");
        var checks = new List<TelemetryChannelReport>();
        var laps = new List<LapCompleted>();
        source.ChannelsChecked += checks.Add;
        source.LapCompleted += laps.Add;

        source.Step();
        broken.CrossTheLine(4, 138.5f); source.Step();
        broken.CrossTheLine(5, 138.2f); source.Step();
        Assert.False(checks[0].CanScore);
        Assert.Empty(laps);

        // iRacing closes, updates, and comes back publishing the channel again.
        factory.SimIsRunning = false;
        source.Step();
        var fixedSim = new FakeSim();
        var repaired = new FakeSimConnectionFactory(fixedSim);
        using var second = new IRacingTelemetrySource(1, repaired, () => At, "test");
        second.ChannelsChecked += checks.Add;
        second.LapCompleted += laps.Add;
        second.Step();
        fixedSim.CrossTheLine(4, 138.5f); second.Step();
        fixedSim.CrossTheLine(5, 138.2f); second.Step();

        Assert.Equal(2, checks.Count);
        Assert.True(checks[1].CanScore);
        Assert.Single(laps);
    }

    /// <summary>Reported once per attach rather than per frame — the sim publishes at
    /// 60 Hz, and a check that logged every frame would bury the log it is written to.</summary>
    [Fact]
    public void TheCheckIsReportedOncePerAttachNotPerFrame()
    {
        var sim = new FakeSim();
        var run = Attach(sim);
        for (var frame = 0; frame < 30; frame++) { sim.NextFrame(); run.Source.Step(); }

        Assert.Single(run.Checks);
        run.Source.Dispose();
    }

    /// <summary>What is actually written down when a rig will not score. The names are
    /// the point: this is the difference between "why is rig 7 quiet" taking a minute
    /// and taking a night.</summary>
    [Fact]
    public void TheReportNamesWhatIsWrongAndWhyItMatters()
    {
        var run = DriveACleanLap(new FakeSim(omitted: ["OnPitRoad", "PlayerCarMyIncidentCount"]));
        var described = Assert.Single(run.Checks).Describe();

        Assert.Contains("FAIL", described);
        Assert.Contains("OnPitRoad", described);
        Assert.Contains("PlayerCarMyIncidentCount", described);
        Assert.Contains("scores as a real time", described);   // what it costs, not just its name
        Assert.Contains("LapCompleted: ok", described);          // and what is fine, for contrast
        run.Source.Dispose();
    }
}
