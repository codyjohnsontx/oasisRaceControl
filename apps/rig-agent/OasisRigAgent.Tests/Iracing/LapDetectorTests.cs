using Xunit;
using OasisRigAgent.Core;
using OasisRigAgent.Core.Iracing;

namespace OasisRigAgent.Tests.Iracing;

/// <summary>
/// Each test feeds the detector a hand-built sequence of ticks for one of the
/// traps named on <see cref="LapDetector"/>. Lap detection is verified against
/// real iRacing on the owner's rig with the diagnostic mode (2026-09-26, test
/// drive, FIA F4 at COTA Grand Prix), and the resync tests replay that log; the
/// other sequences encode what the iRacing SDK documents and what other readers
/// of it rely on.
/// </summary>
public sealed class LapDetectorTests
{
    private static readonly SessionCombo Cota = new("Circuit of the Americas", "Grand Prix", "FIA F4", 0, "cota gp", 218, 137);
    private static readonly DateTimeOffset At = new(2026, 9, 27, 15, 0, 0, TimeSpan.Zero);

    private readonly LapDetector _detector = new(() => At, "rig1") { Combo = Cota };
    private readonly List<LapDecision> _decisions = new();

    public LapDetectorTests() => _detector.Decided += _decisions.Add;

    private static TelemetryTick Tick(int lapCompleted, float lastLapTime, int incidents = 0, bool pit = false,
        bool onTrack = true, int lap = -1, int surface = 3, int reset = 0, bool replay = false,
        int sessionNum = 0, int sessionUnique = 1, int carIdx = 0) => new()
        {
            LapCompleted = lapCompleted,
            LapLastLapTime = lastLapTime,
            Lap = lap < 0 ? lapCompleted + 1 : lap,
            OnPitRoad = pit,
            IsOnTrack = onTrack,
            IsReplayPlaying = replay,
            PlayerTrackSurface = surface,
            EnterExitReset = reset,
            PlayerCarMyIncidentCount = incidents,
            SessionNum = sessionNum,
            SessionUniqueId = sessionUnique,
            PlayerCarIdx = carIdx,
        };

    private void Drive(params TelemetryTick[] ticks)
    {
        foreach (var t in ticks) _detector.Observe(t);
    }

    private void Cruise(TelemetryTick t, int ticks)
    {
        for (var i = 0; i < ticks; i++) _detector.Observe(t);
    }

    [Fact]
    public void ACleanLapIsPostedWithTheComboStringsAndTheSimsTime()
    {
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(2, 152.340f));

        var d = Assert.Single(_decisions);
        Assert.Equal(2, d.LapCompleted);
        Assert.Null(d.SkipReason);
        var lap = d.Lap!;
        Assert.Equal("Circuit of the Americas", lap.TrackName);
        Assert.Equal("Grand Prix", lap.TrackConfig);
        Assert.Equal("FIA F4", lap.CarName);
        Assert.Equal(152340, lap.LapTimeMs);
        Assert.Equal(2, lap.LapNumber);
        Assert.Equal(0, lap.IncidentDelta);
        Assert.Equal(At, lap.CompletedAt);
        Assert.StartsWith("ir-rig1-", lap.EventId);
    }

    [Fact]
    public void WaitsForTheLapTimeChannelToCatchUpWithTheCounter()
    {
        Cruise(Tick(1, 155.0f), 10);
        // iRacing bumps LapCompleted first; LapLastLapTime still shows the old lap for a few ticks.
        Cruise(Tick(2, 155.0f), 5);
        Assert.Empty(_decisions);
        Drive(Tick(2, 151.9f));
        Assert.Equal(151900, Assert.Single(_decisions).Lap!.LapTimeMs);
    }

    [Fact]
    public void AnIdenticalLapTimeIsTrustedOnceTheDeadlinePasses()
    {
        Cruise(Tick(1, 152.0f), 10);
        Cruise(Tick(2, 152.0f), LapDetector.LapTimeDeadlineTicks + 1);
        Assert.Equal(152000, Assert.Single(_decisions).Lap!.LapTimeMs);
    }

    [Fact]
    public void FirstObservationIsABaselineNotALap()
    {
        Cruise(Tick(4, 150.0f), 50);
        Assert.Empty(_decisions);
    }

    [Fact]
    public void OutLapWithNoTimeIsSkipped()
    {
        Cruise(Tick(0, -1f), 10);
        Cruise(Tick(1, -1f), LapDetector.LapTimeDeadlineTicks + 1);
        var d = Assert.Single(_decisions);
        Assert.Null(d.Lap);
        Assert.Contains("no lap time", d.SkipReason);
    }

    [Fact]
    public void ALapThroughThePitLaneIsSkippedAndTheNextOneCounts()
    {
        Cruise(Tick(1, 155.0f), 10);
        Cruise(Tick(1, 155.0f, pit: true), 10);   // pit stop mid-lap
        Cruise(Tick(1, 155.0f), 10);              // back out on track
        Drive(Tick(2, 210.0f));                   // in-lap/out-lap time
        Cruise(Tick(2, 210.0f), 10);
        Drive(Tick(3, 152.0f));

        Assert.Equal(2, _decisions.Count);
        Assert.Contains("pit lane", _decisions[0].SkipReason);
        Assert.Equal(152000, _decisions[1].Lap!.LapTimeMs);
    }

    [Fact]
    public void ResetToPitsMarksTheLapIncomplete()
    {
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(1, 155.0f, reset: 1));         // EnterExitReset changed
        Cruise(Tick(1, 155.0f, reset: 1), 10);
        Drive(Tick(2, 90.0f));
        var d = Assert.Single(_decisions);
        Assert.Null(d.Lap);
        Assert.Contains("reset", d.SkipReason);
    }

    [Fact]
    public void TowLeavingTheWorldMarksTheLapIncomplete()
    {
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(1, 155.0f, surface: -1));      // not in world
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(2, 140.0f));
        Assert.Contains("reset, towed", Assert.Single(_decisions).SkipReason);
    }

    [Fact]
    public void GoingToTheGarageMidLapMarksTheLapIncomplete()
    {
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(1, 155.0f, onTrack: false));
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(2, 140.0f));
        Assert.Null(Assert.Single(_decisions).Lap);
    }

    [Fact]
    public void LapCounterGoingBackwardsReBaselinesWithoutALap()
    {
        Cruise(Tick(5, 155.0f), 10);
        Cruise(Tick(0, -1f), 10);                 // session restart
        Assert.Empty(_decisions);
        Cruise(Tick(1, 153.0f), LapDetector.LapTimeDeadlineTicks + 10); // first crossing after the drop: the out lap
        Assert.Empty(_decisions);
        Drive(Tick(2, 152.0f));
        Assert.Equal(152000, Assert.Single(_decisions).Lap!.LapTimeMs);
    }

    [Fact]
    public void OutLapOnlyThenGarageExitIsAQuietResync()
    {
        // 1 -> 0 -> 1: the same transient as the real log, one lap in.
        var resynced = new List<string>();
        _detector.Resynced += resynced.Add;
        Cruise(Tick(1, 134.906f), 10);
        Drive(Tick(0, 134.906f, onTrack: false, surface: -1));
        Cruise(Tick(1, 134.906f), LapDetector.LapTimeDeadlineTicks + 10);

        Assert.Empty(_decisions);
        Assert.Equal("lap counter resynced 0 -> 1", Assert.Single(resynced));
    }

    [Fact]
    public void ExitingTheCarIsAResyncNotALapAndTheNextLapsAreStillTimedOnce()
    {
        // The owner's first real run (2026-09-26, 20:01-20:02): lap 3 posted at
        // 2:14.906, then on exiting the car LapCompleted fell to 0 and came back
        // to 3 within the same second.
        var resynced = new List<string>();
        _detector.Resynced += resynced.Add;
        Cruise(Tick(3, 134.906f), 10);
        Drive(Tick(0, 134.906f, onTrack: false, surface: -1));
        Cruise(Tick(3, 134.906f), 10);
        Assert.Empty(_decisions);
        Assert.Equal("lap counter resynced 0 -> 3", Assert.Single(resynced));

        // Back in the car: out of the pits, the counter restarts from zero.
        Cruise(Tick(0, 134.906f, pit: true), 10);
        Cruise(Tick(1, 134.906f), LapDetector.LapTimeDeadlineTicks + 10);
        Assert.Empty(_decisions);
        Assert.Equal("lap counter resynced 0 -> 1", resynced[^1]);

        Drive(Tick(2, 135.5f));
        Assert.Equal(135500, Assert.Single(_decisions).Lap!.LapTimeMs);
        Assert.Equal(2, resynced.Count);
    }

    [Fact]
    public void TheLapAfterAResyncCarriesItsOwnTimeNeverTheStaleOne()
    {
        Cruise(Tick(3, 134.906f), 10);
        Drive(Tick(0, 134.906f, onTrack: false, surface: -1));
        Cruise(Tick(3, 134.906f), 10);
        Drive(Tick(4, 136.0f));

        var lap = Assert.Single(_decisions).Lap!;
        Assert.Equal(136000, lap.LapTimeMs);
        Assert.Equal(4, lap.LapNumber);
        Assert.DoesNotContain(_decisions, d => d.Lap?.LapTimeMs == 134906);
    }

    [Fact]
    public void ALapStillShowingTheTimeFromBeforeTheDropIsStale()
    {
        // Out at lap 1 and straight back to it: a rise of one, but the time
        // channel never moves off the lap already posted.
        Cruise(Tick(1, 134.906f), 10);
        Drive(Tick(0, 134.906f, onTrack: false, surface: -1));
        _detector.Reset();                        // iRacing dropped out and back in between
        Cruise(Tick(0, 134.906f), 10);
        Drive(Tick(1, 134.906f));
        Cruise(Tick(1, 134.906f), LapDetector.LapTimeDeadlineTicks + 10);

        var d = Assert.Single(_decisions);
        Assert.Null(d.Lap);
        Assert.Contains("stale", d.SkipReason);
    }

    [Fact]
    public void CounterJumpingByMoreThanOneIsNotTimed()
    {
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(4, 151.0f));
        var d = Assert.Single(_decisions);
        Assert.Null(d.Lap);
        Assert.Contains("jumped", d.SkipReason);
    }

    [Fact]
    public void ANewSessionResetsEverything()
    {
        Cruise(Tick(3, 155.0f), 10);
        Cruise(Tick(0, -1f, sessionNum: 1), 10);  // practice -> race
        Drive(Tick(1, 154.0f, sessionNum: 1));
        Assert.Equal(154000, Assert.Single(_decisions).Lap!.LapTimeMs);
        _decisions.Clear();

        Cruise(Tick(0, -1f, sessionNum: 1, sessionUnique: 2), 10); // whole new session id
        Cruise(Tick(0, -1f, sessionNum: 1, sessionUnique: 2, carIdx: 4), 10); // car changed
        Assert.Empty(_decisions);
    }

    [Fact]
    public void ReplayTicksAreIgnoredAndTaintTheLapInProgress()
    {
        Cruise(Tick(1, 155.0f), 10);
        Cruise(Tick(7, 100.0f, replay: true), 10); // replay shows other laps
        Drive(Tick(2, 150.0f));
        Assert.Contains("replay", Assert.Single(_decisions).SkipReason);
    }

    [Fact]
    public void IncidentsAreTheDeltaAcrossTheLap()
    {
        Cruise(Tick(1, 155.0f, incidents: 4), 10);
        Cruise(Tick(1, 155.0f, incidents: 6), 10);
        Drive(Tick(2, 158.0f, incidents: 6));
        Assert.Equal(2, Assert.Single(_decisions).Lap!.IncidentDelta);
    }

    [Fact]
    public void MissingIncidentChannelLeavesTheLapClean()
    {
        var quiet = Tick(1, 155.0f) with { PlayerCarMyIncidentCount = null };
        Cruise(quiet, 10);
        Drive(quiet with { LapCompleted = 2, LapLastLapTime = 150.0f });
        Assert.Null(Assert.Single(_decisions).Lap!.IncidentDelta);
    }

    [Fact]
    public void NoComboYetMeansTheLapIsSkippedAndSaysSo()
    {
        _detector.Combo = null;
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(2, 150.0f));
        Assert.Contains("session info", Assert.Single(_decisions).SkipReason);
    }

    [Fact]
    public void ThirtyMinuteBoundIsAppliedBeforePosting()
    {
        Cruise(Tick(1, 155.0f), 10);
        Drive(Tick(2, 2000.0f));
        Assert.Contains("thirty minutes", Assert.Single(_decisions).SkipReason);
    }

    [Fact]
    public void ResetForgetsTheBaselineSoIracingRestartingCannotLeakALap()
    {
        Cruise(Tick(5, 155.0f), 10);
        _detector.Reset();
        Cruise(Tick(6, 150.0f), 10);              // looks like +1, but the baseline is gone
        Assert.Empty(_decisions);
        Drive(Tick(7, 149.0f));
        Assert.Equal(149000, Assert.Single(_decisions).Lap!.LapTimeMs);
    }

    [Fact]
    public void ChannelsTheSimDoesNotPublishDoNotCrashIt()
    {
        var bare = new TelemetryTick { LapCompleted = 1, LapLastLapTime = 155.0f };
        Cruise(bare, 10);
        Drive(bare with { LapCompleted = 2, LapLastLapTime = 150.0f });
        Assert.Equal(150000, Assert.Single(_decisions).Lap!.LapTimeMs);
    }

    [Fact]
    public void ACrossingWhileTheDriversCarIsNotOnTrackIsNotALap()
    {
        // Spectating or a camera on another car: the sim may not flag a replay,
        // but the player's own car is not on track when the counter moves.
        Cruise(Tick(1, 155.0f), 10);
        Cruise(Tick(1, 155.0f, onTrack: false), 5);
        _decisions.Clear();
        Drive(Tick(2, 150.0f, onTrack: false));
        Cruise(Tick(2, 150.0f, onTrack: false), LapDetector.LapTimeDeadlineTicks + 1);
        var d = Assert.Single(_decisions);
        Assert.Null(d.Lap);
        Assert.Contains("not on track", d.SkipReason);
    }

    [Fact]
    public void AReplayShowingLapsOfAnotherCarPostsNothing()
    {
        Cruise(Tick(3, 155.0f), 10);
        // Replay: counter and time channels show the replayed car's values.
        Cruise(Tick(9, 120.0f, replay: true), 30);
        Cruise(Tick(12, 118.0f, replay: true), 30);
        // Back live at the same lap as before: nothing from the replay counted.
        Cruise(Tick(3, 155.0f), 10);
        Assert.Empty(_decisions);
        // The lap that was in progress while the replay ran is tainted and
        // skipped; the one after it is timed once.
        Drive(Tick(4, 151.0f));
        Assert.Contains("replay", Assert.Single(_decisions).SkipReason);
        _decisions.Clear();
        Cruise(Tick(4, 151.0f), 10);
        Drive(Tick(5, 149.5f));
        Assert.Equal(149500, Assert.Single(_decisions).Lap!.LapTimeMs);
    }

    [Fact]
    public void AFullSessionRestartNeverPostsTheOldSessionsLastTimeAndTimesTheNewLaps()
    {
        // Session A: a lap of 2:14.906 posted.
        Cruise(Tick(2, 140.0f), 10);
        Drive(Tick(3, 134.906f));
        Assert.Equal(134906, Assert.Single(_decisions).Lap!.LapTimeMs);
        _decisions.Clear();
        var resyncs = new List<string>();
        _detector.Resynced += resyncs.Add;

        // Exit to the menu: the agent's owner calls Reset (disconnect). Then a
        // brand-new session, fresh car, counter from 0 in the pits, and the
        // time channel still showing session A's last lap.
        _detector.Reset();
        Cruise(Tick(0, 134.906f, pit: true, sessionNum: 0, sessionUnique: 77, carIdx: 4), 10);
        Drive(Tick(1, 134.906f, sessionUnique: 77, carIdx: 4));                 // out lap
        Cruise(Tick(1, 134.906f, sessionUnique: 77, carIdx: 4), LapDetector.LapTimeDeadlineTicks + 1);
        Assert.All(_decisions, d => Assert.Null(d.Lap));
        _decisions.Clear();

        Drive(Tick(2, 141.250f, sessionUnique: 77, carIdx: 4));                 // first flying lap
        var posted = Assert.Single(_decisions);
        Assert.Equal(141250, posted.Lap!.LapTimeMs);
        Assert.Equal(2, posted.Lap.LapNumber);
        Assert.DoesNotContain(_decisions, d => d.Lap?.LapTimeMs == 134906);
    }
}
