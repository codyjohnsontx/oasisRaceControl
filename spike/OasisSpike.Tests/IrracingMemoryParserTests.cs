using OasisSpike;

namespace OasisSpike.Tests;

public sealed class IrracingMemoryParserTests
{
    [Fact]
    public void ParsesEveryScalarTypeAndRawSessionPayload()
    {
        var fixture = new MemoryFixture()
            .AddVariable("Char", IrracingVariableType.Char, 0, (byte)'A')
            .AddVariable("Bool", IrracingVariableType.Bool, 1, true)
            .AddVariable("Int", IrracingVariableType.Int, 4, 42)
            .AddVariable("Bits", IrracingVariableType.BitField, 8, 0x80000001u)
            .AddVariable("Float", IrracingVariableType.Float, 12, 1.25f)
            .AddVariable("Double", IrracingVariableType.Double, 16, 2.5d);
        var watched = new HashSet<string>(["Char", "Bool", "Int", "Bits", "Float", "Double"]);

        var result = new IrracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(watched);

        Assert.True(result.IsConnected);
        Assert.Equal(100, result.TickCount);
        Assert.Equal('A', result.Values["Char"]);
        Assert.Equal(true, result.Values["Bool"]);
        Assert.Equal(42, result.Values["Int"]);
        Assert.Equal(0x80000001u, result.Values["Bits"]);
        Assert.Equal(1.25f, result.Values["Float"]);
        Assert.Equal(2.5d, result.Values["Double"]);
        Assert.Contains("TrackName", System.Text.Encoding.UTF8.GetString(result.SessionInfoBytes!));
    }

    [Theory]
    [InlineData(16, -1)]
    [InlineData(16, 4194305)]
    [InlineData(24, -1)]
    [InlineData(24, 4097)]
    [InlineData(32, 0)]
    [InlineData(32, 9)]
    [InlineData(36, -1)]
    public void RejectsUnsafeHeaderValues(int fieldOffset, int value)
    {
        var fixture = new MemoryFixture();
        fixture.WriteInt(fieldOffset, value);
        Assert.Throws<MalformedTelemetryException>(() =>
            new IrracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(new HashSet<string>()));
    }

    [Fact]
    public void RejectsUnknownVariableType()
    {
        var fixture = new MemoryFixture().AddVariable("Bad", IrracingVariableType.Int, 0, 1);
        fixture.WriteInt(MemoryFixture.VariableHeadersOffset, 99);
        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture));
    }

    [Fact]
    public void RejectsVariableOutsideTelemetryBuffer()
    {
        var fixture = new MemoryFixture().AddVariable("Bad", IrracingVariableType.Int, 0, 1);
        fixture.WriteInt(MemoryFixture.VariableHeadersOffset + 4, MemoryFixture.BufferLength);
        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture));
    }

    [Fact]
    public void RejectsOverflowSizedVariableArraysAsMalformedTelemetry()
    {
        var fixture = new MemoryFixture().AddVariable("Bad", IrracingVariableType.Double, 0, 1d);
        fixture.WriteInt(MemoryFixture.VariableHeadersOffset + 8, int.MaxValue);
        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture));
    }

    [Fact]
    public void RejectsDuplicateVariableNames()
    {
        var fixture = new MemoryFixture()
            .AddVariable("Same", IrracingVariableType.Int, 0, 1)
            .AddVariable("Same", IrracingVariableType.Int, 4, 2);
        Assert.Throws<MalformedTelemetryException>(() => Parse(fixture));
    }

    [Fact]
    public void PreservesSessionMetadataAsOpaqueBytesWithoutExecutingOrInterpretingIt()
    {
        var fixture = new MemoryFixture();
        var raw = new byte[] { 0xff, 0xfe, 0x00, (byte)':', (byte)'!' };
        raw.CopyTo(fixture.Bytes.AsSpan(MemoryFixture.SessionInfoOffset));
        fixture.WriteInt(16, raw.Length);

        var result = new IrracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(new HashSet<string>());

        Assert.Equal(raw, result.SessionInfoBytes);
    }

    [Fact]
    public void RandomMalformedInputsNeverHangOrEscapeExpectedFailures()
    {
        var random = new Random(73451);
        for (var iteration = 0; iteration < 500; iteration++)
        {
            var bytes = new byte[random.Next(48, 32768)];
            random.NextBytes(bytes);
            try
            {
                _ = new IrracingMemoryParser(new ByteArrayMemoryReader(bytes)).Parse(new HashSet<string> { "Lap" });
            }
            catch (MalformedTelemetryException)
            {
            }
            catch (OverflowException ex)
            {
                throw new Xunit.Sdk.XunitException($"Overflow escaped parser validation: {ex.Message}");
            }
            catch (ArgumentOutOfRangeException ex)
            {
                throw new Xunit.Sdk.XunitException($"Bounds exception escaped parser validation: {ex.Message}");
            }
        }
    }

    private static ParsedMemorySnapshot Parse(MemoryFixture fixture) =>
        new IrracingMemoryParser(new ByteArrayMemoryReader(fixture.Bytes)).Parse(new HashSet<string> { "Bad", "Same" });
}
