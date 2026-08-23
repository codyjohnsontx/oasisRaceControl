using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The venue's edge cases, as the customer meets them: an out lap, a spin and a
/// tow, restarting the session, someone watching a replay, the agent restarting
/// while a driver is mid-stint, and a driver switching track or car without
/// leaving the seat. Every one of them is reachable here without iRacing, which is
/// the point (docs/plan.md, "Testing strategy").
/// </summary>
public sealed class LapDetectorTests
{
    private static readonly SimSessionIdentity Spa =
        new("Circuit de Spa-Francorchamps", "Grand Prix Pits", "Porsche 911 GT3 R", 341, 173);
    private static readonly SimSessionIdentity Monza =
        new("Autodromo Nazionale Monza", "Grand Prix", "Porsche 911 GT3 R", 349, 173);
    private static readonly DateTimeOffset At = new(2026, 8, 19, 19, 30, 0, TimeSpan.Zero);

    [Fact]
    public void ALapAlreadyUnderWayWhenTheAgentAttachesIsNeverKept()
    {
        var detector = NewDetector();

        // Attaching says only where the lap counter is. The car is somewhere out on
        // the circuit, and whatever it did earlier in this lap - through the pits,
        // off the road, a spin - happened before anyone was watching.
        var attached = detector.Observe(Frame(lapCompleted: 3), Spa, At);
        Assert.Equal(LapOutcome.Priming, attached.Outcome);
        Assert.False(detector.IsPrimed);

        // Crossing the line ends that lap. Its incident count is unknowable and the
        // venue's clean-lap rule cannot be applied to it, so it is discarded...
        var joinedMidLap = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138.4f), Spa, At);
        Assert.Equal(LapOutcome.Priming, joinedMidLap.Outcome);
        Assert.Null(joinedMidLap.Lap);

        // ...and the lap starting at that line is the first one watched throughout.
        Assert.True(detector.IsPrimed);
        Assert.Equal(LapOutcome.Emitted,
            detector.Observe(Frame(lapCompleted: 5, lastLapTime: 138.9f), Spa, At).Outcome);
    }

    [Fact]
    public void AWatchedLapBecomesALapTheVenueKeeps()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138.421f), Spa, At));

        Assert.Equal("Circuit de Spa-Francorchamps", lap.TrackName);
        Assert.Equal("Grand Prix Pits", lap.TrackConfig);
        Assert.Equal("Porsche 911 GT3 R", lap.CarName);
        Assert.Equal(4, lap.LapNumber);
        Assert.Equal(138_421, lap.LapTimeMs);
        Assert.Equal(0, lap.IncidentDelta);
        Assert.Equal(At, lap.CompletedAt);
    }

    [Fact]
    public void OnlyTheIncidentsPickedUpOnThisLapAreChargedToIt()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, incidents: 8), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, incidents: 12), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 140f, incidents: 12), Spa, At));

        Assert.Equal(4, lap.IncidentDelta);

        // ...and the next clean lap starts from zero again rather than inheriting them.
        var clean = Emit(detector.Observe(Frame(lapCompleted: 5, lastLapTime: 138f, incidents: 12), Spa, At));
        Assert.Equal(0, clean.IncidentDelta);
    }

    [Fact]
    public void AnIncidentTotalThatGoesBackwardsIsNeverSentAsANegativeCount()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, incidents: 9), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138f, incidents: 2), Spa, At));

        Assert.Equal(0, lap.IncidentDelta);
    }

    [Fact]
    public void GoingOffTrackIsReportedEvenWhenTheSimChargedNoIncidentForIt()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, surface: 0), Spa, At);

        var detection = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141f), Spa, At);

        Assert.Equal(LapOutcome.Emitted, detection.Outcome);
        Assert.True(detection.OffTrackSeen);
        Assert.Equal(0, detection.Lap!.IncidentDelta);

        // ...and it travels ON the lap, because that is the copy the backend sees.
        // Without it a 0x lap run wide at the fastest corner is the fastest CLEAN
        // lap of the night on a board whose whole rule is clean laps only.
        Assert.True(detection.Lap!.OffTrackSeen);
    }

    [Fact]
    public void ALapThatStayedOnTheRoadSaysSo()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138f), Spa, At));

        Assert.False(lap.OffTrackSeen);
    }

    [Fact]
    public void AnOffOnOneLapDoesNotFollowTheDriverOntoTheNext()
    {
        // The one way this rule can cost a customer a legitimate time: a flag that
        // outlives the lap it belongs to voids every lap of the rest of the stint.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, surface: 0), Spa, At);

        var wide = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141f), Spa, At));
        var clean = Emit(detector.Observe(Frame(lapCompleted: 5, lastLapTime: 138f), Spa, At));

        Assert.True(wide.OffTrackSeen);
        Assert.False(clean.OffTrackSeen);
    }

    [Fact]
    public void AnOffAnywhereInTheLapCountsNotOnlyAtTheLine()
    {
        // A two-wheel off is over long before the car reaches the line, so a rule
        // that read the surface only at the crossing would never see one.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, surface: 0), Spa, At);
        for (var i = 0; i < 200; i++) detector.Observe(Frame(lapCompleted: 3), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141f), Spa, At));

        Assert.True(lap.OffTrackSeen);
    }

    [Fact]
    public void OnlyTheCarsOwnTyresLeavingTheRoadCounts()
    {
        // PlayerTrackSurface is irsdk_TrkLoc: -1 not in world, 0 off track,
        // 1 in pit stall, 2 approaching pits, 3 on track. Reading anything that is
        // not 3 as "off" would charge an off for every trip down the pit lane.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, surface: 2), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138f), Spa, At));

        Assert.False(lap.OffTrackSeen);
    }

    [Fact]
    public void AnOutLapOrAnInLapIsNotKept()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        // Into the pits at the end of a stint...
        detector.Observe(Frame(lapCompleted: 3, onPitRoad: true), Spa, At);
        var inLap = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 190.4f, onPitRoad: true), Spa, At);
        Assert.Equal(LapOutcome.PitLap, inLap.Outcome);
        Assert.Null(inLap.Lap);

        // ...and back out for another run. The out lap starts in the box, so the pit
        // lane is behind the car well before it reaches the line again.
        detector.Observe(Frame(lapCompleted: 4, onPitRoad: true), Spa, At);
        var outLap = detector.Observe(Frame(lapCompleted: 5, lastLapTime: 272.9f), Spa, At);
        Assert.Equal(LapOutcome.PitLap, outLap.Outcome);
        Assert.Null(outLap.Lap);

        Assert.Equal(LapOutcome.Emitted,
            detector.Observe(Frame(lapCompleted: 6, lastLapTime: 139.2f), Spa, At).Outcome);
    }

    [Fact]
    public void ATowOrAResetToThePitsDiscardsTheLapItInterrupted()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, surface: -1), Spa, At);   // car removed from the world

        var interrupted = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 190f), Spa, At);
        Assert.Equal(LapOutcome.ResetDuringLap, interrupted.Outcome);

        // The lap after it was driven start to finish, so it counts.
        Assert.Equal(LapOutcome.Emitted, detector.Observe(Frame(lapCompleted: 5, lastLapTime: 139f), Spa, At).Outcome);
    }

    [Fact]
    public void TheLapCounterRunningBackwardsDiscardsTheLapInProgress()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lap: 4), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, lap: 1), Spa, At);        // session rewound under us

        var detection = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 139f, lap: 2), Spa, At);

        Assert.Equal(LapOutcome.ResetDuringLap, detection.Outcome);
    }

    [Fact]
    public void ACompletedLapCountThatDropsRebuildsTheBaselineInsteadOfEmitting()
    {
        var detector = NewDetector();
        Attach(detector, atLap: 6);
        detector.Observe(Frame(lapCompleted: 7), Spa, At);

        var detection = detector.Observe(Frame(lapCompleted: 1, lastLapTime: 139f), Spa, At);

        Assert.Equal(LapOutcome.ResetDuringLap, detection.Outcome);
        Assert.Null(detection.Lap);
        Assert.False(detector.IsPrimed);

        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 2, lastLapTime: 139f), Spa, At).Outcome);
        Assert.Equal(LapOutcome.Emitted, detector.Observe(Frame(lapCompleted: 3, lastLapTime: 140.5f), Spa, At).Outcome);
    }

    [Fact]
    public void RestartingTheSessionDoesNotProduceALapSpanningTheRestart()
    {
        var detector = NewDetector();
        Attach(detector, atLap: 4);
        detector.Observe(Frame(lapCompleted: 5, sessionUniqueId: 42), Spa, At);

        var changed = detector.Observe(Frame(lapCompleted: 0, sessionUniqueId: 43), Spa, At);
        Assert.Equal(LapOutcome.SessionChanged, changed.Outcome);
        Assert.False(detector.IsPrimed);

        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 0, sessionUniqueId: 43), Spa, At).Outcome);
        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 1, lastLapTime: 139f, sessionUniqueId: 43), Spa, At).Outcome);
        Assert.Equal(LapOutcome.Emitted, detector.Observe(Frame(lapCompleted: 2, lastLapTime: 140.5f, sessionUniqueId: 43), Spa, At).Outcome);
    }

    [Fact]
    public void ChangingTrackOrCarWithoutLeavingTheSeatStartsAgainRatherThanMislabelling()
    {
        var detector = NewDetector();
        Attach(detector, atLap: 4);
        detector.Observe(Frame(lapCompleted: 5), Spa, At);

        var changed = detector.Observe(Frame(lapCompleted: 6, lastLapTime: 139f), Monza, At);

        Assert.Equal(LapOutcome.SessionChanged, changed.Outcome);
        Assert.Null(changed.Lap);
    }

    [Fact]
    public void NothingWatchedInAReplayBecomesALap()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        var replay = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138f, isReplayPlaying: true), Spa, At);

        Assert.Equal(LapOutcome.NotDriving, replay.Outcome);
        Assert.False(detector.IsPrimed);

        // Leaving the replay does not resume mid-lap: the next crossing rebuilds the baseline.
        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 9), Spa, At).Outcome);
    }

    [Theory]
    [InlineData(true, false)]   // dropped into the garage mid-lap
    [InlineData(false, true)]   // car not in the world for part of the lap
    public void ALapTheDriverWasNotDrivingThroughoutIsNotKept(bool inGarage, bool offTrackSession)
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, isInGarage: inGarage, isOnTrack: !offTrackSession), Spa, At);

        var detection = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 139f), Spa, At);

        Assert.Equal(LapOutcome.NotDriving, detection.Outcome);
    }

    [Theory]
    [InlineData(-1f)]           // the sim's "no time" value
    [InlineData(0f)]
    [InlineData(float.NaN)]
    public void ACrossingWithNoUsableTimeIsNotKept(float lastLapTime)
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        // -1 is also what the channel holds when the sim has simply not published this
        // lap's time YET, so the two are indistinguishable at the line and the lap is
        // given the settle window before it is given up on.
        Assert.Equal(LapOutcome.NoLapTime,
            SettledOutcome(detector, Frame(lapCompleted: 4, lastLapTime: lastLapTime)));
    }

    [Theory]
    [InlineData(2f)]            // shorter than any real lap
    [InlineData(7_200f)]        // longer than any session
    public void ATimeNoRealLapCouldHaveIsNotKept(float lastLapTime)
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        Assert.Equal(LapOutcome.ImplausibleTime, detector.Observe(Frame(lapCompleted: 4, lastLapTime: lastLapTime), Spa, At).Outcome);
    }

    [Fact]
    public void ALapCounterThatCannotBeRealNeverBecomesALap()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        // Corrupt bytes that still fit the mapping's shape reach the rules as values.
        // The backend rejects a negative lap number for the whole batch it arrives in,
        // and the agent resubmits that batch until somebody clears it by hand.
        var nonsense = detector.Observe(Frame(lapCompleted: -2, lastLapTime: 139f), Spa, At);
        Assert.Equal(LapOutcome.ImplausibleLapNumber, nonsense.Outcome);
        Assert.Null(nonsense.Lap);
        Assert.False(detector.IsPrimed);

        // The counter making sense again does not retroactively make that lap real.
        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 4), Spa, At).Outcome);
        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 5, lastLapTime: 139f), Spa, At).Outcome);
        Assert.Equal(LapOutcome.Emitted, detector.Observe(Frame(lapCompleted: 6, lastLapTime: 140.5f), Spa, At).Outcome);
    }

    // ------------------------------------------------------------------
    // The sim publishes the lap counter and the lap time as two separate channels,
    // and nothing says which of them moves first. iRacing's own reference describes
    // LapLastLapTime as "Players last lap time" and says nothing about when it lands
    // relative to the line; docs/spike-findings.md still carries it as an open
    // question, and no venue session has answered it. These drive the answer this
    // agent was NOT originally written for: the counter first, the time a few of the
    // sim's 60 Hz ticks later.
    // ------------------------------------------------------------------

    [Fact]
    public void ALapGetsItsOwnTimeAndNotTheLastOnesWhenTheSimPublishesTheCounterFirst()
    {
        // Lap 3 took 141.6. The driver crosses to end lap 4 and the counter moves,
        // but the time channel is still showing 141.6 because the sim has not got to
        // it yet. Taking that number is a lap on the board the driver never drove.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f), Spa, At);

        var atTheLine = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f), Spa, At);
        Assert.Null(atTheLine.Lap);

        // A tick later the sim says what lap 4 actually took.
        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138.421f), Spa, At.AddMilliseconds(17)));

        Assert.Equal(138_421, lap.LapTimeMs);
        Assert.Equal(4, lap.LapNumber);

        // Stamped when the driver crossed, not when the sim got round to it: which
        // check-in owns the lap and which night it counts for are both read off this.
        Assert.Equal(At, lap.CompletedAt);
    }

    [Fact]
    public void ADriversFastestLapIsNotTheOneMissingFromTheBoard()
    {
        // A stint on a sim that publishes the time late, driven the way customers
        // drive: each lap quicker than the last. Reading the time at the line would
        // shift every lap onto the one before it, so the board would show four laps,
        // all of them a second slow, and the 137.2 the customer is telling their
        // friends about would not be there at all.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: -1f), Spa, At);

        var times = new[] { 140.8f, 139.4f, 138.1f, 137.2f };
        var laps = new List<LapCompleted>();
        for (var i = 0; i < times.Length; i++)
        {
            var lapNumber = 4 + i;
            var standing = i == 0 ? -1f : times[i - 1];
            var crossedAt = At.AddSeconds(i * 140);

            Assert.Null(detector.Observe(Frame(lapCompleted: lapNumber, lastLapTime: standing), Spa, crossedAt).Lap);
            laps.Add(Emit(detector.Observe(
                Frame(lapCompleted: lapNumber, lastLapTime: times[i]), Spa, crossedAt.AddMilliseconds(33))));
        }

        Assert.Equal(new int?[] { 4, 5, 6, 7 }, laps.Select(l => l.LapNumber).ToArray());
        Assert.Equal(new[] { 140_800, 139_400, 138_100, 137_200 }, laps.Select(l => l.LapTimeMs).ToArray());
        Assert.Equal(137_200, laps.Min(l => l.LapTimeMs));
        Assert.Equal(4, laps.Select(l => l.EventId).Distinct().Count());
    }

    [Fact]
    public void ALapPublishedWithItsCounterIsKeptAtTheLineWithoutWaitingForAnything()
    {
        // The other answer to the same question. If the sim does publish both together
        // - which is what this agent was originally written for - nothing is held and
        // nothing is delayed.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138.421f), Spa, At));

        Assert.Equal(138_421, lap.LapTimeMs);
    }

    [Fact]
    public void ALapWhoseTimeNeverArrivesIsGivenUpOnRatherThanSentWithTheLastOnes()
    {
        // A time the sim never publishes is what a timing reset looks like from here.
        // The venue would rather be one lap short than carry a lap whose number came
        // off the lap before it.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f), Spa, At);

        Assert.Null(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f), Spa, At).Lap);

        var stillNothing = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f), Spa, At.AddSeconds(1));
        Assert.Equal(LapOutcome.None, stillNothing.Outcome);

        var givenUp = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f), Spa, At.AddSeconds(3));
        Assert.Equal(LapOutcome.NoLapTime, givenUp.Outcome);
        Assert.Null(givenUp.Lap);
        Assert.Equal(4, givenUp.LapNumber);
    }

    [Fact]
    public void ALapStillWaitingForItsTimeIsNeverSettledByTheNextLapsTime()
    {
        // The pathological ordering: the counter reaches lap 5 while lap 4 is still
        // waiting. Whatever the time channel says now belongs to one of them, and
        // handing it to both would put a lap on the board twice under two identities.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f), Spa, At);

        Assert.Null(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f), Spa, At).Lap);
        Assert.Null(detector.Observe(Frame(lapCompleted: 5, lastLapTime: 141.6f), Spa, At.AddSeconds(1)).Lap);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 5, lastLapTime: 138.2f), Spa, At.AddSeconds(1.1)));

        Assert.Equal(5, lap.LapNumber);
        Assert.Equal(138_200, lap.LapTimeMs);
    }

    [Fact]
    public void ALapWaitingForItsTimeIsDroppedWhenTheSimGoesAwayUnderIt()
    {
        // Losing the sim means the next thing this detector sees is a different
        // session, or the same one rejoined mid-lap. Either way nothing arriving after
        // it is evidence about the lap that was waiting.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f), Spa, At);
        Assert.Null(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f), Spa, At).Lap);

        detector.Reset();

        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 4, lastLapTime: 138.4f), Spa, At).Outcome);
        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 5, lastLapTime: 138.4f), Spa, At).Outcome);
    }

    [Fact]
    public void AWaitedForLapIsJudgedOnTheLapItselfAndNotOnTheWait()
    {
        // Everything that decides whether a lap counts is accumulated between two
        // lines and cleared at the second one, so it has to be read AT the line even
        // though the time arrives later. The off-track here belongs to lap 4; the
        // incident picked up while the sim was still publishing lap 4's time was
        // taken on lap 5 and must be charged there.
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f, incidents: 2), Spa, At);
        detector.Observe(Frame(lapCompleted: 3, lastLapTime: 141.6f, incidents: 2, surface: 0), Spa, At);

        Assert.Null(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 141.6f, incidents: 3), Spa, At).Lap);

        var settled = detector.Observe(
            Frame(lapCompleted: 4, lastLapTime: 138.4f, incidents: 7), Spa, At.AddMilliseconds(50));
        var lap = Emit(settled);

        Assert.True(lap.OffTrackSeen);
        Assert.True(settled.OffTrackSeen);
        Assert.Equal(1, lap.IncidentDelta);
    }

    [Fact]
    public void EveryLapItKeepsSatisfiesTheContractTheBackendValidates()
    {
        var lap = Emit(DriveOneLap(NewDetector()));

        // A single event the backend refuses fails the whole batch it rides in, and the
        // agent retries that batch for ever - so the rules never build one
        // (apps/web/src/lib/events.ts).
        AssertBackendAcceptsEventId(lap.EventId);
        Assert.InRange(lap.TrackName.Length, 1, 120);
        Assert.InRange(lap.CarName.Length, 1, 120);
        Assert.True(lap.TrackConfig is null || lap.TrackConfig.Length is >= 1 and <= 120);
        Assert.True(lap.LapTimeMs > 0);
        Assert.True(lap.LapNumber is null or >= 0);
        Assert.True(lap.IncidentDelta is null or >= 0);
    }

    [Fact]
    public void ALapIsHeldBackRatherThanSentWithoutATrackAndCar()
    {
        var detector = NewDetector();
        Attach(detector, atLap: 2, identity: null);
        detector.Observe(Frame(lapCompleted: 3), identity: null, At);

        var detection = detector.Observe(Frame(lapCompleted: 4, lastLapTime: 139f), identity: null, At);

        Assert.Equal(LapOutcome.UnknownCombo, detection.Outcome);
        Assert.Null(detection.Lap);
    }

    [Fact]
    public void MissedFramesStillProduceExactlyTheLapThatWasJustCompleted()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        var lap = Emit(detector.Observe(Frame(lapCompleted: 6, lastLapTime: 139.5f), Spa, At));

        Assert.Equal(6, lap.LapNumber);
        Assert.Equal(139_500, lap.LapTimeMs);
    }

    [Fact]
    public void TheSimClosingAndReopeningRebuildsTheBaseline()
    {
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);

        detector.Reset();

        Assert.False(detector.IsPrimed);
        Assert.Equal(LapOutcome.Priming, detector.Observe(Frame(lapCompleted: 4), Spa, At).Outcome);
    }

    [Fact]
    public void TwoCustomersOnOneRigNeverShareALapIdentity()
    {
        // The rig turns over: one customer's stint ends, the sim goes away with them,
        // and the next customer starts a fresh session on the same seat. Whether
        // iRacing hands the second session the numbering it gave the first has never
        // been established (docs/spike-findings.md), so this drives the case where it
        // does - the second customer's laps must still be their own.
        var first = NewDetector(instanceId: "one-run");
        var firstStint = DriveThreeLaps(first);

        var second = NewDetector(instanceId: "another-run");
        var secondStint = DriveThreeLaps(second);

        Assert.Equal(3, firstStint.Count);
        Assert.Equal(3, secondStint.Count);
        Assert.Empty(firstStint.Select(l => l.EventId).Intersect(secondStint.Select(l => l.EventId)));
    }

    [Fact]
    public void ADriverRestartingTheirSessionDoesNotSpendTheSameLapIdentitiesTwice()
    {
        // Nothing detaches here: the sim stays up and the lap counter simply returns
        // to a number it has already been through, which is what "that run was
        // scrappy, go again" looks like from inside the telemetry. Every lap of the
        // second run would otherwise carry an identity the first run already used,
        // and the backend drops those as retries of laps it already has.
        var detector = NewDetector();
        var before = DriveThreeLaps(detector);

        var after = new List<LapCompleted>();
        detector.Observe(Frame(lapCompleted: 0), Spa, At);             // the session restarts
        detector.Observe(Frame(lapCompleted: 1, lastLapTime: -1f), Spa, At);
        for (var lap = 2; lap <= 4; lap++)
            after.Add(Emit(detector.Observe(Frame(lapCompleted: lap, lastLapTime: 137f - lap * 0.25f), Spa, At)));

        Assert.Equal(3, after.Count);
        Assert.Empty(before.Select(l => l.EventId).Intersect(after.Select(l => l.EventId)));
    }

    [Fact]
    public void EveryLapOfOneStintIsStampedWithTheSameRunSoALogReadsAsAStint()
    {
        // The run token is the part of a lap's id that keeps two customers apart, so
        // it has to name a run rather than a lap: all of one stint's laps carry it,
        // and it is what groups a customer's laps in a log or a database when
        // something has to be reconstructed after the fact.
        var detector = NewDetector();
        var stint = DriveThreeLaps(detector);

        var tokens = stint.Select(l => RunToken(l.EventId)).Distinct().ToList();
        Assert.Single(tokens);

        detector.Observe(Frame(lapCompleted: 0), Spa, At);             // the session restarts
        detector.Observe(Frame(lapCompleted: 1, lastLapTime: -1f), Spa, At);
        var next = Emit(detector.Observe(Frame(lapCompleted: 2, lastLapTime: 137f), Spa, At));

        Assert.NotEqual(tokens[0], RunToken(next.EventId));
    }

    [Fact]
    public void TwoAgentRunsStartedInTheSameInstantAreStillToldApart()
    {
        // Nothing pins the instance id here, so this is the id a rig actually runs
        // with. A millisecond clock is the obvious way to name an agent run and it is
        // not a uniqueness argument - the machines this ships to are the ones whose
        // clocks are known to be wrong (ServerClock), and a clock that steps back
        // hands the next run a name that has already been used.
        var ids = Enumerable.Range(0, 200)
            .Select(_ => Emit(DriveOneLap(new LapDetector(rigNumber: 7))).EventId)
            .ToList();

        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    [Fact]
    public void ALapTheAgentDidNotWatchFromItsStartIsNeverEmittedAfterARestart()
    {
        // What used to be argued from the identity: a restart cannot double-count.
        // It cannot, but not because the id repeats - the detector re-primes, so the
        // lap that was under way when the agent stopped is never emitted at all. A
        // lap that was already queued keeps the id it was minted with, which is what
        // makes a resubmission a duplicate (EventQueue).
        var detector = NewDetector();
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        var watched = Emit(detector.Observe(Frame(lapCompleted: 4, lastLapTime: 139f), Spa, At));

        // The agent stops mid-lap-4 and comes back with the counter still at 3.
        var afterRestart = NewDetector(instanceId: "after-restart");
        Attach(afterRestart, atLap: 3);
        var replayed = afterRestart.Observe(Frame(lapCompleted: 4, lastLapTime: 139f), Spa, At);

        Assert.Equal(LapOutcome.Priming, replayed.Outcome);
        Assert.Null(replayed.Lap);
        Assert.Equal(4, watched.LapNumber);
    }

    [Fact]
    public void TwoRigsOnTheSameComboNeverProduceTheSameLapIdentity()
    {
        var rig1 = Emit(DriveOneLap(new LapDetector(rigNumber: 1, instanceId: "x")));
        var rig12 = Emit(DriveOneLap(new LapDetector(rigNumber: 12, instanceId: "x")));

        Assert.NotEqual(rig1.EventId, rig12.EventId);
    }

    [Fact]
    public void ASessionTheSimGaveNoIdentityToStillProducesUsableLapIdentities()
    {
        var detector = NewDetector();
        var first = WithoutChannels(Frame(lapCompleted: 3), "SessionUniqueID");
        var second = WithoutChannels(Frame(lapCompleted: 4, lastLapTime: 139f), "SessionUniqueID");

        detector.Observe(WithoutChannels(Frame(lapCompleted: 2), "SessionUniqueID"), Spa, At);
        detector.Observe(first, Spa, At);
        var lap = Emit(detector.Observe(second, Spa, At));

        AssertBackendAcceptsEventId(lap.EventId);
    }

    [Fact]
    public void EveryLapIdentityIsShapedTheWayTheBackendRequires()
    {
        AssertBackendAcceptsEventId(Emit(DriveOneLap(NewDetector())).EventId);
        AssertBackendAcceptsEventId(Emit(DriveOneLap(new LapDetector(rigNumber: 25))).EventId);
    }

    [Fact]
    public void ALongAgentRunNameCannotPushTheRunTokenOffTheEndOfTheIdentity()
    {
        // The identity is trimmed to the length the backend accepts, and the run
        // token - the only part keeping two customers apart - sits at the end. So the
        // name of the agent run is bounded where it enters, not where it is printed.
        var detector = new LapDetector(rigNumber: 999, instanceId: new string('a', 400));
        var first = Emit(DriveOneLap(detector));

        AssertBackendAcceptsEventId(first.EventId);
        Assert.EndsWith("x1", first.EventId);

        detector.Observe(Frame(lapCompleted: 0), Spa, At);
        detector.Observe(Frame(lapCompleted: 1, lastLapTime: -1f), Spa, At);
        var afterRestart = Emit(detector.Observe(Frame(lapCompleted: 2, lastLapTime: 137f), Spa, At));

        Assert.NotEqual(first.EventId, afterRestart.EventId);
    }

    [Fact]
    public void AMissingLapChannelIsIgnoredRatherThanTreatedAsALap()
    {
        var detector = NewDetector();

        var detection = detector.Observe(WithoutChannels(Frame(lapCompleted: 3), "LapCompleted"), Spa, At);

        Assert.Equal(LapOutcome.None, detection.Outcome);
        Assert.False(detector.IsPrimed);
    }

    [Fact]
    public void AFullStintProducesOneLapPerCleanLapAndNothingElse()
    {
        var detector = NewDetector();
        var kept = new List<LapCompleted>();

        void Frames(params Dictionary<string, object?>[] frames)
        {
            foreach (var frame in frames)
            {
                var detection = detector.Observe(frame, Spa, At);
                if (detection.Lap is { } lap) kept.Add(lap);
            }
        }

        Frames(
            Frame(lapCompleted: 0, onPitRoad: true),                          // sitting in the box
            Frame(lapCompleted: 1, lastLapTime: -1f, onPitRoad: true),        // out lap
            Frame(lapCompleted: 2, lastLapTime: 139.201f),                    // first flying lap
            Frame(lapCompleted: 2, surface: 0),                               // a wheel off
            Frame(lapCompleted: 3, lastLapTime: 141.880f, incidents: 1),      // ...charged an incident
            Frame(lapCompleted: 4, lastLapTime: 138.902f, incidents: 1),      // personal best
            Frame(lapCompleted: 4, onPitRoad: true),                          // in lap
            Frame(lapCompleted: 5, lastLapTime: 190.4f, onPitRoad: true));

        Assert.Equal(3, kept.Count);
        Assert.Equal([2, 3, 4], kept.Select(lap => lap.LapNumber).ToArray());
        Assert.Equal([139_201, 141_880, 138_902], kept.Select(lap => lap.LapTimeMs).ToArray());
        Assert.Equal([0, 1, 0], kept.Select(lap => lap.IncidentDelta).ToArray());
        Assert.Equal(kept.Select(lap => lap.EventId).Distinct().Count(), kept.Count);
    }

    private static LapDetector NewDetector(string? instanceId = "test") => new(rigNumber: 7, instanceId);

    /// <summary>
    /// Gets past joining a session partway through, so a test can go straight to the
    /// case it is about.
    ///
    /// The agent attaches with the car already out on the circuit; the lap it is on
    /// can never be judged. This feeds the frame that notes where the counter is,
    /// leaving the test's own next frame as the crossing that starts the first
    /// watchable lap.
    /// </summary>
    private static void Attach(LapDetector detector, int atLap = 2) => Attach(detector, atLap, Spa);

    private static void Attach(LapDetector detector, int atLap, SimSessionIdentity? identity)
    {
        var detection = detector.Observe(Frame(lapCompleted: atLap), identity, At);
        Assert.Equal(LapOutcome.Priming, detection.Outcome);
        Assert.False(detector.IsPrimed);
    }

    /// <summary>A customer's stint: attach, get past the lap already under way, then
    /// three laps watched from line to line.</summary>
    private static List<LapCompleted> DriveThreeLaps(LapDetector detector)
    {
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        var laps = new List<LapCompleted>();
        // Each lap its own time, because that is what a driver produces and what the
        // sim publishes; two laps to the same ten-millionth of a second is not a
        // stint, it is a detail the fixture would be inventing.
        for (var lap = 4; lap <= 6; lap++)
            laps.Add(Emit(detector.Observe(Frame(lapCompleted: lap, lastLapTime: 139f - lap * 0.25f), Spa, At)));
        return laps;
    }

    private static LapDetection DriveOneLap(LapDetector detector)
    {
        Attach(detector);
        detector.Observe(Frame(lapCompleted: 3), Spa, At);
        return detector.Observe(Frame(lapCompleted: 4, lastLapTime: 139f), Spa, At);
    }

    /// <summary>The part of a lap's id that names the run of lap numbers it belongs to.</summary>
    private static string RunToken(string eventId)
    {
        var marker = eventId.LastIndexOf("-t", StringComparison.Ordinal);
        Assert.True(marker > 0, $"no run token in {eventId}");
        return eventId[(marker + 2)..];
    }

    /// <summary>
    /// Drives one crossing and returns the verdict that resolved it: the crossing's own
    /// if the sim published the time with the counter, otherwise the one that lands
    /// once the settle window closes. Asserts no lap was kept along the way, because
    /// "not kept" is what every caller of this is claiming.
    /// </summary>
    private static LapOutcome SettledOutcome(LapDetector detector, Dictionary<string, object?> crossing)
    {
        var detection = detector.Observe(crossing, Spa, At);
        Assert.Null(detection.Lap);
        if (detection.Outcome != LapOutcome.None) return detection.Outcome;

        // Same frame, republished - the sim holds its last frame between ticks, and a
        // lap waiting for a time it never gets sees exactly this.
        detection = detector.Observe(crossing, Spa, At.AddSeconds(5));
        Assert.Null(detection.Lap);
        return detection.Outcome;
    }

    private static LapCompleted Emit(LapDetection detection)
    {
        Assert.Equal(LapOutcome.Emitted, detection.Outcome);
        return detection.Lap!;
    }

    /// <summary>The backend rejects an event id outside this shape, and a rejected lap
    /// is a lap the driver never sees (apps/web/src/lib/events.ts).</summary>
    private static void AssertBackendAcceptsEventId(string eventId)
    {
        Assert.InRange(eventId.Length, 8, 128);
        Assert.All(eventId, character => Assert.True(char.IsAsciiLetterOrDigit(character) || character == '-'));
    }

    private static Dictionary<string, object?> Frame(
        int lapCompleted,
        float lastLapTime = -1f,
        int? lap = null,
        int incidents = 0,
        bool onPitRoad = false,
        int surface = 3,
        bool isOnTrack = true,
        bool isInGarage = false,
        bool isReplayPlaying = false,
        int sessionUniqueId = 42,
        int sessionNum = 0) => new(StringComparer.Ordinal)
        {
            ["LapCompleted"] = lapCompleted,
            ["LapLastLapTime"] = lastLapTime,
            ["Lap"] = lap ?? lapCompleted + 1,
            ["PlayerCarMyIncidentCount"] = incidents,
            ["OnPitRoad"] = onPitRoad,
            ["PlayerTrackSurface"] = surface,
            ["IsOnTrack"] = isOnTrack,
            ["IsInGarage"] = isInGarage,
            ["IsReplayPlaying"] = isReplayPlaying,
            ["SessionNum"] = sessionNum,
            ["SessionUniqueID"] = sessionUniqueId,
        };

    /// <summary>The sim on a given rig may simply not publish a channel; the parser
    /// reports those as absent.</summary>
    private static Dictionary<string, object?> WithoutChannels(Dictionary<string, object?> frame, params string[] names)
    {
        foreach (var name in names) frame[name] = null;
        return frame;
    }
}
