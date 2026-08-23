using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The check somebody runs standing at a rig, before opening.
///
/// Twenty-plus machines get this agent installed, and the only honest way to know a
/// given one will score is to ask the sim on that machine. So `--check-sim` has to
/// answer in seconds, tell a person what to do about each answer, and be safe to run
/// on a rig with the agent already running — which is the normal state, because it
/// starts with Windows.
/// </summary>
public class SimCheckTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(15);

    /// <summary>A clock the test advances by exactly the waits the check asks for, so
    /// its patience is exercised without anything sleeping.</summary>
    private sealed class TestClock
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-08-19T19:00:00Z");
        internal DateTimeOffset Now() => _now;
        internal void Advance(TimeSpan by) => _now += by;
        internal int Waits { get; private set; }
        internal void Wait(TimeSpan by) { Waits++; Advance(by); }
    }

    [Fact]
    public void AGoodRigPasses()
    {
        var clock = new TestClock();
        var result = SimCheck.Run(new FakeSimConnectionFactory(new FakeSim()), Patience, clock.Now, clock.Wait);

        Assert.Equal(SimCheck.Pass, result.ExitCode);
        Assert.True(result.Report!.CanScore);
        Assert.Contains("PASS", result.Message);
    }

    [Fact]
    public void ARigThatCannotJudgeALapFailsAndNamesTheChannel()
    {
        var clock = new TestClock();
        var result = SimCheck.Run(
            new FakeSimConnectionFactory(new FakeSim(omitted: ["OnPitRoad"])), Patience, clock.Now, clock.Wait);

        Assert.Equal(SimCheck.ChannelsUnusable, result.ExitCode);
        Assert.Contains("FAIL", result.Message);
        Assert.Contains("OnPitRoad", result.Message);
        Assert.Contains("will not score", result.Message);
    }

    /// <summary>A channel that only costs precision is not a reason to send somebody to
    /// a rig, so it must not fail the check that decides that.</summary>
    [Fact]
    public void ARigMissingOnlyADegradingChannelStillPasses()
    {
        var clock = new TestClock();
        var result = SimCheck.Run(
            new FakeSimConnectionFactory(new FakeSim(omitted: ["SessionUniqueID"])), Patience, clock.Now, clock.Wait);

        Assert.Equal(SimCheck.Pass, result.ExitCode);
        Assert.Equal("SessionUniqueID", Assert.Single(result.Report!.Degraded).Channel.Name);
    }

    /// <summary>iRacing closed is the ordinary state of a rig between customers, and it
    /// is not the same answer as "this rig is broken" — so it gets its own exit code
    /// and an instruction rather than a diagnosis.</summary>
    [Fact]
    public void NoSimRunningSaysWhatToDoAboutItAndGivesUp()
    {
        var clock = new TestClock();
        var result = SimCheck.Run(
            new FakeSimConnectionFactory(new FakeSim()) { SimIsRunning = false }, Patience, clock.Now, clock.Wait);

        Assert.Equal(SimCheck.SimNotFound, result.ExitCode);
        Assert.Null(result.Report);
        Assert.Contains("Start iRacing", result.Message);
        Assert.True(clock.Waits > 1, "it should keep looking for the length of its patience");
    }

    /// <summary>iRacing open but sitting in the menus publishes a mapping with no live
    /// session, which is the same "not yet" rather than a fault.</summary>
    [Fact]
    public void SimInTheMenusIsNotYetRatherThanBroken()
    {
        var clock = new TestClock();
        var sim = new FakeSim().InASession(false);
        var result = SimCheck.Run(new FakeSimConnectionFactory(sim), Patience, clock.Now, clock.Wait);

        Assert.Equal(SimCheck.SimNotFound, result.ExitCode);
        Assert.Contains("get into a session", result.Message);
    }

    /// <summary>A rig where the telemetry cannot be opened at all — the shape a
    /// permissions or antivirus problem takes — reports what the machine said rather
    /// than "no sim", because the two send an operator somewhere different.</summary>
    [Fact]
    public void AnAttachThatFailsReportsWhatTheMachineSaid()
    {
        var clock = new TestClock();
        var factory = new FakeSimConnectionFactory(new FakeSim())
        {
            FailWith = () => new UnauthorizedAccessException("Access to the telemetry mapping is denied."),
        };

        var result = SimCheck.Run(factory, Patience, clock.Now, clock.Wait);

        Assert.Equal(SimCheck.SimNotFound, result.ExitCode);
        Assert.Contains("Access to the telemetry mapping is denied.", result.Message);
    }

    /// <summary>It has to stop on its own: it is run from a command prompt on a rig,
    /// often one with no sim running.</summary>
    [Fact]
    public void ItGivesUpWithinItsPatience()
    {
        var clock = new TestClock();
        SimCheck.Run(
            new FakeSimConnectionFactory(new FakeSim()) { SimIsRunning = false },
            TimeSpan.FromSeconds(3), clock.Now, clock.Wait);

        Assert.True(clock.Now() <= DateTimeOffset.Parse("2026-08-19T19:00:04Z"),
            "the check must not outlast its patience by more than one poll");
    }

    /// <summary>Read-only, and it takes no lock — so running it on a rig with the agent
    /// already running neither disturbs the agent nor is refused by it.</summary>
    [Fact]
    public void ItOnlyReadsAndReleasesWhatItOpened()
    {
        var clock = new TestClock();
        var factory = new FakeSimConnectionFactory(new FakeSim());
        SimCheck.Run(factory, Patience, clock.Now, clock.Wait);

        Assert.NotEmpty(factory.Opened);
        Assert.All(factory.Opened, connection => Assert.True(connection.Disposed));
    }
}
