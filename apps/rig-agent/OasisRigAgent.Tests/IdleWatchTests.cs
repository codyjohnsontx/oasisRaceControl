using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rule that decides a customer has gone home.
///
/// Getting this wrong is expensive in both directions. Too slow and the next
/// walk-in's laps are credited to the last one on the phone, the dashboard and the
/// TV board; too eager and it signs out a customer who is mid-stint, which is the
/// same lost session with an apology attached. So the cases below are mostly about
/// what must NOT end a check-in.
/// </summary>
public sealed class IdleWatchTests
{
    private static readonly TimeSpan EndAfter = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan WarnFor = TimeSpan.FromMinutes(1);

    private static IdleWatch Watch() => new(EndAfter, WarnFor);
    private static TimeSpan At(double minutes) => TimeSpan.FromMinutes(minutes);

    [Fact]
    public void AnAvailableRigHasNobodyToSignOut()
    {
        var watch = Watch();
        for (var m = 0; m < 30; m++)
            Assert.Equal(IdleAction.None, watch.Observe(null, SimHealth.NoSim, At(m)).Action);
    }

    [Fact]
    public void ARunningSimulatorIsSomebodyInTheSeat()
    {
        var watch = Watch();
        // Parked in the garage for half an hour reading a setup screen is still a
        // customer at the machine.
        for (var m = 0; m < 30; m++)
            Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.Scoring, At(m)).Action);
    }

    [Fact]
    public void ASimulatorTheAgentCannotSeeNeverSignsAnybodyOut()
    {
        // The failure this guards is the whole room at once: an agent Windows
        // started where iRacing's shared memory is invisible to it reports exactly
        // this, on every rig, from the moment it starts. Counting that as an empty
        // seat would sign out every customer in the venue one idle period after the
        // fleet was installed - while they were all still driving.
        var watch = Watch();
        for (var m = 0; m < 60; m++)
            Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.Unreadable, At(m)).Action);
    }

    [Fact]
    public void AClosedSimulatorWarnsFirstAndThenEndsTheCheckIn()
    {
        var watch = Watch();
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(0)).Action);
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(8)).Action);

        var warning = watch.Observe("a1", SimHealth.NoSim, At(9.5));
        Assert.Equal(IdleAction.Warn, warning.Action);
        Assert.Equal(TimeSpan.FromSeconds(30), warning.Remaining);
        Assert.Equal("a1", warning.AssignmentId);

        var end = watch.Observe("a1", SimHealth.NoSim, At(10));
        Assert.Equal(IdleAction.EndSession, end.Action);
        Assert.Equal("a1", end.AssignmentId);
    }

    [Fact]
    public void TheClockStartsWhenTheSimulatorCloses_NotWhenTheAgentStarted()
    {
        // A rig that has been switched on since this morning must still give a
        // customer who checks in at 9pm the whole period, so the age is measured
        // from the first closed-simulator reading of THIS empty seat, never from
        // the agent's own uptime.
        var watch = Watch();
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(600)).Action);
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(605)).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, At(610)).Action);
    }

    [Fact]
    public void RestartingTheSimulatorDuringTheWarningKeepsTheSession()
    {
        // The warning is on the rig's own screen precisely so a customer who is
        // still there can do this.
        var watch = Watch();
        watch.Observe("a1", SimHealth.NoSim, At(0));
        Assert.Equal(IdleAction.Warn, watch.Observe("a1", SimHealth.NoSim, At(9.5)).Action);
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.Scoring, At(9.6)).Action);
        // The period runs again from the moment the sim closed the second time.
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(19)).Action);
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(27)).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, At(29)).Action);
    }

    [Fact]
    public void ANewCustomerStartsTheirOwnClock()
    {
        var watch = Watch();
        watch.Observe("a1", SimHealth.NoSim, At(0));
        Assert.Equal(IdleAction.Warn, watch.Observe("a1", SimHealth.NoSim, At(9.5)).Action);

        // Somebody scanned the QR code while the last check-in was counting down.
        Assert.Equal(IdleAction.None, watch.Observe("a2", SimHealth.NoSim, At(9.6)).Action);
        Assert.Equal(IdleAction.None, watch.Observe("a2", SimHealth.NoSim, At(15)).Action);

        var end = watch.Observe("a2", SimHealth.NoSim, At(19.7));
        Assert.Equal(IdleAction.EndSession, end.Action);
        Assert.Equal("a2", end.AssignmentId);
    }

    [Fact]
    public void TheVerdictKeepsSayingEndUntilTheBackendActuallyEndsIt()
    {
        // The rig can be offline at the moment it decides. Dropping the decision
        // there would leave the check-in open for the rest of the night, so it is
        // repeated until the request lands and the poll clears the assignment.
        var watch = Watch();
        watch.Observe("a1", SimHealth.NoSim, At(0));
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, At(10)).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, At(11)).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, At(45)).Action);
        Assert.Equal(IdleAction.None, watch.Observe(null, SimHealth.NoSim, At(46)).Action);
    }

    [Fact]
    public void AVenueThatClearsItsOwnRigsCanTurnItOff()
    {
        var watch = new IdleWatch(TimeSpan.Zero, WarnFor);
        Assert.True(watch.Disabled);
        for (var m = 0; m < 120; m++)
            Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(m)).Action);
    }

    [Fact]
    public void AWarningLongerThanThePeriodWarnsFromTheStartRatherThanNever()
    {
        var watch = new IdleWatch(TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(5));
        Assert.Equal(IdleAction.Warn, watch.Observe("a1", SimHealth.NoSim, TimeSpan.Zero).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, TimeSpan.FromSeconds(30)).Action);
    }

    [Fact]
    public void AReadingThatGoesBackwardsRestartsTheClockInsteadOfNeverExpiring()
    {
        var watch = Watch();
        watch.Observe("a1", SimHealth.NoSim, At(20));
        // Negative age would otherwise sit below the period for as long as the rig
        // is switched on.
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, At(1)).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, At(11)).Action);
    }

    [Fact]
    public void ThePeriodIsDescribedInTheUnitsWhoeverReadsTheLogThinksIn()
    {
        Assert.Equal("10 minute(s)", IdleWatch.Describe(TimeSpan.FromMinutes(10)));
        Assert.Equal("20 second(s)", IdleWatch.Describe(TimeSpan.FromSeconds(20)));
    }

    [Fact]
    public void TheConfiguredPeriodIsWhatTheRigUses()
    {
        var config = new AgentConfig
        {
            BackendBaseUrl = "https://example.test",
            RigToken = "t",
            RigNumber = 1,
            IdleTimeoutSeconds = 90,
            IdleWarningSeconds = 30,
        };
        var watch = IdleWatch.From(config);

        Assert.False(watch.Disabled);
        Assert.Equal(TimeSpan.FromSeconds(90), watch.EndAfter);
        watch.Observe("a1", SimHealth.NoSim, TimeSpan.Zero);
        Assert.Equal(IdleAction.None, watch.Observe("a1", SimHealth.NoSim, TimeSpan.FromSeconds(59)).Action);
        Assert.Equal(IdleAction.Warn, watch.Observe("a1", SimHealth.NoSim, TimeSpan.FromSeconds(61)).Action);
        Assert.Equal(IdleAction.EndSession, watch.Observe("a1", SimHealth.NoSim, TimeSpan.FromSeconds(90)).Action);
    }
}
