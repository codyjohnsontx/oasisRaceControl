using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The live path, end to end: bytes in the sim's own layout go in, and the laps
/// the venue keeps come out. What is exercised here is everything the pure lap
/// rules cannot be - attaching to a sim that is not running yet, losing it
/// mid-stint, a mapping that goes bad under a read, and metadata that changes
/// while a customer is driving.
///
/// A rig runs this unattended for a ten-hour day with customers rotating through
/// it, so "recovers by itself" is the requirement, not "reports an error".
/// </summary>
public sealed class IRacingTelemetrySourceTests
{
    private static readonly DateTimeOffset At = new(2026, 8, 19, 19, 30, 0, TimeSpan.Zero);

    [Fact]
    public void ALapDrivenOnTheSimBecomesALapTheVenueKeeps()
    {
        var (sim, _, source, laps, _) = NewSource();

        source.Step();                              // attach, mid-lap, to a stint already running
        Cross(sim, source, 4, 138.421f);            // ends the lap nobody watched the start of
        Cross(sim, source, 5, 137.902f);            // the first lap watched from line to line

        var lap = Assert.Single(laps);
        Assert.Equal("Circuit de Spa-Francorchamps", lap.TrackName);
        Assert.Equal("Grand Prix Pits", lap.TrackConfig);
        Assert.Equal("Porsche 911 GT3 R", lap.CarName);
        Assert.Equal(5, lap.LapNumber);
        Assert.Equal(137_902, lap.LapTimeMs);
        Assert.Equal(At, lap.CompletedAt);
        Assert.True(source.SimRunning);
    }

    [Fact]
    public void ALapRunWideOffTheRoadCarriesThatOutOfTheSimEvenWithNoIncidentCharged()
    {
        // The single most damaging lap the venue can produce: iRacing charges no
        // point for a great many offs, so a lap that ran wide at the fastest corner
        // arrives 0x and, taken at face value, tops a board whose whole rule is
        // clean laps only. Driven here through the real shared-memory layout rather
        // than a hand-built frame dictionary, because the surface channel has to
        // survive the parser too.
        var (sim, _, source, laps, _) = NewSource();
        AttachMidStint(sim, source);

        sim.OffTrack(true).NextFrame();
        source.Step();
        sim.OffTrack(false).NextFrame();
        source.Step();
        Cross(sim, source, 5, 136.204f);            // ...and it is the fastest of the night

        var wide = Assert.Single(laps);
        Assert.True(wide.OffTrackSeen);
        Assert.Equal(0, wide.IncidentDelta);        // the sim let it go; the agent did not
        Assert.Equal(136_204, wide.LapTimeMs);

        // The next lap, driven properly, is not punished for the one before it.
        laps.Clear();
        Cross(sim, source, 6, 137.902f);
        Assert.False(Assert.Single(laps).OffTrackSeen);
    }

    [Fact]
    public void ARigWithNoSimRunningReportsItAndKeepsLooking()
    {
        var (_, connections, source, laps, _) = NewSource();
        connections.SimIsRunning = false;

        Assert.False(source.Step());
        Assert.False(source.Step());

        Assert.False(source.SimRunning);
        Assert.Empty(laps);
        Assert.Equal(2, connections.Attempts);          // it keeps checking rather than giving up
        Assert.Empty(connections.Opened);
    }

    [Fact]
    public void TheSameFrameReadTwiceIsNotTwoLaps()
    {
        var (sim, _, source, laps, _) = NewSource();
        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);

        sim.RepeatFrame();
        source.Step();
        source.Step();

        Assert.Single(laps);
    }

    [Fact]
    public void LosingTheSimMidStintNeverInventsALapWhenItComesBack()
    {
        var (sim, connections, source, laps, _) = NewSource();
        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);
        Assert.Single(laps);

        // The customer quits to the desktop mid-stint.
        sim.InASession(false);
        connections.SimIsRunning = false;
        Assert.False(source.Step());
        Assert.False(source.SimRunning);
        Assert.True(connections.Latest!.Disposed);
        Assert.False(source.Step());

        // ...and the next one loads back in, already partway around a fresh session.
        connections.SimIsRunning = true;
        sim.InASession(true).SessionId(11).CrossTheLine(2, 0f);
        source.Step();
        Cross(sim, source, 3, 140.5f);

        // That lap started before anyone was watching: its incident count is
        // unknowable, so it is not a lap the venue can stand behind.
        Assert.Single(laps);

        Cross(sim, source, 4, 139.8f);
        Assert.Equal(2, laps.Count);
        Assert.Equal(4, laps[1].LapNumber);
    }

    [Fact]
    public void ASimSittingInAMenuIsNotRunningAndSetsNoBaseline()
    {
        var (sim, connections, source, laps, _) = NewSource();
        sim.InASession(false);

        // iRacing is open but nothing is being driven. The agent lets the mapping go,
        // so that iRacing restarting - which publishes into a brand new one - is picked
        // up rather than watched for on a region nothing writes to any more.
        Assert.False(source.Step());
        Assert.False(source.SimRunning);
        Assert.True(connections.Latest!.Disposed);

        // Loading in, already a couple of laps into a hosted session.
        sim.InASession(true);
        source.Step();
        Assert.True(source.SimRunning);
        Assert.Empty(laps);
        Assert.Equal(2, connections.Opened.Count);

        Cross(sim, source, 4, 138.4f);
        Assert.Empty(laps);

        Cross(sim, source, 5, 137.9f);
        Assert.Single(laps);
    }

    /// <summary>
    /// The lap the customer just drove, landing while the agent is part-way through a read.
    ///
    /// The sim writes the new lap counter and that lap's time into the same buffer, so a
    /// read caught in between can come away with one and not the other: a lap carrying the
    /// previous lap's time, or a lap carrying no time at all. Nothing downstream can see
    /// that a frame was stitched together - every value in it is a plausible number.
    ///
    /// The sim is made to get in the way at every channel boundary, because which channel
    /// the parser reads first is a detail of how the watched set happens to enumerate.
    /// Today it reads the lap counter first, which makes the worst reading - the new lap
    /// counter beside the old lap's time - the one order this cannot produce. That is luck,
    /// not a rule, and it would change the day a channel is added to
    /// <see cref="TelemetryChannels"/>. The frame being one tick or none is the rule.
    /// </summary>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(6)]
    [InlineData(8)]
    [InlineData(11)]
    public void NeverPublishesALapBuiltFromAFrameTheSimRewroteMidRead(int tearAfterReads)
    {
        var sim = new FakeSim();
        var reader = new TearingMemoryReader(
            sim.Bytes, () => sim.CrossTheLine(5, 137.9f), tearAfterReads, maxTears: 0);
        var connections = new FakeSimConnectionFactory(sim) { ReadThrough = reader };
        using var source = new IRacingTelemetrySource(7, connections, () => At, "test");
        var laps = new List<LapCompleted>();
        source.LapCompleted += laps.Add;

        AttachMidStint(sim, source);          // the previous lap stands at 138.4
        reader.MaxTears = 1;                  // the next lap lands mid-read

        for (var frame = 0; frame < 12 && laps.Count == 0; frame++)
        {
            sim.NextFrame();
            source.Step();
        }

        Assert.Equal(1, reader.Tears);
        Assert.Equal(137_900, Assert.Single(laps).LapTimeMs);
    }

    /// <summary>
    /// A rig that never once gets a clean read of the sim is a rig that is not scoring,
    /// and it must not sit there looking like one between customers.
    /// </summary>
    [Fact]
    public void ASimThatRewritesUnderEveryReadIsEventuallyDroppedRatherThanWaitedOnForever()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        var reader = new TearingMemoryReader(sim.Bytes, () => sim.NextFrame(), maxTears: 0);
        connections.ReadThrough = reader;
        var clock = new TestClock(At);
        using var source = new IRacingTelemetrySource(7, connections, clock.Read, "test");
        var faults = new List<Exception>();
        source.Faulted += faults.Add;

        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);
        Assert.True(source.SimRunning);

        // The rig falls behind the sim for good - the machine is loaded, or the reader
        // is paused long enough every time that the sim comes back around to the buffer.
        reader.MaxTears = int.MaxValue;
        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.True(source.Step());
        Assert.Empty(faults);

        clock.Advance(TimeSpan.FromSeconds(4));
        Assert.False(source.Step());
        Assert.False(source.SimRunning);
        Assert.True(connections.Latest!.Disposed);
        Assert.IsType<TimeoutException>(Assert.Single(faults));

        // ...and the rig picks straight back up once it can read cleanly again.
        reader.MaxTears = 0;
        AttachMidStint(sim, source);
        Assert.True(source.SimRunning);
        Assert.Equal(2, connections.Opened.Count);
    }

    [Fact]
    public void ATornReadIsRetriedAndAMappingThatStaysBadIsDropped()
    {
        var (sim, connections, source, laps, faults) = NewSource();
        source.Step();
        sim.Corrupt(true);

        // The sim swapping buffers under a read is a race, not a fault.
        Assert.True(source.Step());
        Assert.True(source.Step());
        Assert.Empty(faults);
        Assert.False(connections.Latest!.Disposed);

        // A mapping that keeps failing to describe itself is not parsed around.
        Assert.False(source.Step());
        Assert.True(connections.Latest!.Disposed);
        Assert.Single(faults);
        Assert.IsType<MalformedTelemetryException>(faults[0]);
        Assert.False(source.SimRunning);

        // ...and once it reads cleanly again the agent picks straight back up.
        sim.Corrupt(false);
        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);
        Assert.Single(laps);
        Assert.Equal(2, connections.Opened.Count);
    }

    [Fact]
    public void ATornReadThatClearsIsNotHeldAgainstTheNextOne()
    {
        var (sim, connections, source, _, faults) = NewSource();
        source.Step();

        for (var round = 0; round < 4; round++)
        {
            sim.Corrupt(true);
            source.Step();
            source.Step();
            sim.Corrupt(false).NextFrame();
            source.Step();
        }

        Assert.Empty(faults);
        Assert.Single(connections.Opened);
    }

    [Fact]
    public void SwitchingCarWithoutLeavingTheSeatNeverLabelsALapWithTheOldOne()
    {
        var (sim, _, source, laps, _) = NewSource();
        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);
        Assert.Equal("Porsche 911 GT3 R", Assert.Single(laps).CarName);

        // Back to the garage, into a different car, out again.
        sim.SetSessionInfo(FakeSim.MonzaInAFerrari);
        Cross(sim, source, 1, 0f);              // the sim is running something else now
        Cross(sim, source, 2, 106.9f);          // the lap nobody watched the start of
        Cross(sim, source, 3, 105.2f);          // ...and the one it takes to get watching
        Cross(sim, source, 4, 104.8f);

        Assert.Equal(2, laps.Count);
        Assert.Equal("Autodromo Nazionale Monza", laps[1].TrackName);
        Assert.Equal("Ferrari 296 GT3", laps[1].CarName);
        Assert.Equal(104_800, laps[1].LapTimeMs);
    }

    [Fact]
    public void MetadataTheSimHasNotAnnouncedAChangeToIsNotReReadEveryFrame()
    {
        var (sim, _, source, laps, _) = NewSource();
        source.Step();

        // Same revision number, different bytes: the sim never does this, and re-reading
        // a payload that can run to hundreds of kilobytes at 60 Hz is the cost of
        // pretending it might.
        sim.SetSessionInfo(FakeSim.MonzaInAFerrari, announceChange: false);
        Cross(sim, source, 4, 138.4f);
        Cross(sim, source, 5, 137.9f);

        Assert.Equal("Porsche 911 GT3 R", Assert.Single(laps).CarName);
    }

    /// <summary>
    /// The sim writes its session document straight into the mapping, so the agent can
    /// read one half-written - and the second half arrives under the same revision
    /// number, because as far as the sim is concerned it published once. Giving up after
    /// the first look would label every lap of that stint unknown and keep none of them.
    /// </summary>
    [Fact]
    public void ReadsTheMetadataAgainWhenTheFirstLookCaughtItHalfWritten()
    {
        var (sim, _, source, laps, _) = NewSource();
        source.Step();

        // A new document announced at its finished length, caught with everything from
        // the driver list on not yet written.
        var document = FakeSim.MonzaInAFerrari;
        sim.BeginSessionInfo(document, written: document.IndexOf("DriverInfo:", StringComparison.Ordinal));
        Cross(sim, source, 4, 138.4f);

        // The rest of it lands, under the revision the sim already announced.
        sim.SetSessionInfo(document, announceChange: false);
        for (var lap = 5; lap <= 8; lap++) Cross(sim, source, lap, 137.9f + lap * 0.1f);

        Assert.Equal("Ferrari 296 GT3", Assert.Single(laps).CarName);
        Assert.Equal("Autodromo Nazionale Monza", laps[0].TrackName);
    }

    [Fact]
    public void MetadataThatCannotBeReadHoldsLapsBackRatherThanMislabellingThem()
    {
        var (sim, _, source, laps, _) = NewSource(out var rejections);
        source.Step();

        // The driver list is missing, so which car out there is the customer's cannot
        // be told - and a lap labelled with somebody else's car is worse than no lap.
        sim.SetSessionInfo("WeekendInfo:\n TrackDisplayName: Circuit de Spa-Francorchamps\n");
        for (var lap = 4; lap <= 7; lap++) Cross(sim, source, lap, 137.9f + lap * 0.1f);

        Assert.Empty(laps);
        Assert.Contains(rejections, r => r.Outcome == LapOutcome.UnknownCombo);

        // The sim republishes it complete, and laps count again.
        sim.SetSessionInfo(FakeSim.SpaInAPorsche);
        for (var lap = 8; lap <= 11; lap++) Cross(sim, source, lap, 137.5f + lap * 0.1f);
        Assert.Equal("Porsche 911 GT3 R", laps[0].CarName);
    }

    [Fact]
    public void ALapTheVenueDropsIsReportedWithItsReason()
    {
        var (sim, _, source, laps, _) = NewSource(out var rejections);
        AttachMidStint(sim, source);

        sim.OnPitRoad(true).NextFrame();
        source.Step();
        sim.OnPitRoad(false);
        Cross(sim, source, 5, 165.2f);

        Assert.Empty(laps);
        var rejection = Assert.Single(rejections, r => r.Outcome == LapOutcome.PitLap);
        Assert.Equal(5, rejection.LapNumber);
    }

    [Fact]
    public void ASubscriberThatThrowsCostsNothingButItsOwnLap()
    {
        var (sim, connections, source, _, faults) = NewSource();
        var delivered = new List<LapCompleted>();
        source.LapCompleted += _ => throw new InvalidOperationException("the rig display fell over");
        source.LapCompleted += delivered.Add;      // ...the queue that actually submits the lap

        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);
        Cross(sim, source, 6, 137.5f);

        // The connection is intact and the following lap is still detected, rather
        // than a broken listener costing the driver the rest of their stint.
        Assert.Equal(2, faults.Count);
        Assert.False(connections.Latest!.Disposed);
        Assert.Equal(2, delivered.Count);
    }

    [Fact]
    public void AFailureToAttachIsAbsorbedAndRetried()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim) { FailWith = () => new UnauthorizedAccessException("denied") };
        using var source = new IRacingTelemetrySource(7, connections, () => At, "test");
        var faults = new List<Exception>();
        source.Faulted += faults.Add;
        var laps = new List<LapCompleted>();
        source.LapCompleted += laps.Add;

        Assert.Throws<UnauthorizedAccessException>(() => source.Step());

        connections.FailWith = null;
        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);

        Assert.Single(laps);
    }

    [Fact]
    public void ASimThatDiesWithItsLastFrameStillInMemoryIsNotReportedAsRunning()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        var clock = new TestClock(At);
        using var source = new IRacingTelemetrySource(7, connections, clock.Read, "test");
        var faults = new List<Exception>();
        source.Faulted += faults.Add;

        AttachMidStint(sim, source);
        Cross(sim, source, 5, 137.9f);
        Assert.True(source.SimRunning);

        // iRacing dies. Nothing about the mapping says so: the bytes are still there,
        // still readable, and still claiming a live session - they simply stop moving.
        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.True(source.Step());
        Assert.True(source.SimRunning);

        clock.Advance(TimeSpan.FromSeconds(4));
        Assert.False(source.Step());
        Assert.False(source.SimRunning);
        Assert.True(connections.Latest!.Disposed);
        Assert.IsType<TimeoutException>(Assert.Single(faults));

        // The rig is left able to pick up whatever starts next, rather than watching a
        // region of memory nothing writes to any more.
        sim.NextFrame();
        Assert.True(source.Step());
        Assert.Equal(2, connections.Opened.Count);
        Assert.True(source.SimRunning);
    }

    [Fact]
    public void ASimSittingStillOnTrackIsNotMistakenForOne()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        var clock = new TestClock(At);
        using var source = new IRacingTelemetrySource(7, connections, clock.Read, "test");

        AttachMidStint(sim, source);

        // A customer parked at the side of the track publishes frames as fast as one
        // on a hot lap - the car is not moving, the sim is.
        for (var minute = 0; minute < 10; minute++)
        {
            clock.Advance(TimeSpan.FromMinutes(1));
            sim.NextFrame();
            Assert.True(source.Step());
        }

        Assert.True(source.SimRunning);
        Assert.Single(connections.Opened);
    }

    [Fact]
    public void TheReadLoopRunsOnItsOwnThreadAndStopsCleanly()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        using var source = new IRacingTelemetrySource(7, connections, () => At, "test");

        var seen = new List<LapCompleted>();
        using var gotALap = new ManualResetEventSlim();
        source.LapCompleted += lap => { lock (seen) seen.Add(lap); gotALap.Set(); };

        // The sim keeps circulating for as long as the agent keeps reading.
        var lapNumber = 3;
        connections.OnWait = _ =>
        {
            var lap = Interlocked.Increment(ref lapNumber);
            sim.CrossTheLine(lap, 138.4f + lap * 0.1f);
            Thread.Sleep(1);
            return true;
        };

        source.Start();
        Assert.True(gotALap.Wait(TimeSpan.FromSeconds(10)), "the read loop produced no lap");
        source.Stop();

        int afterStop;
        lock (seen) afterStop = seen.Count;
        Assert.True(afterStop > 0);
        Assert.True(connections.Latest!.Disposed);
        Assert.False(source.SimRunning);

        Thread.Sleep(50);
        lock (seen) Assert.Equal(afterStop, seen.Count);
    }

    [Fact]
    public void TheReadLoopSurvivesTheSimGoingAwayAndComingBack()
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        using var source = new IRacingTelemetrySource(7, connections, () => At, "test");

        using var gotALap = new ManualResetEventSlim();
        source.LapCompleted += _ => gotALap.Set();

        var frames = 0;
        var lapNumber = 3;
        connections.OnWait = _ =>
        {
            // Two frames in, the mapping goes bad; a few frames later the sim is gone
            // entirely; then it comes back and a customer drives again.
            var frame = Interlocked.Increment(ref frames);
            sim.Corrupt(frame is >= 2 and <= 6);
            connections.SimIsRunning = frame is < 7 or > 9;
            if (frame > 9)
            {
                var lap = Interlocked.Increment(ref lapNumber);
                sim.CrossTheLine(lap, 138.4f + lap * 0.1f);
            }
            Thread.Sleep(1);
            return true;
        };

        source.Start();
        var recovered = gotALap.Wait(TimeSpan.FromSeconds(20));
        source.Stop();

        Assert.True(recovered, "the agent never recovered after the sim came back");
    }

    /// <summary>A clock a test can move, for the rules that are about elapsed time.</summary>
    private sealed class TestClock
    {
        private DateTimeOffset _now;
        internal TestClock(DateTimeOffset start) => _now = start;
        internal DateTimeOffset Read() => _now;
        internal void Advance(TimeSpan by) => _now += by;
    }

    /// <summary>Drives past the line and lets the agent read the frame that says so.</summary>
    [Fact]
    public void TheNextCustomerOnThisRigNeverInheritsTheLastOnesLapIdentities()
    {
        // The rig turns over all evening. One customer's stint ends, iRacing exits
        // back to the membersite with the shared memory, and the next customer starts
        // their own session on the same seat and the same combo - the venue's
        // featured one, so this is the common case rather than the odd one.
        //
        // A lap's id IS the backend's idempotency key, so if the second customer's
        // lap 6 arrives carrying the first customer's, it is dropped as a retry of a
        // lap already stored. Nothing anywhere reports that: the rig scores, the
        // dashboard is green, and the customer is simply not on the board.
        var (sim, connections, source, laps, _) = NewSource();

        AttachMidStint(sim, source);
        Cross(sim, source, 5, 138.4f);
        Cross(sim, source, 6, 138.1f);
        Cross(sim, source, 7, 137.9f);
        var first = laps.ToList();

        connections.SimIsRunning = false;                 // the customer leaves; iRacing exits
        source.Step();

        laps.Clear();
        connections.SimIsRunning = true;                  // the next customer starts a session
        sim.CrossTheLine(0, -1f);                         // a fresh session counts from zero
        source.Step();                                    // ...which is where the agent attaches
        Cross(sim, source, 1, -1f);                       // out lap
        Cross(sim, source, 5, 104.2f);
        Cross(sim, source, 6, 103.8f);
        Cross(sim, source, 7, 103.5f);
        var second = laps.ToList();

        Assert.Equal(3, first.Count);
        Assert.Equal(3, second.Count);
        Assert.Empty(first.Select(l => l.EventId).Intersect(second.Select(l => l.EventId)));
    }

    [Fact]
    public void AStintOnASimThatPublishesTheTimeAfterTheCounterKeepsEveryLapsOwnTime()
    {
        // The same stint as any other customer's, driven through the real shared
        // memory against a simulator that moves the lap counter first and publishes
        // the time a couple of ticks later. Reading the time at the line would put
        // each lap's number on the lap after it: four laps on the board, every one of
        // them the wrong time, and the 137.2 the customer finished on missing
        // entirely. Every rig in the building would do it, and nothing anywhere -
        // rig display, staff dashboard, leaderboard - would look wrong.
        var (sim, _, source, laps, _) = NewSource();

        source.Step();
        sim.CrossTheLineBeforePublishingTheTime(4);       // joined mid-lap: primes only
        source.Step();
        sim.PublishLapTime(141.6f);
        source.Step();

        foreach (var (lapNumber, seconds) in new[] { (5, 140.8f), (6, 139.4f), (7, 138.1f), (8, 137.2f) })
        {
            sim.CrossTheLineBeforePublishingTheTime(lapNumber);
            source.Step();
            sim.NextFrame();                              // the sim keeps running meanwhile
            source.Step();
            sim.PublishLapTime(seconds);
            source.Step();
        }

        Assert.Equal(new int?[] { 5, 6, 7, 8 }, laps.Select(l => l.LapNumber).ToArray());
        Assert.Equal(new[] { 140_800, 139_400, 138_100, 137_200 }, laps.Select(l => l.LapTimeMs).ToArray());
        Assert.Equal(4, laps.Select(l => l.EventId).Distinct().Count());
    }

    [Fact]
    public void ADriverWhoRestartsTheirSessionKeepsEveryLapOfTheSecondRun()
    {
        // "That run was scrappy, go again." Nothing detaches, nothing reconnects -
        // the sim stays attached and its lap counter goes back to zero. Driven here
        // through the real shared memory rather than a frame dictionary, because the
        // counter rollback has to survive the parser and the source's own state.
        var (sim, _, source, laps, _) = NewSource();

        AttachMidStint(sim, source);
        Cross(sim, source, 5, 139.0f);
        Cross(sim, source, 6, 138.4f);
        var firstRun = laps.ToList();

        laps.Clear();
        Cross(sim, source, 0, -1f);                       // the session restarts
        Cross(sim, source, 1, -1f);                       // out lap
        Cross(sim, source, 5, 137.2f);
        Cross(sim, source, 6, 136.9f);
        var secondRun = laps.ToList();

        Assert.Equal(2, firstRun.Count);
        Assert.Equal(2, secondRun.Count);
        Assert.Empty(firstRun.Select(l => l.EventId).Intersect(secondRun.Select(l => l.EventId)));
    }

    private static void Cross(FakeSim sim, IRacingTelemetrySource source, int lapCompleted, float seconds = 138.4f)
    {
        sim.CrossTheLine(lapCompleted, seconds);
        source.Step();
    }

    /// <summary>
    /// Gets the agent past joining a stint already under way.
    ///
    /// It attaches with the car out on the circuit, so it takes two crossings before a
    /// lap can be judged: the first ends the lap nobody watched the start of, and the
    /// lap beginning there is the first one watched throughout.
    /// </summary>
    private static void AttachMidStint(FakeSim sim, IRacingTelemetrySource source)
    {
        source.Step();
        // Its own time, like every lap: the sim publishes what the driver just drove,
        // and no two crossings in a stint carry the same number.
        Cross(sim, source, 4, 141.6f);
    }

    private static (FakeSim Sim, FakeSimConnectionFactory Connections, IRacingTelemetrySource Source,
        List<LapCompleted> Laps, List<Exception> Faults) NewSource() => NewSource(out _);

    private static (FakeSim Sim, FakeSimConnectionFactory Connections, IRacingTelemetrySource Source,
        List<LapCompleted> Laps, List<Exception> Faults) NewSource(out List<LapDetection> rejections)
    {
        var sim = new FakeSim();
        var connections = new FakeSimConnectionFactory(sim);
        var source = new IRacingTelemetrySource(rigNumber: 7, connections, () => At, instanceId: "test");
        var laps = new List<LapCompleted>();
        var faults = new List<Exception>();
        var rejected = new List<LapDetection>();
        source.LapCompleted += laps.Add;
        source.Faulted += faults.Add;
        source.LapRejected += rejected.Add;
        rejections = rejected;
        return (sim, connections, source, laps, faults);
    }
}
