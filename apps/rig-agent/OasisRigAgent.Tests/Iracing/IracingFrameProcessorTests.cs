using Xunit;
using OasisRigAgent.Core.Iracing;

namespace OasisRigAgent.Tests.Iracing;

/// <summary>
/// The first run on a real rig (2026-09-26, iRacing test drive) died the moment
/// the session started loading: the header carried the connected bit with
/// tickRate still 0, the parser threw, and three throws faulted the loop. These
/// pin the rule that no read ends the loop.
/// </summary>
public sealed class IracingFrameProcessorTests
{
    private readonly LapDetector _detector = new(() => DateTimeOffset.UnixEpoch, "rig1");
    private readonly IracingFrameProcessor _frames;
    private readonly List<bool> _connection = new();
    private readonly List<RawHeader> _attached = new();
    private readonly List<(RawHeader? Header, string Reason)> _rejected = new();

    public IracingFrameProcessorTests()
    {
        _frames = new IracingFrameProcessor(_detector);
        _frames.ConnectionChanged += _connection.Add;
        _frames.Attached += _attached.Add;
        _frames.HeaderRejected += (h, r) => _rejected.Add((h, r));
    }

    [Fact]
    public void AZeroedBlockIsNotConnectedAndNotAnError()
    {
        var reader = new ByteArrayMemoryReader(new byte[16 * 1024]);
        for (var i = 0; i < 5; i++) Assert.Equal(FrameOutcome.NotConnected, _frames.Process(reader));
        Assert.False(_frames.Connected);
        Assert.Empty(_rejected);
        Assert.Empty(_connection);
    }

    [Fact]
    public void ConnectedBitWithTickRateZeroIsNotReadyReportedOnceAndNeverFatal()
    {
        // What the rig showed: iRacing sets the connected bit before the rest of the header.
        var fixture = new MemoryFixture();
        fixture.WriteInt(8, 0);   // tickRate
        fixture.WriteInt(24, 0);  // numVars
        fixture.WriteInt(32, 0);  // numBuf
        var reader = new ByteArrayMemoryReader(fixture.Bytes);

        var outcomes = Enumerable.Range(0, 5).Select(_ => _frames.Process(reader)).ToList();

        Assert.All(outcomes, o => Assert.Equal(FrameOutcome.NotReady, o));
        Assert.False(_frames.Connected);
        var (header, reason) = Assert.Single(_rejected);
        Assert.NotNull(header);
        Assert.True(header!.Connected);
        Assert.Equal(0, header.TickRate);
        Assert.Contains("Tick rate 0", reason);
        Assert.Contains("tickRate=0", header.ToString());
    }

    [Fact]
    public void AHeaderThatBecomesValidLaterAttachesAndDeliversFrames()
    {
        var fixture = new MemoryFixture();
        fixture.WriteInt(8, 0);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        Assert.Equal(FrameOutcome.NotReady, _frames.Process(reader));
        Assert.Equal(FrameOutcome.NotReady, _frames.Process(reader));

        // The sim finishes filling the block in.
        fixture.WriteInt(8, 60);
        fixture.AddVariable("LapCompleted", IracingVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IracingVariableType.Float, 4, 150.0f);

        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.True(_frames.Connected);
        Assert.Equal(new[] { true }, _connection);
        var attached = Assert.Single(_attached);
        Assert.Equal(60, attached.TickRate);
        Assert.Equal(2, attached.VariableCount);
        Assert.Single(_rejected);

        // And a later crossing becomes a lap.
        LapDecision? decision = null;
        _detector.Decided += d => decision = d;
        _detector.Combo = new SessionCombo("Circuit of the Americas", "Grand Prix", "FIA F4", 0, null, null, null);
        fixture.WriteInt(48, 101);                              // new tick
        fixture.WriteInt(MemoryFixture.BufferOffset, 4);        // LapCompleted 3 -> 4
        fixture.WriteInt(MemoryFixture.BufferOffset + 4, BitConverter.SingleToInt32Bits(148.5f));
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.NotNull(decision);
        Assert.Equal(148500, decision!.Lap!.LapTimeMs);
    }

    [Fact]
    public void AMalformedFrameAfterGoodOnesIsRetriedThenWaitedOut()
    {
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        fixture.WriteInt(36, -1); // bufLen goes bad mid-session
        Assert.Equal(FrameOutcome.Retry, _frames.Process(reader));
        Assert.Equal(FrameOutcome.Retry, _frames.Process(reader));
        Assert.Equal(FrameOutcome.NotReady, _frames.Process(reader));
        Assert.False(_frames.Connected);
        Assert.Contains("Buffer length -1", Assert.Single(_rejected).Reason);

        fixture.WriteInt(36, MemoryFixture.BufferLength);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.True(_frames.Connected);
        Assert.Equal(2, _attached.Count); // re-attached after the outage
    }

    [Fact]
    public void ABlockTooSmallForAHeaderIsNotReadyWithNoHeaderToShow()
    {
        var reader = new ByteArrayMemoryReader(new byte[8]);
        Assert.Equal(FrameOutcome.NotReady, _frames.Process(reader));
        var (header, reason) = Assert.Single(_rejected);
        Assert.Null(header);
        Assert.Contains("smaller than the 40-byte header", reason);
    }

    private const string CotaSessionInfo =
        "WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n TrackConfigName: Grand Prix\n" +
        "DriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   CarScreenName: FIA F4\n";

    [Fact]
    public void SessionInfoThatNamesNoComboYetIsRetriedOnceASecondWithoutWaitingForTheNextUpdate()
    {
        // iRacing publishes session info in pieces while loading: the first read
        // at an update can find the track but no car yet.
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        fixture.WriteInt(12, 2);
        fixture.SetSessionInfo("WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n");
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        var combos = new List<SessionCombo>();
        _frames.ComboChanged += combos.Add;
        var incomplete = new List<string>();
        _frames.SessionInfoIncomplete += incomplete.Add;

        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Null(_detector.Combo);
        Assert.Contains("TrackDisplayName=\"Circuit of the Americas\"", Assert.Single(incomplete));

        fixture.SetSessionInfo(CotaSessionInfo); // same update number, now complete
        fixture.WriteInt(48, 159);                // under a second of sim time later
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Null(_detector.Combo);

        fixture.WriteInt(48, 160);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        Assert.Equal("FIA F4", _detector.Combo?.CarScreenName);
        Assert.Equal("FIA F4", Assert.Single(combos).CarScreenName);
        Assert.Single(incomplete);
    }

    [Fact]
    public void TheIncompleteNoticeRepeatsOnlyWhenWhatWasFoundChangesOrTheSimReconnects()
    {
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        var incomplete = new List<string>();
        _frames.SessionInfoIncomplete += incomplete.Add;

        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        fixture.WriteInt(12, 2);
        fixture.WriteInt(48, 101);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Single(incomplete);

        fixture.WriteInt(4, 0);
        Assert.Equal(FrameOutcome.NotConnected, _frames.Process(reader));
        fixture.WriteInt(4, 1);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Equal(2, incomplete.Count);
    }

    [Fact]
    public void TheIncompleteNoticeFollowsSessionInfoPastTheLoadingSnapshot()
    {
        // The first read lands mid-load; the full document then arrives but
        // still names no car for the player - that later state is the one to show.
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        fixture.SetSessionInfo("WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n");
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        var incomplete = new List<string>();
        _frames.SessionInfoIncomplete += incomplete.Add;
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        fixture.SetSessionInfo(
            "WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n" +
            "DriverInfo:\n DriverCarIdx: 7\n Drivers:\n - CarIdx: 0\n   CarScreenName: FIA F4\n");
        fixture.WriteInt(48, 160);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        Assert.Equal(2, incomplete.Count);
        Assert.Contains("drivers listed=0", incomplete[0]);
        Assert.Contains("DriverCarIdx=7", incomplete[1]);
        Assert.Contains("drivers listed=1", incomplete[1]);
    }

    [Fact]
    public void TheSimLeavingBeforeSessionInfoIsReadIsNotConnectedAndNotAnIncompleteSession()
    {
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var reader = new HeaderClearingReader(fixture, headerReadsBeforeClearing: 2);
        var incomplete = new List<string>();
        _frames.SessionInfoIncomplete += incomplete.Add;

        Assert.Equal(FrameOutcome.NotConnected, _frames.Process(reader));

        Assert.False(_frames.Connected);
        Assert.Empty(incomplete);
    }

    [Fact]
    public void TheSimLeavingBetweenTheHeaderCheckAndTheParseIsNotConnected()
    {
        var fixture = new MemoryFixture()
            .AddVariable("LapCompleted", IracingVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IracingVariableType.Float, 4, 150.0f);
        var reader = new HeaderClearingReader(fixture, headerReadsBeforeClearing: 1);
        var missing = new List<IReadOnlyList<string>>();
        _frames.MissingVariables += missing.Add;

        Assert.Equal(FrameOutcome.NotConnected, _frames.Process(reader));

        Assert.False(_frames.Connected);
        Assert.Empty(_connection);
        Assert.Empty(missing);
        Assert.Empty(_attached);
    }

    /// <summary>Clears the connected bit after a given number of header reads, the
    /// way the sim does when it leaves a session mid-frame.</summary>
    private sealed class HeaderClearingReader(MemoryFixture fixture, int headerReadsBeforeClearing) : IReadOnlyMemoryReader
    {
        private int _headerReads;
        public long Capacity => fixture.Bytes.Length;
        public void Read(long offset, Span<byte> destination)
        {
            fixture.Bytes.AsSpan(checked((int)offset), destination.Length).CopyTo(destination);
            if (offset == 0 && ++_headerReads == headerReadsBeforeClearing) fixture.WriteInt(4, 0);
        }
    }

    [Fact]
    public void ATornSessionInfoReadNeverWipesTheComboAlreadyNamed()
    {
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        fixture.SetSessionInfo(CotaSessionInfo);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        var combos = new List<SessionCombo>();
        _frames.ComboChanged += combos.Add;
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        var named = _detector.Combo;
        Assert.NotNull(named);

        fixture.WriteInt(12, 2);
        fixture.SetSessionInfo("WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n");
        fixture.WriteInt(48, 101);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        Assert.Equal(named, _detector.Combo);
        Assert.Single(combos);
    }

    [Fact]
    public void DisconnectResetsTheDetectorSoTheNextSessionStartsClean()
    {
        var fixture = new MemoryFixture()
            .AddVariable("LapCompleted", IracingVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IracingVariableType.Float, 4, 150.0f);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        _detector.Combo = new SessionCombo("X", null, "Y", 0, null, null, null);
        var decisions = new List<LapDecision>();
        _detector.Decided += decisions.Add;
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        fixture.WriteInt(4, 0); // sim leaves the session
        Assert.Equal(FrameOutcome.NotConnected, _frames.Process(reader));
        Assert.Equal(new[] { true, false }, _connection);

        fixture.WriteInt(4, 1);
        fixture.WriteInt(48, 101);
        fixture.WriteInt(MemoryFixture.BufferOffset, 4); // would be +1 without the reset
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Empty(decisions);
    }

    [Fact]
    public void AFullSessionRestartReReadsTheComboAndNeverPostsTheOldSessionsTime()
    {
        var combos = new List<SessionCombo?>();
        _frames.ComboChanged += combos.Add;
        var decisions = new List<LapDecision>();
        _detector.Decided += decisions.Add;

        static string Session(int uniqueId, string car) =>
            $"WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n TrackConfigName: Grand Prix\nSessionInfo:\n Sessions:\n - SessionNum: 0\nDriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   CarScreenName: {car}\n   CarID: {uniqueId}\n";

        // Session A in the FIA F4: lap 3 posted at 2:14.906.
        var fixture = new MemoryFixture()
            .AddVariable("LapCompleted", IracingVariableType.Int, 0, 2)
            .AddVariable("LapLastLapTime", IracingVariableType.Float, 4, 140.0f)
            .AddVariable("SessionUniqueID", IracingVariableType.Int, 8, 11)
            .AddVariable("PlayerCarIdx", IracingVariableType.Int, 12, 0)
            .AddVariable("OnPitRoad", IracingVariableType.Bool, 16, false)
            .SetSessionInfo(Session(11, "FIA F4"));
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Equal("FIA F4", Assert.Single(combos)!.CarScreenName);
        fixture.WriteInt(48, 101);
        fixture.WriteInt(MemoryFixture.BufferOffset, 3);
        fixture.WriteInt(MemoryFixture.BufferOffset + 4, BitConverter.SingleToInt32Bits(134.906f));
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Equal(134906, Assert.Single(decisions).Lap!.LapTimeMs);
        decisions.Clear();

        // Exit to the menu: connected bit clears.
        fixture.WriteInt(4, 0);
        Assert.Equal(FrameOutcome.NotConnected, _frames.Process(reader));

        // A brand-new session in a different car, counter restarted on track,
        // sessionInfoUpdate bumped, and the time channel still showing 134.906.
        fixture.SetSessionInfo(Session(12, "Porsche 911 GT3 R"));
        fixture.WriteInt(12, 2);                                            // sessionInfoUpdate
        fixture.WriteInt(4, 1);
        fixture.WriteInt(48, 102);
        fixture.WriteInt(MemoryFixture.BufferOffset, 0);
        fixture.WriteInt(MemoryFixture.BufferOffset + 8, 12);               // SessionUniqueID
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Equal("Porsche 911 GT3 R", combos.Last()!.CarScreenName);

        // First crossing: counter 0 -> 1 off pit road with the stale time. Never posted.
        fixture.WriteInt(48, 103);
        fixture.WriteInt(MemoryFixture.BufferOffset, 1);
        for (var i = 0; i < LapDetector.LapTimeDeadlineTicks + 2; i++)
        {
            fixture.WriteInt(48, 104 + i);
            Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        }
        var first = Assert.Single(decisions);
        Assert.Null(first.Lap);
        Assert.Contains("stale", first.SkipReason);
        decisions.Clear();

        // First flying lap of the new session posts once, with the new car.
        fixture.WriteInt(48, 999);
        fixture.WriteInt(MemoryFixture.BufferOffset, 2);
        fixture.WriteInt(MemoryFixture.BufferOffset + 4, BitConverter.SingleToInt32Bits(141.25f));
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        var posted = Assert.Single(decisions).Lap!;
        Assert.Equal(141250, posted.LapTimeMs);
        Assert.Equal("Porsche 911 GT3 R", posted.CarName);
    }

    [Fact]
    public void AFrozenTickUnderASetConnectedBitIsNotConnectedAfterTheStallTimeoutUntilItMovesAgain()
    {
        // A hung or crashed iRacing leaves the connected bit set and the block readable.
        var now = 0L;
        var frames = new IracingFrameProcessor(_detector, () => now);
        var connection = new List<bool>();
        frames.ConnectionChanged += connection.Add;
        var rejected = new List<string>();
        frames.HeaderRejected += (_, reason) => rejected.Add(reason);
        _detector.Combo = new SessionCombo("X", null, "Y", 0, null, null, null);
        var decisions = new List<LapDecision>();
        _detector.Decided += decisions.Add;
        var fixture = new MemoryFixture()
            .AddVariable("LapCompleted", IracingVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IracingVariableType.Float, 4, 150.0f);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));

        var timeout = (long)IracingFrameProcessor.StallTimeout.TotalMilliseconds;
        now = timeout - 1;
        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));
        Assert.True(frames.Connected);

        now = timeout;
        Assert.Equal(FrameOutcome.NotConnected, frames.Process(reader));
        Assert.False(frames.Connected);
        now += 5_000;
        Assert.Equal(FrameOutcome.NotConnected, frames.Process(reader));
        Assert.Equal(new[] { true, false }, connection);
        Assert.Contains("has not advanced", Assert.Single(rejected));

        // The sim comes back: the tick moves, and the detector started clean.
        fixture.WriteInt(48, 101);
        fixture.WriteInt(MemoryFixture.BufferOffset, 4); // would be +1 without the reset
        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));
        Assert.Equal(new[] { true, false, true }, connection);
        Assert.Empty(decisions);
    }

    [Fact]
    public void ReturningFromALongSpellOutOfSessionOnTheSameTickIsNotAStall()
    {
        var now = 0L;
        var frames = new IracingFrameProcessor(_detector, () => now);
        var rejected = new List<string>();
        frames.HeaderRejected += (_, reason) => rejected.Add(reason);
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));

        fixture.WriteInt(4, 0); // menus
        Assert.Equal(FrameOutcome.NotConnected, frames.Process(reader));
        now += 2 * (long)IracingFrameProcessor.StallTimeout.TotalMilliseconds;

        fixture.WriteInt(4, 1); // back on the frozen tick
        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));
        Assert.True(frames.Connected);
        Assert.Empty(rejected);
    }

    [Fact]
    public void ATickThatKeepsMovingNeverStalls()
    {
        var now = 0L;
        var frames = new IracingFrameProcessor(_detector, () => now);
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        for (var i = 0; i < 10; i++)
        {
            fixture.WriteInt(48, 100 + i);
            Assert.Equal(FrameOutcome.Frame, frames.Process(reader));
            now += (long)IracingFrameProcessor.StallTimeout.TotalMilliseconds - 1;
        }
        Assert.True(frames.Connected);
    }

    [Fact]
    public void TheReadLoopReadsOnATimeoutSoAHungSimThatNeverSignalsIsSeenToStall()
    {
        // A hung iRacing never sets the data-valid event again: every wait
        // times out. The stall can only be seen if a timeout still reads.
        var now = 0L;
        var frames = new IracingFrameProcessor(_detector, () => now);
        var connection = new List<bool>();
        frames.ConnectionChanged += connection.Add;
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var reader = new CountingReader(new ByteArrayMemoryReader(fixture.Bytes));
        using var stop = new CancellationTokenSource();
        var waits = 0;
        var readsAtStop = -1;
        var stallAfter = (int)(IracingFrameProcessor.StallTimeout.TotalMilliseconds / 250);

        IracingTelemetrySource.ReadLoop(frames, reader, () =>
        {
            now += 250;
            if (++waits <= stallAfter + 2) return WaitHandle.WaitTimeout;
            readsAtStop = reader.Reads;
            stop.Cancel();
            return 1; // the stop handle
        }, stop.Token);

        Assert.Equal(new[] { true, false }, connection);
        Assert.False(frames.Connected);
        // The stop wake ends the loop without another read.
        Assert.Equal(readsAtStop, reader.Reads);
    }

    /// <summary>A race frame: the player in car 7, third, with the race
    /// channels and the player's element of the CarIdx arrays set.</summary>
    private static MemoryFixture RaceFrame() => new MemoryFixture()
        .AddVariable("PlayerCarIdx", IracingVariableType.Int, 0, 7)
        .AddVariable("SessionNum", IracingVariableType.Int, 4, 2)
        .AddVariable("SessionUniqueID", IracingVariableType.Int, 8, 4242)
        .AddVariable("SessionState", IracingVariableType.Int, 12, 4)
        .AddVariable("PlayerCarPosition", IracingVariableType.Int, 16, 3)
        .AddVariable("SessionFlags", IracingVariableType.BitField, 20, 0x10u)
        .AddVariable("SessionTimeRemain", IracingVariableType.Double, 24, 600.0)
        .AddVariable("LapDistPct", IracingVariableType.Float, 32, 0.5f)
        .AddVariable("CarIdxF2Time", IracingVariableType.Float, 64, 0f, count: 64)
        .AddVariable("CarIdxLastLapTime", IracingVariableType.Float, 64 + 256, 0f, count: 64)
        .AddVariable("CarIdxBestLapTime", IracingVariableType.Float, 64 + 512, 0f, count: 64)
        .SetElement(64, IracingVariableType.Float, 7, 2.341f)
        .SetElement(64, IracingVariableType.Float, 6, 0.5f)
        .SetElement(64 + 256, IracingVariableType.Float, 7, 102.341f)
        .SetElement(64 + 512, IracingVariableType.Float, 7, 101.9f)
        .SetSessionInfo("""
            WeekendInfo:
             TrackDisplayName: Circuit of the Americas
            SessionInfo:
             Sessions:
             - SessionNum: 0
               SessionType: Practice
             - SessionNum: 2
               SessionType: Race
            DriverInfo:
             DriverCarIdx: 7
             Drivers:
             - CarIdx: 7
               CarScreenName: FIA F4
            """);

    /// <summary>Codex's reproduction from the review of PR 53: session info
    /// that already names the combo, but not yet the active session's type,
    /// must still be retried under the same update number - or every rig
    /// reports sessionType null all race and the server never sees a race.</summary>
    [Fact]
    public void SessionInfoWithTheComboButNoTypeForTheActiveSessionIsRetriedOnceASecond()
    {
        var race = new RaceStatusSampler();
        var frames = new IracingFrameProcessor(_detector, race: race);
        var fixture = RaceFrame(); // SessionNum 2
        const string combo = "WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n"
                           + "DriverInfo:\n DriverCarIdx: 7\n Drivers:\n - CarIdx: 7\n   CarScreenName: FIA F4\n";
        fixture.SetSessionInfo(combo);
        var reader = new ByteArrayMemoryReader(fixture.Bytes);

        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));
        Assert.Equal("FIA F4", _detector.Combo?.CarScreenName);
        Assert.Null(race.RaceStatus(DateTimeOffset.UnixEpoch)!.SessionType);

        // Same update number: the sessions list arrives, but only practice so far.
        fixture.SetSessionInfo(combo + "SessionInfo:\n Sessions:\n - SessionNum: 0\n   SessionType: Practice\n");
        fixture.WriteInt(48, 160);
        frames.Process(reader);
        Assert.Null(race.RaceStatus(DateTimeOffset.UnixEpoch)!.SessionType);

        // Still the same update number, now with the race entry.
        fixture.SetSessionInfo(combo + "SessionInfo:\n Sessions:\n - SessionNum: 0\n   SessionType: Practice\n"
                                     + " - SessionNum: 2\n   SessionType: Race\n");
        fixture.WriteInt(48, 219);                // under a second of sim time later
        frames.Process(reader);
        Assert.Null(race.RaceStatus(DateTimeOffset.UnixEpoch)!.SessionType);
        fixture.WriteInt(48, 220);
        frames.Process(reader);
        Assert.Equal("Race", race.RaceStatus(DateTimeOffset.UnixEpoch)!.SessionType);
    }

    [Fact]
    public void OnceTheActiveSessionHasATypeSessionInfoIsNotReadAgainUntilTheNextUpdate()
    {
        var race = new RaceStatusSampler();
        var frames = new IracingFrameProcessor(_detector, race: race);
        var fixture = RaceFrame();
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        frames.Process(reader);
        Assert.Equal("Race", race.RaceStatus(DateTimeOffset.UnixEpoch)!.SessionType);

        // A document change under the same update number is not looked at.
        fixture.SetSessionInfo("SessionInfo:\n Sessions:\n - SessionNum: 2\n   SessionType: Changed\n");
        fixture.WriteInt(48, 1000);
        frames.Process(reader);
        Assert.Equal("Race", race.RaceStatus(DateTimeOffset.UnixEpoch)!.SessionType);
    }

    [Fact]
    public void WithARaceSamplerEachFrameFeedsItThePlayersOwnRow()
    {
        var race = new RaceStatusSampler();
        var frames = new IracingFrameProcessor(_detector, race: race);
        var fixture = RaceFrame();
        var reader = new ByteArrayMemoryReader(fixture.Bytes);

        Assert.Equal(FrameOutcome.Frame, frames.Process(reader));
        var row = race.RaceStatus(DateTimeOffset.UnixEpoch);

        Assert.NotNull(row);
        Assert.Equal((4242, 2, "Race", 4, 0x10u), (row!.SessionUniqueId, row.SessionNum, row.SessionType, row.SessionState, row.SessionFlags));
        Assert.Equal((7, 3), (row.CarIdx, row.Position));
        // The player's element, not element 0 or a neighbour's.
        Assert.Equal(2.341, row.GapToLeaderS);
        Assert.Equal((102_341, 101_900), (row.LastLapMs, row.BestLapMs));
        Assert.Equal(600.0, row.SessionTimeRemainS);
        Assert.Equal(0.5, row.LapDistPct);

        // Two cars swap: the next frame carries the new place.
        fixture.WriteInt(MemoryFixture.BufferOffset + 16, 2);
        fixture.WriteInt(48, 101);
        frames.Process(reader);
        Assert.Equal(2, race.RaceStatus(DateTimeOffset.UnixEpoch)!.Position);
    }

    [Fact]
    public void TheSimGoingAwayClearsTheRaceRow()
    {
        var race = new RaceStatusSampler();
        var frames = new IracingFrameProcessor(_detector, race: race);
        var fixture = RaceFrame();
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        frames.Process(reader);
        Assert.NotNull(race.RaceStatus(DateTimeOffset.UnixEpoch));

        fixture.WriteInt(4, 0);
        Assert.Equal(FrameOutcome.NotConnected, frames.Process(reader));
        Assert.Null(race.RaceStatus(DateTimeOffset.UnixEpoch));
        Assert.Empty(race.SessionTypes);
    }

    [Fact]
    public void RaceChannelsAreReadAndReportedMissingOnlyWithASampler()
    {
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        var withRace = new List<IReadOnlyList<string>>();
        var lapsOnly = new List<IReadOnlyList<string>>();
        var raceFrames = new IracingFrameProcessor(new LapDetector(() => DateTimeOffset.UnixEpoch, "r"), race: new RaceStatusSampler());
        var lapFrames = new IracingFrameProcessor(new LapDetector(() => DateTimeOffset.UnixEpoch, "r"));
        raceFrames.MissingVariables += withRace.Add;
        lapFrames.MissingVariables += lapsOnly.Add;

        raceFrames.Process(new ByteArrayMemoryReader(fixture.Bytes));
        lapFrames.Process(new ByteArrayMemoryReader(fixture.Bytes));

        Assert.Contains("PlayerCarPosition", withRace.Single());
        Assert.Contains("CarIdxF2Time", withRace.Single());
        Assert.DoesNotContain("PlayerCarPosition", lapsOnly.Single());
        Assert.Contains("LapLastLapTime", lapsOnly.Single());
    }

    private sealed class CountingReader(IReadOnlyMemoryReader inner) : IReadOnlyMemoryReader
    {
        public int Reads { get; private set; }
        public long Capacity => inner.Capacity;
        public void Read(long offset, Span<byte> destination)
        {
            Reads++;
            inner.Read(offset, destination);
        }
    }
}
