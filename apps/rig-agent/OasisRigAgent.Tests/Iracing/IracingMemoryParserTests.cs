using Xunit;
using OasisRigAgent.Core.Iracing;

namespace OasisRigAgent.Tests.Iracing;

public sealed class IracingMemoryParserTests
{
    [Fact]
    public void ParsesTheChannelsTheDetectorWatchesFromASyntheticBlock()
    {
        var fixture = new MemoryFixture()
            .AddVariable("LapCompleted", IracingVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IracingVariableType.Float, 4, 152.34f)
            .AddVariable("OnPitRoad", IracingVariableType.Bool, 8, false)
            .AddVariable("PlayerCarMyIncidentCount", IracingVariableType.Int, 12, 2)
            .AddVariable("SessionFlags", IracingVariableType.BitField, 16, 0x80000001u)
            .AddVariable("SessionTime", IracingVariableType.Double, 20, 1234.5d)
            .SetSessionInfo("WeekendInfo:\n TrackDisplayName: Circuit of the Americas\n");

        var parsed = new IracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(TelemetryTick.VariableNames);

        Assert.True(parsed.IsConnected);
        Assert.Equal(100, parsed.TickCount);
        Assert.Equal(60, parsed.TickRate);
        var tick = TelemetryTick.FromValues(parsed.Values);
        Assert.Equal(3, tick.LapCompleted);
        Assert.Equal(152.34f, tick.LapLastLapTime);
        Assert.False(tick.OnPitRoad);
        Assert.Equal(2, tick.PlayerCarMyIncidentCount);
        // Channels the sim did not publish read as unknown, never as zero.
        Assert.Null(tick.Lap);
        Assert.Null(tick.IsReplayPlaying);
        Assert.Contains("Circuit of the Americas", SessionInfoParser.Decode(parsed.SessionInfoBytes!));
    }

    [Theory]
    [InlineData(16, -1)]        // negative session info length
    [InlineData(16, 4194305)]   // session info over 4 MiB
    [InlineData(24, -1)]        // negative variable count
    [InlineData(24, 4097)]      // too many variables
    [InlineData(32, 0)]         // no buffers
    [InlineData(32, 9)]         // too many buffers
    [InlineData(36, -1)]        // negative buffer length
    public void RejectsUnsafeHeaderValues(int fieldOffset, int value)
    {
        var fixture = new MemoryFixture();
        fixture.WriteInt(fieldOffset, value);
        Assert.Throws<MalformedTelemetryException>(() =>
            new IracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(TelemetryTick.VariableNames));
    }

    [Fact]
    public void RejectsAVariablePointingOutsideItsBuffer()
    {
        var fixture = new MemoryFixture().AddVariable("Bad", IracingVariableType.Int, 0, 1);
        fixture.WriteInt(MemoryFixture.VariableHeadersOffset + 4, MemoryFixture.BufferLength);
        Assert.Throws<MalformedTelemetryException>(() =>
            new IracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(TelemetryTick.VariableNames));
    }

    [Fact]
    public void ReportsNotConnectedWhenTheStatusBitIsClear()
    {
        var fixture = new MemoryFixture();
        fixture.WriteInt(4, 0);
        var parsed = new IracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(TelemetryTick.VariableNames);
        Assert.False(parsed.IsConnected);
    }

    [Fact]
    public void AZeroedHeaderIsNotConnectedRatherThanMalformed()
    {
        // Everything zero, including tickRate: what the block holds before a
        // session has loaded. Not connected is the answer, not an exception.
        var parsed = new IracingMemoryParser(new ByteArrayMemoryReader(new byte[16 * 1024])).Parse(TelemetryTick.VariableNames);
        Assert.False(parsed.IsConnected);
        Assert.Empty(parsed.Variables);
    }

    [Fact]
    public void ConnectedBitWithAnUnfilledHeaderIsRejectedNamingTheValue()
    {
        var fixture = new MemoryFixture();
        fixture.WriteInt(8, 0);
        var ex = Assert.Throws<MalformedTelemetryException>(() =>
            new IracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(TelemetryTick.VariableNames));
        Assert.Contains("Tick rate 0", ex.Message);
    }

    [Fact]
    public void ReadHeaderReturnsTheSdkFieldsAtTheirDocumentedOffsets()
    {
        // irsdk_header: ver, status, tickRate, sessionInfoUpdate, sessionInfoLen,
        // sessionInfoOffset, numVars, varHeaderOffset, numBuf, bufLen - ten ints
        // from offset 0. Written directly at those offsets, not via the fixture.
        var bytes = new byte[64];
        for (var i = 0; i < 10; i++) BitConverter.GetBytes(100 + i).CopyTo(bytes, i * 4);
        var h = IracingMemoryParser.ReadHeader(new ByteArrayMemoryReader(bytes));
        Assert.Equal((100, 101, 102, 103, 104, 105, 106, 107, 108, 109),
            (h.Version, h.Status, h.TickRate, h.SessionInfoUpdate, h.SessionInfoLength, h.SessionInfoOffset,
             h.VariableCount, h.VariableHeaderOffset, h.BufferCount, h.BufferLength));
        Assert.True(h.Connected); // 101 has bit 1 set
        BitConverter.GetBytes(2).CopyTo(bytes, 4); // bit 1 clear
        Assert.False(IracingMemoryParser.ReadHeader(new ByteArrayMemoryReader(bytes)).Connected);
        Assert.Throws<MalformedTelemetryException>(() => IracingMemoryParser.ReadHeader(new ByteArrayMemoryReader(new byte[39])));
    }

    [Fact]
    public void PicksTheNewestOfSeveralBuffers()
    {
        var fixture = new MemoryFixture().AddVariable("LapCompleted", IracingVariableType.Int, 0, 7);
        // A second buffer descriptor with a higher tick pointing at a copy of the block holding lap 9.
        fixture.WriteInt(32, 2);
        fixture.WriteInt(64, 101);
        fixture.WriteInt(68, MemoryFixture.BufferOffset + MemoryFixture.BufferLength);
        fixture.WriteInt(MemoryFixture.BufferOffset + MemoryFixture.BufferLength, 9);

        var parsed = new IracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(TelemetryTick.VariableNames);
        Assert.Equal(101, parsed.TickCount);
        Assert.Equal(9, parsed.Values["LapCompleted"]);
    }
}
