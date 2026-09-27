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
    public void SessionInfoThatNamesNoComboYetIsReadAgainWithoutWaitingForTheNextUpdate()
    {
        // iRacing publishes session info in pieces while loading: the first read
        // at an update can find the track but no car yet.
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 3);
        fixture.WriteInt(12, 2);
        fixture.SetSessionInfo("WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n");
        var reader = new ByteArrayMemoryReader(fixture.Bytes);
        var combos = new List<SessionCombo>();
        _frames.ComboChanged += combos.Add;

        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));
        Assert.Null(_detector.Combo);

        fixture.SetSessionInfo(CotaSessionInfo); // same update number, now complete
        Assert.Equal(FrameOutcome.Frame, _frames.Process(reader));

        Assert.Equal("FIA F4", _detector.Combo?.CarScreenName);
        Assert.Equal("FIA F4", Assert.Single(combos).CarScreenName);
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
}
