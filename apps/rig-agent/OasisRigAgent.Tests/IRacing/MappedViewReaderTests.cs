using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The agent reading a mapping the operating system really made, rather than a byte
/// array standing in for one.
///
/// Everything above <see cref="MappedViewReader"/> - the frame parser, the session
/// document, the lap rules, the whole live source - was proved against
/// <c>ByteArrayMemoryReader</c>, and the reader a rig actually runs was reached by no
/// test at all: it was a private class inside the Windows-only attachment code, so it
/// could not be constructed off Windows and was not constructed on it either. That is
/// the last seam between "409 tests pass" and "a lap appears on the board at the
/// venue", and it is not a formality - a mapped view differs from an array in ways
/// that decide whether a lap is read or lost:
///
/// * its size is the mapped region, which Windows rounds up to whole pages, so the
///   agent is routinely handed more bytes than the sim published and the tail reads
///   as zeroes;
/// * a read that runs off the end comes back <i>short</i> rather than throwing, so a
///   frame could be stitched from real bytes and a tail of nothing and still look
///   like a lap;
/// * the publisher writes into the same pages while the agent reads them.
/// </summary>
public sealed class MappedViewReaderTests
{
    private static readonly DateTimeOffset At = new(2026, 8, 19, 19, 30, 0, TimeSpan.Zero);

    /// <summary>The image the fake sim publishes. Held once so the mapping cases can
    /// be sized against it rather than against a number written down twice.</summary>
    private static int ImageLength => new FakeSim().Bytes.Length;

    [Fact]
    public void AFrameIsDecodedFromAMappingTheOperatingSystemMade()
    {
        var sim = new FakeSim();
        using var mapping = new RealMapping(ImageLength);
        mapping.Publish(sim.Bytes);

        var throughTheMapping = new IrsdkMemoryParser(mapping.Reader).Parse(LapDetector.WatchedVariables);
        var throughAnArray = new IrsdkMemoryParser(new ByteArrayMemoryReader(sim.Bytes))
            .Parse(LapDetector.WatchedVariables);

        Assert.NotNull(throughTheMapping);
        Assert.NotNull(throughAnArray);
        Assert.True(throughTheMapping!.IsConnected);
        Assert.Equal(throughAnArray!.TickCount, throughTheMapping.TickCount);
        Assert.Equal(throughAnArray.SessionInfoUpdate, throughTheMapping.SessionInfoUpdate);
        Assert.Equal(throughAnArray.SessionInfoBytes!.ToArray(), throughTheMapping.SessionInfoBytes!.ToArray());
        Assert.Equal(
            throughAnArray.Values.OrderBy(v => v.Key).ToList(),
            throughTheMapping.Values.OrderBy(v => v.Key).ToList());
    }

    [Fact]
    public void AViewLargerThanTheSimPublishedIntoStillDecodes()
    {
        // What a rig actually gets. Windows sizes a view by the mapped region, which
        // it rounds up to whole pages, so the agent is handed a capacity past the end
        // of the sim's own image and every byte after it reads as zero. A parser that
        // took capacity as "how much the sim published" would follow a zero header
        // into a frame nobody drove.
        var sim = new FakeSim();
        using var mapping = new RealMapping(ImageLength + 8 * 1024);
        mapping.Publish(sim.Bytes);

        Assert.True(mapping.Capacity > sim.Bytes.Length);
        var frame = new IrsdkMemoryParser(mapping.Reader).Parse(LapDetector.WatchedVariables);

        Assert.NotNull(frame);
        Assert.Equal(3, frame!.Values["LapCompleted"]);
    }

    [Fact]
    public void ALapDrivenThroughARealMappingReachesTheVenueWithItsTrackCarAndTime()
    {
        // The whole live path over a mapping the operating system made: attach,
        // decode, read the session document, apply the lap rules. Everything but the
        // Windows-only business of finding iRacing by name is the code a rig runs.
        var sim = new FakeSim();
        using var mapping = new RealMapping(ImageLength);
        var connections = new RealMappingConnectionFactory(sim, mapping);
        var source = new IRacingTelemetrySource(rigNumber: 7, connections, () => At, instanceId: "test");
        var laps = new List<LapCompleted>();
        var faults = new List<Exception>();
        source.LapCompleted += laps.Add;
        source.Faulted += faults.Add;

        Step(source, connections);                          // attach, mid-lap
        Cross(sim, source, connections, 4, 141.6f);         // ends the lap nobody watched the start of
        Cross(sim, source, connections, 5, 137.902f);       // the first lap watched line to line

        Assert.Empty(faults);
        var lap = Assert.Single(laps);
        Assert.Equal("Circuit de Spa-Francorchamps", lap.TrackName);
        Assert.Equal("Porsche 911 GT3 R", lap.CarName);
        Assert.Equal(137_902, lap.LapTimeMs);
        Assert.True(source.SimRunning);
    }

    [Fact]
    public void EverySimChannelTheLapRulesReadIsPresentThroughARealMapping()
    {
        // The channel check is what stands between a rig and a night of laps it
        // quietly cannot judge, and it reads the sim's own variable table out of the
        // mapping. Proving it over real shared memory is what says this rig would
        // report PASS at the venue rather than only in a byte array.
        var sim = new FakeSim();
        using var mapping = new RealMapping(ImageLength);
        var connections = new RealMappingConnectionFactory(sim, mapping);
        var source = new IRacingTelemetrySource(rigNumber: 7, connections, () => At, instanceId: "test");

        Step(source, connections);

        var report = source.Channels;
        Assert.NotNull(report);
        Assert.True(report!.CanScore, report.Describe());
        Assert.Empty(report.Blocking);
        Assert.Empty(report.Degraded);
        Assert.Null(source.SimUnusableReason);
    }

    [Fact]
    public void ASimWritingIntoTheMappingUnderTheAgentIsReadAsTheNewFrame()
    {
        // The publisher and the agent share the pages, so a value the sim changes must
        // be the value the agent's next read gets. A reader that copied the mapping
        // once would pass every test built on a static array and score one lap a night.
        var sim = new FakeSim();
        using var mapping = new RealMapping(ImageLength);
        var parser = new IrsdkMemoryParser(mapping.Reader);
        mapping.Publish(sim.Bytes);
        var before = parser.Parse(LapDetector.WatchedVariables);

        sim.CrossTheLine(9, 135.5f);
        mapping.Publish(sim.Bytes);
        var after = parser.Parse(LapDetector.WatchedVariables);

        Assert.Equal(3, before!.Values["LapCompleted"]);
        Assert.Equal(9, after!.Values["LapCompleted"]);
        Assert.NotEqual(before.TickCount, after.TickCount);
    }

    [Fact]
    public void AReadRunningOffTheEndOfTheViewFailsRatherThanReturningATailOfNothing()
    {
        // A mapped view clamps: asking for more than is left copies what it has and
        // reports how much. Taken at face value the caller gets real bytes followed by
        // whatever was already in the buffer, which is exactly the frame stitched from
        // two ticks that the whole parser is built to refuse.
        using var mapping = new RealMapping(16 * 1024);
        var destination = new byte[64];

        var straddling = Record.Exception(() => mapping.Reader.Read(mapping.Capacity - 16, destination));
        var pastTheEnd = Record.Exception(() => mapping.Reader.Read(mapping.Capacity, destination));

        Assert.NotNull(straddling);
        Assert.NotNull(pastTheEnd);
        // Both have to be kinds IrsdkMemoryParser.ReadChecked turns into malformed
        // telemetry; anything else escapes the parser as an unexplained fault and the
        // rig reports a reason nobody can act on.
        Assert.True(straddling is IOException or ArgumentException, straddling!.ToString());
        Assert.True(pastTheEnd is IOException or ArgumentException, pastTheEnd!.ToString());
    }

    [Fact]
    public void AMappingThatPointsPastItselfIsMalformedTelemetryThroughTheRealReader()
    {
        // The same refusal, reached the way a rig would reach it: an iRacing build
        // whose header no longer means what this parser reads it as. It must arrive as
        // malformed telemetry - that is the verdict `--check-sim` and the staff
        // dashboard turn into "this rig cannot read its simulator".
        var fixture = new IrsdkMemoryFixture();
        fixture.WriteInt(52, 15 * 1024);            // the telemetry buffer starts near the end...
        fixture.WriteInt(36, 8 * 1024);             // ...and is declared long enough to run past it
        using var mapping = new RealMapping(16 * 1024);
        mapping.Publish(fixture.Bytes);

        var parser = new IrsdkMemoryParser(mapping.Reader);

        Assert.Throws<MalformedTelemetryException>(() => parser.Parse(LapDetector.WatchedVariables));
    }

    [Fact]
    public void AnEmptyReadTouchesNothing()
    {
        // The parser asks for nothing when the sim declares a zero-length session
        // document, and a mapped view rejects a zero-length read at its very end.
        using var mapping = new RealMapping(4 * 1024);

        mapping.Reader.Read(mapping.Capacity, Span<byte>.Empty);
    }

    private static void Step(IRacingTelemetrySource source, RealMappingConnectionFactory connections)
    {
        connections.PublishFrame();
        source.Step();
    }

    private static void Cross(
        FakeSim sim,
        IRacingTelemetrySource source,
        RealMappingConnectionFactory connections,
        int lapCompleted,
        float seconds)
    {
        sim.CrossTheLine(lapCompleted, seconds);
        Step(source, connections);
    }
}
