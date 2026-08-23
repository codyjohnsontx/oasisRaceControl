using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// "This rig attached to iRacing and could not read a single frame of it" separated
/// from "iRacing is closed".
///
/// The third way a rig can be up, online, and scoring nothing while looking exactly
/// like one of the many machines with nobody in the seat - after a missing channel
/// (<see cref="TelemetryChannels"/>) and an agent Windows started out of reach of
/// the sim (<see cref="SimReach"/>), both of which already say so. Until this it
/// went to the rig's own log file every couple of seconds and nowhere else.
/// </summary>
public sealed class SimDecodeTests
{
    [Fact]
    public void AnIRacingUpdateThatMovedTheFormatIsNamedAsItself()
    {
        var verdict = SimDecode.Explain(new UnsupportedTelemetryFormatException(3, 2));

        // Both numbers, in both lengths: it is the whole reason this is not a fault
        // with the machine somebody is standing in front of.
        Assert.Contains("format 3", verdict.Summary);
        Assert.Contains("format 2", verdict.Summary);
        Assert.Contains("version 3", verdict.Instruction);
        Assert.Contains("version 2", verdict.Instruction);
        // The action, which is not at the rig.
        Assert.Contains("update the Oasis Rig Agent", verdict.Instruction);
        Assert.Contains("every rig", verdict.Instruction);
    }

    /// <summary>
    /// Any other undecodable mapping. It is worth a different answer because there
    /// is something to try here - the format one is not fixed by touching this rig.
    /// </summary>
    [Fact]
    public void AnythingElseUndecodableSaysWhatToTryAtTheRig()
    {
        var verdict = SimDecode.Explain(new MalformedTelemetryException("Tick rate is outside 1..1000."));

        Assert.DoesNotContain("update the Oasis Rig Agent", verdict.Instruction);
        Assert.Contains("Restart iRacing", verdict.Instruction);
        // The parser's own complaint is kept, because it is what a bug report needs.
        Assert.Contains("Tick rate is outside 1..1000.", verdict.Instruction);
    }

    /// <summary>
    /// The same split, and the same reason, as <see cref="SimReach"/>'s: the short
    /// half lands on a /staff rig card that is one tile in a row of twenty-plus, and
    /// 300 characters there is an eleven-line paragraph nobody reads. The whole
    /// explanation belongs in the log, where somebody is reading deliberately.
    /// </summary>
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TheDashboardGetsALineAndTheLogGetsTheExplanation(bool formatMismatch)
    {
        var verdict = SimDecode.Explain(formatMismatch
            ? new UnsupportedTelemetryFormatException(3, 2)
            : new MalformedTelemetryException("Buffer length must be positive and within the mapping."));

        Assert.True(verdict.Summary.Length <= 160, $"{verdict.Summary.Length} characters: {verdict.Summary}");
        // The register the rig card already uses ("the simulator does not publish
        // OnPitRoad"): a clause, not a sentence, so the reasons read as one list.
        Assert.False(verdict.Summary.EndsWith('.'), $"Reads as a sentence on a card of clauses: {verdict.Summary}");
        Assert.True(verdict.Instruction.Length > verdict.Summary.Length);
    }
}

/// <summary>
/// The verdict reaching the places a person looks: the rig's own status, the
/// heartbeat that draws the staff dashboard, and the pre-flight check.
/// </summary>
public sealed class UndecodableTelemetryReportingTests
{
    private static readonly DateTimeOffset At = new(2026, 8, 19, 19, 30, 0, TimeSpan.Zero);

    private static (FakeSim Sim, FakeSimConnectionFactory Connections, IRacingTelemetrySource Source) NewSource()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        return (sim, connections, new IRacingTelemetrySource(7, connections, () => At, "test"));
    }

    /// <summary>Steps until the source has exhausted its tolerance for unreadable
    /// frames and dropped the connection, which is the point the verdict is settled.
    /// Stops exactly there, so what happens on the way back round is a test's own
    /// business rather than something this helper has already stepped past.</summary>
    private static void StepUntilGivenUp(IRacingTelemetrySource source)
    {
        for (var i = 0; i < 20; i++)
            if (!source.Step()) return;

        Assert.Fail("the source never gave up on the mapping");
    }

    [Fact]
    public void ARigWhoseSimPublishesAFormatItCannotReadStopsLookingLikeAnIdleOne()
    {
        var (sim, _, source) = NewSource();
        using var _ = source;
        sim.LayoutVersion(3);

        StepUntilGivenUp(source);

        Assert.False(source.SimRunning);
        Assert.NotNull(source.SimUnusableReason);
        Assert.Contains("format 3", source.SimUnusableReason);
        // Which is what puts a red card on /staff rather than filing the machine as
        // one of the many that simply have nobody in the seat.
        Assert.Equal(SimHealth.Unreadable, SimHealthReading.Of(source.SimRunning, source.SimUnusableReason));
    }

    /// <summary>
    /// The sim rewriting a buffer under a read is an ordinary event with its own
    /// answer (wait for the next frame). Turning one into a red rig card would make
    /// the dashboard useless on exactly the busy nights it is for.
    /// </summary>
    [Fact]
    public void OneUnreadableFrameIsNotAVerdict()
    {
        var (sim, _, source) = NewSource();
        using var _ = source;
        source.Step();
        sim.Corrupt(true);

        source.Step();
        source.Step();

        Assert.Null(source.SimUnusableReason);
        Assert.Null(source.UndecodableReason);
    }

    /// <summary>
    /// The loop drops the connection and re-attaches every couple of seconds for as
    /// long as this holds, so the verdict has to outlive a reconnect - everything
    /// else the connection taught the source is deliberately dropped with it. If it
    /// went too, the rig would be back to reporting a healthy idle machine two
    /// seconds later and the dashboard would flicker between the two all night.
    /// </summary>
    [Fact]
    public void ItSurvivesTheReconnectItCauses()
    {
        var (sim, connections, source) = NewSource();
        using var _ = source;
        sim.LayoutVersion(3);
        StepUntilGivenUp(source);

        // Back round: a fresh connection, a fresh parser, and one unreadable frame
        // it is still being patient about. This is the window a verdict tied to the
        // connection would go missing in, and it is most of the loop's life.
        source.Step();

        Assert.True(connections.Opened.Count > 1, "the source never re-attached");
        Assert.NotNull(source.SimUnusableReason);
        Assert.Equal(SimHealth.Unreadable, SimHealthReading.Of(source.SimRunning, source.SimUnusableReason));
    }

    /// <summary>
    /// A rig spends most of the day with iRacing closed, and this is a fact about
    /// what the simulator on this machine publishes rather than a reading of a live
    /// session. Clearing it when the customer quits would hide a fleet-wide format
    /// break until the first person of the evening sat down.
    /// </summary>
    [Fact]
    public void ItHoldsWhileTheSimIsClosed()
    {
        var (sim, connections, source) = NewSource();
        using var _ = source;
        sim.LayoutVersion(3);
        StepUntilGivenUp(source);

        // The customer quits iRacing. The next look finds nothing to attach to,
        // which is the ordinary state of most of the room for most of the day.
        connections.SimIsRunning = false;
        source.Step();

        Assert.Equal(2, connections.Attempts);
        Assert.NotNull(source.SimUnusableReason);
        Assert.Contains("format 3", source.SimUnusableReason);
    }

    /// <summary>
    /// The agent is updated across twenty-plus machines and each one has to come
    /// back by itself - nobody walks the room clearing statuses.
    /// </summary>
    [Fact]
    public void ItClearsItselfWhenAFrameDecodesAgain()
    {
        var (sim, _, source) = NewSource();
        using var _ = source;
        var said = new List<SimDecodeVerdict?>();
        source.SimDecodeChanged += said.Add;
        sim.LayoutVersion(3);
        StepUntilGivenUp(source);

        sim.LayoutVersion(IrsdkMemoryParser.SupportedLayoutVersion);
        source.Step();
        source.Step();

        Assert.Null(source.SimUnusableReason);
        Assert.Null(source.UndecodableReason);
        Assert.Equal(2, said.Count);
        Assert.NotNull(said[0]);
        Assert.Null(said[1]);
    }

    /// <summary>
    /// The connection is dropped and re-opened every couple of seconds for a
    /// ten-hour day. Saying it once is the difference between a log an operator can
    /// read and one where this line is the only thing in it.
    /// </summary>
    [Fact]
    public void ItIsSaidOncePerChangeNotOncePerAttempt()
    {
        var (sim, _, source) = NewSource();
        using var _ = source;
        var said = new List<SimDecodeVerdict?>();
        var faults = new List<Exception>();
        source.SimDecodeChanged += said.Add;
        source.Faulted += faults.Add;
        sim.LayoutVersion(3);

        for (var i = 0; i < 40; i++) source.Step();

        Assert.Single(said);
        Assert.Single(faults);
    }

    /// <summary>
    /// The one thing this must never do. A rig reading its sim is judged by what it
    /// publishes, not by a decode verdict - a wrong answer here withholds real
    /// customers' laps.
    /// </summary>
    [Fact]
    public void ItCannotWithholdALapFromARigThatIsReadingItsSim()
    {
        var (sim, _, source) = NewSource();
        using var _ = source;
        var laps = new List<LapCompleted>();
        source.LapCompleted += laps.Add;
        sim.LayoutVersion(3);
        StepUntilGivenUp(source);

        // The fleet is updated and a customer sits down. Nothing restarts.
        sim.LayoutVersion(IrsdkMemoryParser.SupportedLayoutVersion);
        source.Step();                                  // attach, mid-lap
        sim.NextFrame().CrossTheLine(4, 138.421f);
        source.Step();                                  // the lap nobody watched the start of
        sim.NextFrame().CrossTheLine(5, 137.902f);
        source.Step();                                  // the first lap watched line to line

        Assert.Single(laps);
        Assert.Null(source.SimUnusableReason);
    }

    /// <summary>
    /// A sim that decoded and is missing a channel gets the channel answer: that
    /// verdict belongs to a frame this agent actually read, and a stale decode
    /// reason on top of it would send somebody to update an agent that is fine.
    /// </summary>
    [Fact]
    public void AnAttachedSimsOwnChannelVerdictWins()
    {
        var sim = new FakeSim(omitted: ["OnPitRoad"]);
        var connections = new FakeSimConnectionFactory(sim);
        using var source = new IRacingTelemetrySource(7, connections, () => At, "test");

        source.Step();

        Assert.NotNull(source.SimUnusableReason);
        Assert.Contains("OnPitRoad", source.SimUnusableReason);
    }

    [Fact]
    public void ThePreFlightCheckSeparatesAnUnreadableSimFromNoSim()
    {
        var now = At;
        var sim = new FakeSim().LayoutVersion(3);
        var connections = new FakeSimConnectionFactory(sim);

        var result = SimCheck.Run(connections, TimeSpan.FromSeconds(15), () => now, w => now += w);

        Assert.Equal(SimCheck.SimUnreadable, result.ExitCode);
        // Not "start iRacing" - it is already running, and that answer is what sends
        // an operator round twenty-plus machines starting a sim that is up on all of
        // them.
        Assert.DoesNotContain("Start iRacing", result.Message);
        Assert.Contains("version 3", result.Message);
        Assert.Contains("update the Oasis Rig Agent", result.Message);
        // Answered rather than waiting out its patience: reading the same layout for
        // another fifteen seconds cannot change it, and somebody is standing there.
        Assert.True(now - At < TimeSpan.FromSeconds(5), $"waited {now - At}");
    }

    [Fact]
    public void ThePreFlightCheckStillPassesARigThatIsReadingItsSim()
    {
        var now = At;
        var connections = new FakeSimConnectionFactory(new FakeSim());

        var result = SimCheck.Run(connections, TimeSpan.FromSeconds(15), () => now, w => now += w);

        Assert.Equal(SimCheck.Pass, result.ExitCode);
    }
}
