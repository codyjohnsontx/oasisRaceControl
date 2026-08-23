using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// "This agent could not see iRacing" separated from "iRacing is closed".
///
/// The two are byte-for-byte identical at the point of failure - the mapping's
/// name does not resolve - and one of them is the whole fleet scoring nothing all
/// night because of how the install was written down. So the separation is a rule
/// with its own tests rather than a line of reasoning inside the Windows attach.
/// </summary>
public sealed class SimReachTests
{
    [Fact]
    public void AnAgentInTheServicesSessionIsToldItWillNeverSeeTheSim()
    {
        var verdict = SimReach.Explain(windowsSession: 0, openWasDenied: false);

        Assert.NotNull(verdict);
        Assert.Contains("session 0", verdict.Summary);
        // The two ways an installer lands here, so whoever reads the full write-up
        // recognises what they set up rather than having to know the Windows term.
        Assert.Contains("service", verdict.Instruction);
        Assert.Contains("logged on", verdict.Instruction);
        Assert.Contains("signed-in session", verdict.Instruction);
    }

    [Theory]
    [InlineData(1)]   // the console user on a rig
    [InlineData(2)]   // a second signed-in user, or someone connected remotely
    [InlineData(17)]
    public void AnAgentInASignedInSessionHasNothingToExplain(int session)
    {
        Assert.Null(SimReach.Explain(session, openWasDenied: false));
    }

    [Fact]
    public void AnAccountThatMayNotReadTheSimIsToldSo()
    {
        var verdict = SimReach.Explain(windowsSession: 1, openWasDenied: true);

        Assert.NotNull(verdict);
        Assert.Contains("different Windows user", verdict.Summary);
        Assert.Contains("same user", verdict.Instruction);
    }

    /// <summary>
    /// Being in session 0 is why the name did not resolve, so it cannot also be an
    /// account problem - and telling somebody to check permissions would send them
    /// hunting a password that is fine.
    /// </summary>
    [Fact]
    public void TheSessionIsBlamedBeforeTheAccount()
    {
        Assert.Same(SimReach.WrongSession, SimReach.Explain(windowsSession: 0, openWasDenied: true));
    }

    /// <summary>
    /// The short half has to fit a rig card on /staff, which is a tile in a row of
    /// twenty-plus and is read at a glance from across the room. The heartbeat
    /// contract caps it at 300 characters, but 300 characters rendered there is an
    /// eleven-line paragraph in small red type that doubles the card's height and
    /// nobody reads - which was what the first version of this did, found by looking
    /// at the dashboard rather than at the test. The whole explanation lives in
    /// Instruction, where somebody fixing the machine will actually read it.
    /// </summary>
    [Theory]
    [InlineData(0, false)]
    [InlineData(1, true)]
    public void TheDashboardGetsALineAndTheLogGetsTheExplanation(int session, bool denied)
    {
        var verdict = SimReach.Explain(session, denied);

        Assert.NotNull(verdict);
        Assert.True(verdict.Summary.Length <= 160, $"{verdict.Summary.Length} characters: {verdict.Summary}");
        // The register the rig card already uses ("the simulator does not publish
        // OnPitRoad"): a clause, not a sentence, so the two read as one list.
        Assert.False(verdict.Summary.EndsWith('.'), $"Reads as a sentence on a card of clauses: {verdict.Summary}");
        // Naming the fault without the fix is what sends somebody to the wrong rig.
        Assert.True(verdict.Instruction.Length > verdict.Summary.Length);
    }

    /// <summary>
    /// The Windows call this rule is fed by, checked against the runtime's own
    /// answer. Skipped everywhere else - there is no session to read.
    /// </summary>
    [Fact]
    public void TheAgentReadsTheSessionWindowsActuallyPutItIn()
    {
        // No sessions to read anywhere else; the rule above is what is portable.
        if (!OperatingSystem.IsWindows()) return;

        var expected = System.Diagnostics.Process.GetCurrentProcess().SessionId;

        Assert.Equal(expected, WindowsSimConnectionFactory.CurrentWindowsSession());
    }
}

/// <summary>
/// The reason reaching the places a person looks: the rig's own status, the
/// heartbeat that draws the staff dashboard, and the pre-flight check.
/// </summary>
public sealed class SimUnreachableReportingTests
{
    private static readonly DateTimeOffset At = new(2026, 8, 19, 19, 30, 0, TimeSpan.Zero);

    [Fact]
    public void ARigThatCannotSeeItsSimStopsLookingLikeAnIdleOne()
    {
        var connections = new FakeSimConnectionFactory(new FakeSim())
        {
            SimIsRunning = false,
            UnreachableReason = SimReach.WrongSession,
        };
        var source = new IRacingTelemetrySource(7, connections, () => At, "test");

        source.Step();

        Assert.False(source.SimRunning);
        Assert.Equal(SimReach.WrongSession.Summary, source.SimUnusableReason);
        // Which is what puts a red card on /staff rather than filing the machine
        // as one of the many that simply have nobody in the seat.
        Assert.Equal(SimHealth.Unreadable, SimHealthReading.Of(source.SimRunning, source.SimUnusableReason));
    }

    [Fact]
    public void AnOrdinaryRigBetweenCustomersStillReportsNothingWrong()
    {
        var connections = new FakeSimConnectionFactory(new FakeSim()) { SimIsRunning = false };
        var source = new IRacingTelemetrySource(7, connections, () => At, "test");

        source.Step();

        Assert.Null(source.SimUnusableReason);
        Assert.Equal(SimHealth.NoSim, SimHealthReading.Of(source.SimRunning, source.SimUnusableReason));
    }

    /// <summary>
    /// A rig retries every couple of seconds for a ten-hour day. Saying it once is
    /// the difference between a log an operator can read and 18,000 identical lines.
    /// </summary>
    [Fact]
    public void ItIsSaidOncePerChangeNotOncePerAttempt()
    {
        var connections = new FakeSimConnectionFactory(new FakeSim())
        {
            SimIsRunning = false,
            UnreachableReason = SimReach.WrongSession,
        };
        var source = new IRacingTelemetrySource(7, connections, () => At, "test");
        var said = new List<SimReachVerdict?>();
        source.SimReachChanged += said.Add;

        for (var i = 0; i < 20; i++) source.Step();

        Assert.Equal(new[] { SimReach.WrongSession }, said);
    }

    /// <summary>
    /// An operator moves the agent into the signed-in session and the rig has to
    /// come back on its own - nobody is going to restart twenty-plus machines.
    /// </summary>
    [Fact]
    public void ItClearsItselfWhenTheSimComesIntoReach()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim)
        {
            SimIsRunning = false,
            UnreachableReason = SimReach.WrongSession,
        };
        var source = new IRacingTelemetrySource(7, connections, () => At, "test");
        var said = new List<SimReachVerdict?>();
        source.SimReachChanged += said.Add;
        source.Step();

        connections.SimIsRunning = true;
        connections.UnreachableReason = null;
        source.Step();

        Assert.Null(source.SimUnusableReason);
        Assert.Equal(new SimReachVerdict?[] { SimReach.WrongSession, null }, said);
    }

    /// <summary>
    /// The one thing this feature must never do. It only ever explains a failure to
    /// attach, so a rig reading its sim is untouched by it - a wrong answer here
    /// would withhold real customers' laps.
    /// </summary>
    [Fact]
    public void ItCannotWithholdALapFromARigThatIsReadingItsSim()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim)
        {
            SimIsRunning = false,
            UnreachableReason = SimReach.WrongSession,
        };
        var source = new IRacingTelemetrySource(7, connections, () => At, "test");
        var laps = new List<LapCompleted>();
        source.LapCompleted += laps.Add;
        source.Step();                              // the rig as it was found: out of reach

        // Somebody moves the agent into the rig's signed-in session and a customer
        // sits down. Nothing restarts.
        connections.SimIsRunning = true;
        connections.UnreachableReason = null;
        source.Step();                              // attach, mid-lap
        sim.CrossTheLine(4, 138.421f);
        source.Step();                              // ends the lap nobody watched the start of
        sim.CrossTheLine(5, 137.902f);
        source.Step();                              // the first lap watched line to line

        Assert.Single(laps);
        Assert.Null(source.SimUnusableReason);
    }

    /// <summary>
    /// A sim that is attached and missing a channel gets the channel answer, not the
    /// reach one: the reach reading belongs to an attempt that did not attach.
    /// </summary>
    [Fact]
    public void AnAttachedSimsOwnVerdictWins()
    {
        var sim = new FakeSim(omitted: ["OnPitRoad"]);
        var connections = new FakeSimConnectionFactory(sim) { UnreachableReason = SimReach.WrongSession };
        var source = new IRacingTelemetrySource(7, connections, () => At, "test");

        source.Step();

        Assert.NotNull(source.SimUnusableReason);
        Assert.Contains("OnPitRoad", source.SimUnusableReason);
    }

    [Fact]
    public void ThePreFlightCheckSeparatesOutOfReachFromNoSim()
    {
        var now = At;
        var connections = new FakeSimConnectionFactory(new FakeSim())
        {
            SimIsRunning = false,
            UnreachableReason = SimReach.WrongSession,
        };

        var result = SimCheck.Run(connections, TimeSpan.FromSeconds(15), () => now, w => now += w);

        Assert.Equal(SimCheck.SimOutOfReach, result.ExitCode);
        Assert.Contains("session 0", result.Message);
        // Named the fix, not just the fault - this is read standing at the rig.
        Assert.Contains("signed-in session", result.Message);
        // And answered rather than waiting out its patience: nothing about this
        // changes in fifteen seconds, and somebody is standing there.
        Assert.True(now - At < TimeSpan.FromSeconds(2), $"waited {now - At}");
    }

    [Fact]
    public void ThePreFlightCheckStillSaysStartIRacingWhenThatIsTheAnswer()
    {
        var now = At;
        var connections = new FakeSimConnectionFactory(new FakeSim()) { SimIsRunning = false };

        var result = SimCheck.Run(connections, TimeSpan.FromSeconds(2), () => now, w => now += w);

        Assert.Equal(SimCheck.SimNotFound, result.ExitCode);
        Assert.Contains("Start iRacing", result.Message);
    }
}
