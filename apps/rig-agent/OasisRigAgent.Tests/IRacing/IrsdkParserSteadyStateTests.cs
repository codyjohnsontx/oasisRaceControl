using System.Text;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// What reading the sim costs sixty times a second, all day, on a machine whose only
/// real job is running the simulator smoothly.
///
/// The sim describes its channels once and republishes its session document only when
/// it changes, but a frame carries neither - so a parser that rebuilds both on every
/// frame is doing hundreds of kilobytes of work per frame for an answer that has not
/// moved. That is not only waste: allocation is what causes the garbage-collection
/// pauses that leave a reader mid-copy while the sim publishes underneath it, which is
/// the torn frame the copy-and-verify protocol exists to catch. Making the steady state
/// cheap makes that race rarer as well as the rig quieter.
///
/// The tests below hold that steady state to a budget, and - because a cache that goes
/// stale would silently read channels at last week's offsets - prove the parser still
/// notices the sim changing either of them.
/// </summary>
public sealed class IrsdkParserSteadyStateTests
{
    /// <summary>Roughly what a real car publishes; the sim's own count moves with the car
    /// and the season, and the point is the order of magnitude rather than the number.</summary>
    private const int PublishedChannels = 270;

    /// <summary>
    /// The budget a frame gets in the steady state. A frame costs about 800 bytes - the
    /// watched values, boxed, and the frame itself - so this is roomy enough not to turn
    /// on a runtime detail, and two orders of magnitude under the quarter of a megabyte
    /// per frame that rebuilding the channel table and re-copying the session document
    /// costs. That is what it is here to keep from coming back.
    /// </summary>
    private const int BytesPerFrameBudget = 2 * 1024;

    /// <summary>
    /// The same budget, held through the reader a rig actually runs.
    ///
    /// The measurement above is taken over a byte array, which copies with a span and
    /// allocates nothing whatever the parser asks of it - so it proves the parser's own
    /// caching and says nothing about the reader underneath it.
    /// <see cref="MappedViewReader"/> rents a buffer for every read from the mapping,
    /// several times a frame, and a rented buffer is only free while the pool serves the
    /// size asked for. That distinction is invisible in an array and decides whether this
    /// budget holds at the venue, where the cost of missing it is not slowness: an
    /// allocation on this path is what causes the collection pause that leaves a read
    /// half-done while the sim publishes underneath it, which is the one telemetry
    /// failure that produces a wrong leaderboard rather than a missing one.
    /// </summary>
    [Fact]
    public void HoldsThatBudgetThroughTheReaderARigRuns()
    {
        const int frames = 200;
        var fixture = RealisticMapping();
        using var mapping = new RealMapping(fixture.Bytes.Length);
        var parser = new IrsdkMemoryParser(mapping.Reader);

        PublishFrame(fixture, tick: 101);
        mapping.Publish(fixture.Bytes);
        Assert.NotNull(parser.Parse(LapDetector.WatchedVariables));      // warm up parser and pool

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var tick = 102; tick < 102 + frames; tick++)
        {
            PublishFrame(fixture, tick);
            mapping.Publish(fixture.Bytes);
            Assert.NotNull(parser.Parse(LapDetector.WatchedVariables));
        }

        var perFrame = (GC.GetAllocatedBytesForCurrentThread() - before) / frames;
        Assert.True(
            perFrame <= BytesPerFrameBudget,
            $"a steady-state frame read from a real mapping allocated {perFrame} bytes, "
            + $"over the {BytesPerFrameBudget} byte budget");
    }

    [Fact]
    public void RereadsNeitherTheChannelTableNorTheSessionDocumentWhileNeitherChanges()
    {
        const int frames = 200;
        var fixture = RealisticMapping();
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));

        PublishFrame(fixture, tick: 101);
        Assert.NotNull(parser.Parse(LapDetector.WatchedVariables));      // warm up

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var tick = 102; tick < 102 + frames; tick++)
        {
            PublishFrame(fixture, tick);
            Assert.NotNull(parser.Parse(LapDetector.WatchedVariables));
        }

        var perFrame = (GC.GetAllocatedBytesForCurrentThread() - before) / frames;
        Assert.True(
            perFrame <= BytesPerFrameBudget,
            $"a steady-state frame allocated {perFrame} bytes, over the {BytesPerFrameBudget} byte budget");
    }

    /// <summary>
    /// The whole risk of not re-reading the channel table: iRacing rewrites it when the
    /// customer changes car, and a parser still holding the old one reads every channel
    /// at an offset that now belongs to something else. Every value would still be a
    /// plausible number.
    /// </summary>
    [Fact]
    public void FollowsTheChannelTableWhenTheSimRewritesIt()
    {
        var fixture = new IrsdkMemoryFixture()
            .AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IrsdkVariableType.Float, 8, 92.5f);
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));

        Assert.Equal(3, parser.Parse(Watched)!.Values["LapCompleted"]);

        // The sim republishes its channels with the lap counter somewhere else, and
        // writes the customer's real lap count there.
        fixture.WriteInt(IrsdkMemoryFixture.VariableHeadersOffset + 4, 16);
        fixture.WriteInt(IrsdkMemoryFixture.BufferOffset + 16, 11);

        Assert.Equal(11, parser.Parse(Watched)!.Values["LapCompleted"]);
    }

    [Fact]
    public void ChecksAChannelTableTheSimRewritesRatherThanTrustingTheOneItAlreadyRead()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3);
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));
        Assert.NotNull(parser.Parse(Watched));

        // ...and then rewrites it to point outside the telemetry buffer.
        fixture.WriteInt(IrsdkMemoryFixture.VariableHeadersOffset + 4, IrsdkMemoryFixture.BufferLength);

        Assert.Throws<MalformedTelemetryException>(() => parser.Parse(Watched));
    }

    /// <summary>
    /// The table is checked against the telemetry buffer it describes, so a buffer that
    /// shrinks under a table that did not change has to be re-checked against it. The
    /// channel that goes out of bounds here is one the lap rules never read, so nothing
    /// downstream would catch it: only re-checking the table does.
    /// </summary>
    [Fact]
    public void ChecksTheChannelTableAgainABufferTheSimHasShrunk()
    {
        var fixture = new IrsdkMemoryFixture()
            .AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3)
            .AddVariable("Brake", IrsdkVariableType.Float, 2048, 0.5f);
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));
        Assert.NotNull(parser.Parse(Watched));

        fixture.WriteInt(36, 1024);

        Assert.Throws<MalformedTelemetryException>(() => parser.Parse(Watched));
    }

    /// <summary>
    /// The sim publishing fewer channels than it did is the same rewrite seen from the
    /// other end: the headers it dropped are still sitting in memory, byte for byte, in
    /// front of the new count.
    /// </summary>
    [Fact]
    public void ForgetsChannelsTheSimHasStoppedPublishing()
    {
        var fixture = new IrsdkMemoryFixture()
            .AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3)
            .AddVariable("Brake", IrsdkVariableType.Float, 8, 0.5f);
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));
        Assert.Contains("Brake", parser.Parse(Watched)!.Variables.Keys);

        fixture.WriteInt(24, 1);        // one channel now; the second header is untouched

        Assert.DoesNotContain("Brake", parser.Parse(Watched)!.Variables.Keys);
    }

    /// <summary>
    /// The session document is the sim's, and the sim says when it changed. Re-copying
    /// hundreds of kilobytes at 60 Hz to find out it did not is the cost of pretending
    /// otherwise; the reader above this one already ignores bytes that arrive under an
    /// unchanged revision.
    /// </summary>
    [Fact]
    public void KeepsTheSessionDocumentUntilTheSimAnnouncesANewOne()
    {
        // Spa and Monza, same length either way, so this turns on the revision number
        // rather than on the document's size - which is also part of the cache's key.
        const string spa = "WeekendInfo:\n TrackID: 341\n";
        const string monza = "WeekendInfo:\n TrackID: 349\n";
        var fixture = new IrsdkMemoryFixture().AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3);
        fixture.SetSessionInfo(spa);
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));
        Assert.Contains("TrackID: 341", Text(parser.Parse(Watched)!));

        fixture.SetSessionInfo(monza);
        Assert.Contains("TrackID: 341", Text(parser.Parse(Watched)!));

        fixture.AnnounceSessionInfo(2);
        Assert.Contains("TrackID: 349", Text(parser.Parse(Watched)!));
    }

    /// <summary>
    /// The one reason to re-read a revision already read: the sim writes that document
    /// in place while the agent reads it, so a payload that did not parse is usually one
    /// caught half-written. Retrying the same cached bytes could only fail the same way.
    /// </summary>
    [Fact]
    public void ReadsTheSessionDocumentAgainWhenTheReaderCouldNotUseIt()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3);
        fixture.SetSessionInfo("WeekendInfo:\n TrackID: 341\n");
        var parser = new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes));
        Assert.Contains("TrackID: 341", Text(parser.Parse(Watched)!));

        // The rest of the document lands, under the revision it was already announced by.
        fixture.SetSessionInfo("WeekendInfo:\n TrackID: 349\n");
        parser.RefreshSessionInfo();

        Assert.Contains("TrackID: 349", Text(parser.Parse(Watched)!));
    }

    private static readonly IReadOnlySet<string> Watched =
        new HashSet<string>(["LapCompleted", "LapLastLapTime"], StringComparer.Ordinal);

    private static string Text(IrsdkFrame frame) => Encoding.UTF8.GetString(frame.SessionInfoBytes!);

    /// <summary>
    /// A mapping the size of the sim's own: a few hundred channels and a session
    /// document of tens of kilobytes, which is what makes the per-frame cost of
    /// rebuilding them worth measuring.
    /// </summary>
    private static IrsdkMemoryFixture RealisticMapping()
    {
        const int headersAt = 1024;
        var sessionAt = headersAt + PublishedChannels * IrsdkMemoryParser.VariableHeaderSize + 1024;
        var bufferAt = sessionAt + 32 * 1024;
        var fixture = new IrsdkMemoryFixture(bufferAt + 8192, headersAt, sessionAt, bufferAt, 4096);

        // The channels the lap rules watch, then filler up to what a car really publishes.
        var offset = 0;
        foreach (var name in LapDetector.WatchedVariables)
        {
            fixture.AddVariable(name, IrsdkVariableType.Int, offset, 1);
            offset += 4;
        }

        for (var index = LapDetector.WatchedVariables.Count; index < PublishedChannels; index++)
        {
            fixture.AddVariable($"Channel{index:000}", IrsdkVariableType.Float, offset, index * 0.5f);
            offset += 4;
        }

        var document = new StringBuilder("WeekendInfo:\n TrackName: spa gp\n TrackID: 341\nDriverInfo:\n Drivers:\n");
        for (var driver = 0; document.Length < 20 * 1024; driver++)
            document.Append($" - CarIdx: {driver}\n   CarScreenName: Porsche 911 GT3 R\n   CarID: 173\n");
        fixture.SetSessionInfo(document.ToString());
        return fixture;
    }

    private static void PublishFrame(IrsdkMemoryFixture fixture, int tick) => fixture.WriteInt(48, tick);
}
