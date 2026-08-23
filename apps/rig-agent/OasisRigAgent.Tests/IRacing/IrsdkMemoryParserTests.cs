using System.Text;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The parser reads a region another process rewrites while we are in it, on a
/// computer the venue depends on. These cover the contract that matters there:
/// every declared offset is checked before it is followed, and anything that does
/// not check out fails rather than reading somewhere it should not.
/// </summary>
public sealed class IrsdkMemoryParserTests
{
    [Fact]
    public void ReadsEveryScalarTypeAndKeepsSessionMetadataAsOpaqueBytes()
    {
        var fixture = new IrsdkMemoryFixture()
            .AddVariable("Char", IrsdkVariableType.Char, 0, (byte)'A')
            .AddVariable("Bool", IrsdkVariableType.Bool, 1, true)
            .AddVariable("Int", IrsdkVariableType.Int, 4, 42)
            .AddVariable("Bits", IrsdkVariableType.BitField, 8, 0x80000001u)
            .AddVariable("Float", IrsdkVariableType.Float, 12, 1.25f)
            .AddVariable("Double", IrsdkVariableType.Double, 16, 2.5d);

        var frame = Parse(fixture, "Char", "Bool", "Int", "Bits", "Float", "Double");

        Assert.True(frame.IsConnected);
        Assert.Equal(100, frame.TickCount);
        Assert.Equal(60, frame.TickRate);
        Assert.Equal('A', frame.Values["Char"]);
        Assert.Equal(true, frame.Values["Bool"]);
        Assert.Equal(42, frame.Values["Int"]);
        Assert.Equal(0x80000001u, frame.Values["Bits"]);
        Assert.Equal(1.25f, frame.Values["Float"]);
        Assert.Equal(2.5d, frame.Values["Double"]);
        Assert.Contains("TrackName", Encoding.UTF8.GetString(frame.SessionInfoBytes!));
    }

    [Fact]
    public void ReportsAWatchedChannelTheSimDoesNotPublishAsAbsentRatherThanFailing()
    {
        var frame = Parse(new IrsdkMemoryFixture().AddVariable("Lap", IrsdkVariableType.Int, 0, 3), "Lap", "NotPublished");

        Assert.Equal(3, frame.Values["Lap"]);
        Assert.Null(frame.Values["NotPublished"]);
    }

    [Fact]
    public void TakesTheNewestOfSeveralTelemetryBuffers()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Lap", IrsdkVariableType.Int, 0, 1);
        fixture.WriteInt(32, 2);                 // two buffers
        fixture.WriteInt(64, 7);                 // second descriptor: newer tick
        fixture.WriteInt(68, IrsdkMemoryFixture.BufferOffset + 64);
        fixture.WriteInt(48, 6);                 // first descriptor: older tick
        fixture.WriteInt(IrsdkMemoryFixture.BufferOffset + 64, 99);

        var frame = Parse(fixture, "Lap");

        Assert.Equal(7, frame.TickCount);
        Assert.Equal(99, frame.Values["Lap"]);
    }

    /// <summary>
    /// The one decode failure that is certain rather than possible: iRacing ships a
    /// forced seasonal update, every rig in the venue takes it within a day, and a
    /// build that moves the layout version moves every field below this line.
    /// </summary>
    [Theory]
    [InlineData(1)]     // an older layout than this parser knows
    [InlineData(3)]     // the realistic one: a future iRacing build
    [InlineData(0)]     // a mapping published but not yet stamped
    public void RefusesATelemetryLayoutItWasNotWrittenFor(int published)
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Lap", IrsdkVariableType.Int, 0, 3);
        fixture.WriteInt(0, published);

        var failure = Assert.Throws<UnsupportedTelemetryFormatException>(() => Parse(fixture, "Lap"));

        Assert.Equal(published, failure.PublishedVersion);
        Assert.Equal(IrsdkMemoryParser.SupportedLayoutVersion, failure.SupportedVersion);
        // Both numbers in the message, because the log line is the whole evidence
        // that an agent update - not this machine - is what fixes the room.
        Assert.Contains(published.ToString(), failure.Message);
        Assert.Contains(IrsdkMemoryParser.SupportedLayoutVersion.ToString(), failure.Message);
    }

    /// <summary>
    /// Asked before anything else in the header, because every other check below is
    /// only meaningful under this version - and answering "the tick rate is outside
    /// 1..1000" to an iRacing update sends an operator hunting a fault that is not
    /// there. Here the version is wrong AND the tick rate is impossible; the version
    /// is the one that gets reported.
    /// </summary>
    [Fact]
    public void TheVersionIsCheckedBeforeAnythingItWouldHaveMoved()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Lap", IrsdkVariableType.Int, 0, 3);
        fixture.WriteInt(0, 3);
        fixture.WriteInt(8, 0);

        Assert.Throws<UnsupportedTelemetryFormatException>(() => Parse(fixture, "Lap"));
    }

    /// <summary>The version iRacing has published for years still reads normally -
    /// this check must not be what stops the venue scoring.</summary>
    [Fact]
    public void TheLayoutTheSimActuallyPublishesIsRead()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Lap", IrsdkVariableType.Int, 0, 3);
        fixture.WriteInt(0, IrsdkMemoryParser.SupportedLayoutVersion);

        Assert.Equal(3, Parse(fixture, "Lap").Values["Lap"]);
    }

    [Fact]
    public void ReportsTheSimAsDisconnectedWhenTheStatusBitIsClear()
    {
        var fixture = new IrsdkMemoryFixture();
        fixture.WriteInt(4, 0);

        Assert.False(Parse(fixture).IsConnected);
    }

    [Theory]
    [InlineData(8, 0)]            // tick rate below range
    [InlineData(8, 1001)]         // tick rate above range
    [InlineData(16, -1)]          // negative session metadata length
    [InlineData(16, 4_194_305)]   // session metadata over 4 MiB
    [InlineData(20, -1)]          // session metadata outside the mapping
    [InlineData(24, -1)]          // negative variable count
    [InlineData(24, 4097)]        // more variables than the cap
    [InlineData(28, -4)]          // variable headers before the mapping
    [InlineData(28, 16_385)]      // variable headers past the end of the mapping
    [InlineData(32, 0)]           // no telemetry buffers
    [InlineData(32, 9)]           // more buffers than the cap
    [InlineData(36, -1)]          // negative buffer length
    [InlineData(36, 0)]           // zero-length buffer
    [InlineData(52, -8)]          // buffer pointing before the mapping
    public void RefusesHeaderValuesThatWouldSendAReadOutsideTheMapping(int fieldOffset, int value)
    {
        var fixture = new IrsdkMemoryFixture();
        fixture.WriteInt(fieldOffset, value);

        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture));
    }

    [Fact]
    public void RefusesAnUnknownVariableType()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Bad", IrsdkVariableType.Int, 0, 1);
        fixture.WriteInt(IrsdkMemoryFixture.VariableHeadersOffset, 99);

        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture, "Bad"));
    }

    [Fact]
    public void RefusesAVariableThatPointsOutsideItsOwnTelemetryBuffer()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Bad", IrsdkVariableType.Int, 0, 1);
        fixture.WriteInt(IrsdkMemoryFixture.VariableHeadersOffset + 4, IrsdkMemoryFixture.BufferLength);

        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture, "Bad"));
    }

    [Fact]
    public void RefusesAnArrayLengthThatWouldOverflowItsSizeCalculation()
    {
        var fixture = new IrsdkMemoryFixture().AddVariable("Bad", IrsdkVariableType.Double, 0, 1d);
        fixture.WriteInt(IrsdkMemoryFixture.VariableHeadersOffset + 8, int.MaxValue);

        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture, "Bad"));
    }

    [Fact]
    public void RefusesDuplicateVariableNames()
    {
        var fixture = new IrsdkMemoryFixture()
            .AddVariable("Lap", IrsdkVariableType.Int, 0, 1)
            .AddVariable("Lap", IrsdkVariableType.Int, 4, 2);

        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture, "Lap"));
    }

    [Fact]
    public void RefusesAMappingTooSmallToHoldAHeader()
    {
        Assert.Throws<MalformedTelemetryException>(() => new IrsdkMemoryParser(new ByteArrayMemoryReader(new byte[16])));
    }

    [Fact]
    public void RandomlyCorruptedFramesAlwaysEndInAKnownFailureRatherThanAHangOrAnEscapedError()
    {
        var random = new Random(20260819);

        for (var attempt = 0; attempt < 400; attempt++)
        {
            var fixture = new IrsdkMemoryFixture()
                .AddVariable("Lap", IrsdkVariableType.Int, 0, 1)
                .AddVariable("LapLastLapTime", IrsdkVariableType.Float, 8, 92.5f);

            for (var corruption = 0; corruption < 6; corruption++)
                fixture.WriteInt(random.Next(0, 256) * 4, random.Next(int.MinValue, int.MaxValue));

            try
            {
                Parse(fixture, "Lap", "LapLastLapTime");
            }
            catch (MalformedTelemetryException)
            {
                // The only failure the caller has to handle.
            }
        }
    }

    /// <summary>
    /// The venue-visible failure: the sim finishes a lap by writing a new lap counter
    /// and that lap's time into the same buffer, and a reader caught in between can
    /// come away with the new lap counter beside the previous lap's time. That is a
    /// customer's leaderboard entry showing a time they did not just drive.
    ///
    /// The two channels move together in the sim, so any frame pairing one tick's lap
    /// counter with the other tick's lap time is torn no matter which order the parser
    /// read them in.
    /// </summary>
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void NeverMixesTwoTicksWhenTheSimPublishesUnderneathTheRead(int tearAfterReads)
    {
        var reader = Tearing(CrossingTheLine(), tearAfterReads);

        var frame = new IrsdkMemoryParser(reader).Parse(Watched);

        if (frame is null) return;      // the sim got in the way every time; nothing to judge
        Assert.Equal(
            frame.Values["LapCompleted"] is 3 ? BeforeTheLine : AfterTheLine,
            (frame.TickCount, frame.Values["LapCompleted"], frame.Values["LapLastLapTime"]));
    }

    [Fact]
    public void RetriesTheCopyAndKeepsTheFrameWhenTheSimOnlyGetsInTheWayOnce()
    {
        var reader = Tearing(CrossingTheLine());

        var frame = new IrsdkMemoryParser(reader).Parse(Watched);

        Assert.Equal(1, reader.Tears);
        Assert.NotNull(frame);
        Assert.Equal(AfterTheLine, (frame!.TickCount, frame.Values["LapCompleted"], frame.Values["LapLastLapTime"]));
    }

    /// <summary>
    /// A reader that never wins the race reports no frame rather than a made-up one.
    /// The caller waits for the sim's next frame, exactly as iRacing's own client does.
    /// </summary>
    [Fact]
    public void ReportsNoFrameWhenEveryAttemptAtACopyIsOverwritten()
    {
        var fixture = CrossingTheLine();
        var tick = 100;
        var reader = new TearingMemoryReader(fixture.Bytes, () => fixture.WriteInt(48, ++tick), maxTears: 100);

        Assert.Null(new IrsdkMemoryParser(reader).Parse(Watched));
        Assert.InRange(reader.Tears, 2, 8);
    }

    private static readonly IReadOnlySet<string> Watched =
        new HashSet<string>(["LapCompleted", "LapLastLapTime"], StringComparer.Ordinal);

    private static readonly (int Tick, object? Lap, object? Time) BeforeTheLine = (100, 3, 0f);
    private static readonly (int Tick, object? Lap, object? Time) AfterTheLine = (101, 4, 138.103f);

    /// <summary>
    /// The whole rule, against a writer that is genuinely racing the reader rather than
    /// one a test steps through: another thread rotating three telemetry buffers as fast
    /// as it can, exactly as the sim does at 60 Hz on a rig busy running it.
    ///
    /// The two channels are written together and always agree - a lap time is its lap
    /// counter plus a quarter - so any frame where they disagree was assembled from two
    /// different ticks. This is the test that would have caught the original defect with
    /// no knowledge of where to inject the race.
    ///
    /// The writer leaves a read's worth of room between frames, as a 60 Hz simulator
    /// does. A writer that never yields is not a simulator - it is a memory bandwidth
    /// test that starves every other thread on the machine - and the case it would stand
    /// in for, the sim coming all the way back around to the buffer being read, is
    /// covered deterministically by
    /// <see cref="RefusesABufferTheSimHasComeAllTheWayBackAroundToRewriting"/>.
    /// </summary>
    [Fact]
    public void KeepsAFrameWholeWhileAnotherThreadRewritesTheBuffersUnderIt()
    {
        const int buffers = 3;
        const int bufferLength = 64;
        const int framesWanted = 2_000;

        // The witness is a lap counter and its lap time, which the writer always moves
        // together. It is kept small because a float stops being able to tell one
        // integer from the next past sixteen million, and this writer gets there.
        const int witnessPeriod = 100_000;

        var fixture = new IrsdkMemoryFixture()
            .AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 0)
            .AddVariable("LapLastLapTime", IrsdkVariableType.Float, 8, 0.25f);
        fixture.WriteInt(32, buffers);
        fixture.WriteInt(36, bufferLength);
        for (var buffer = 0; buffer < buffers; buffer++)
        {
            fixture.WriteInt(48 + buffer * 16, 0);
            fixture.WriteInt(52 + buffer * 16, IrsdkMemoryFixture.BufferOffset + buffer * bufferLength);
        }

        using var closing = new CancellationTokenSource();
        var sim = new Thread(() =>
        {
            for (var tick = 1; !closing.IsCancellationRequested; tick++)
            {
                var buffer = tick % buffers;
                var lap = tick % witnessPeriod;
                var at = IrsdkMemoryFixture.BufferOffset + buffer * bufferLength;
                fixture.WriteInt(at, lap);
                fixture.WriteInt(at + 8, BitConverter.SingleToInt32Bits(lap + 0.25f));
                Thread.MemoryBarrier();          // the values land before the tick claims them
                fixture.WriteInt(48 + buffer * 16, tick);
                Thread.MemoryBarrier();

                // A frame is 16 milliseconds of the sim's work; a read is microseconds of
                // the agent's. Without some gap the writer is not a simulator, it is a
                // memory bandwidth test, and the reader never gets to finish anything.
                Thread.Yield();
            }
        }) { IsBackground = true };

        var parser = new IrsdkMemoryParser(new OrderedMemoryReader(fixture.Bytes));
        var laps = new HashSet<int>();
        var missed = 0;
        var reads = 0;
        sim.Start();

        // Read at least framesWanted times, and keep going while the writer has not yet
        // been round enough times for the race to have been exercised.
        //
        // Deliberately not "framesWanted reads, then require 20 ticks": how far a
        // background thread gets in a fixed number of reads is a claim about the
        // machine's scheduler, and this suite runs its collections in parallel with
        // other thread-driven tests. Under that, a starved writer failed a test that
        // had found no defect. Waiting longer on a busy machine costs nothing and
        // asserts the same thing; the bound keeps a genuinely stuck writer a failure.
        var clock = System.Diagnostics.Stopwatch.StartNew();
        while (reads < framesWanted
               || (laps.Count <= 20 && clock.Elapsed < TimeSpan.FromSeconds(20)))
        {
            reads++;
            var frame = parser.Parse(Watched);
            if (frame is null) { missed++; continue; }
            var lap = (int)frame.Values["LapCompleted"]!;
            Assert.Equal((float)(lap + 0.25), frame.Values["LapLastLapTime"]);
            laps.Add(lap);
        }

        closing.Cancel();
        Assert.True(sim.Join(TimeSpan.FromSeconds(10)), "the sim thread did not stop");

        // The race has to have been won repeatedly, or the invariant above proves nothing.
        Assert.True(
            laps.Count > 20,
            $"the sim barely moved under the reader: {laps.Count} ticks over {reads} reads "
            + $"in {clock.Elapsed.TotalSeconds:F1}s, {missed} missed");
    }

    /// <summary>
    /// The case iRacing's own client does not cover, and the reason this parser checks
    /// more than the tick it copied.
    ///
    /// The sim stamps a buffer's tick after writing it, so a writer that has come all the
    /// way back around to the buffer being read is rewriting bytes under a tick that has
    /// not moved. Reading that tick before and after says the frame is whole; it is not.
    /// The tell is that the buffer is no longer the newest, which it cannot be, because
    /// getting back there meant stamping every other buffer with a higher tick first.
    /// </summary>
    [Fact]
    public void RefusesABufferTheSimHasComeAllTheWayBackAroundToRewriting()
    {
        const int bufferLength = 64;
        var fixture = new IrsdkMemoryFixture()
            .AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 10)
            .AddVariable("LapLastLapTime", IrsdkVariableType.Float, 8, 10.25f);
        fixture.WriteInt(32, 3);
        fixture.WriteInt(36, bufferLength);
        for (var buffer = 0; buffer < 3; buffer++)
            fixture.WriteInt(52 + buffer * 16, IrsdkMemoryFixture.BufferOffset + buffer * bufferLength);
        fixture.WriteInt(48, 10);       // the newest, and the one about to be rewritten
        fixture.WriteInt(64, 8);
        fixture.WriteInt(80, 9);

        var reader = new TearingMemoryReader(fixture.Bytes, () =>
        {
            // Two whole frames go by...
            PublishFrame(fixture, buffer: 1, tick: 11);
            PublishFrame(fixture, buffer: 2, tick: 12);
            // ...and the sim is part-way through the third, into the buffer being read,
            // with that buffer's tick still claiming the frame it is destroying.
            fixture.WriteInt(IrsdkMemoryFixture.BufferOffset, 13);
        }) { PublishBeforeRead = true };

        var frame = new IrsdkMemoryParser(reader).Parse(Watched);

        Assert.NotNull(frame);
        Assert.Equal((12, 12, 12.25f), (frame!.TickCount, frame.Values["LapCompleted"], frame.Values["LapLastLapTime"]));
    }

    private static void PublishFrame(IrsdkMemoryFixture fixture, int buffer, int tick)
    {
        var at = IrsdkMemoryFixture.BufferOffset + buffer * 64;
        fixture.WriteInt(at, tick);
        fixture.WriteInt(at + 8, BitConverter.SingleToInt32Bits(tick + 0.25f));
        fixture.WriteInt(48 + buffer * 16, tick);
    }

    private static TearingMemoryReader Tearing(IrsdkMemoryFixture fixture, int tearAfterReads = 1) =>
        new(fixture.Bytes, () => PublishTheCompletedLap(fixture), tearAfterReads);

    private static IrsdkMemoryFixture CrossingTheLine() =>
        new IrsdkMemoryFixture()
            .AddVariable("LapCompleted", IrsdkVariableType.Int, 0, 3)
            .AddVariable("LapLastLapTime", IrsdkVariableType.Float, 8, 0f);

    /// <summary>What the sim writes as the car crosses the line: the lap counter, that
    /// lap's time, and the tick that says the buffer is new.</summary>
    private static void PublishTheCompletedLap(IrsdkMemoryFixture fixture)
    {
        fixture.WriteInt(IrsdkMemoryFixture.BufferOffset, 4);
        fixture.WriteInt(IrsdkMemoryFixture.BufferOffset + 8, BitConverter.SingleToInt32Bits(138.103f));
        fixture.WriteInt(48, 101);
    }

    private static IrsdkFrame Parse(IrsdkMemoryFixture fixture, params string[] watched) =>
        new IrsdkMemoryParser(new ByteArrayMemoryReader(fixture.Bytes))
            .Parse(new HashSet<string>(watched, StringComparer.Ordinal))
        ?? throw new InvalidOperationException("A reader that never changes cannot produce a torn frame.");
}
