using System.Buffers.Binary;
using System.Text;

namespace OasisSpike;

public interface IReadOnlyMemoryReader
{
    long Capacity { get; }
    void Read(long offset, Span<byte> destination);
}

public sealed class IrracingMemoryParser
{
    public const long MaximumMappedBytes = 64L * 1024 * 1024;
    public const int MaximumSessionInfoBytes = 4 * 1024 * 1024;
    public const int MaximumVariables = 4096;
    public const int MaximumBuffers = 8;
    public const int VariableHeaderSize = 144;
    private const int FixedHeaderSize = 48;
    private const int BufferHeaderSize = 16;

    private static readonly int[] TypeSizes = [1, 1, 4, 4, 4, 8];
    private readonly IReadOnlyMemoryReader _reader;

    public IrracingMemoryParser(IReadOnlyMemoryReader reader)
    {
        _reader = reader;
        if (reader.Capacity < FixedHeaderSize || reader.Capacity > MaximumMappedBytes)
            throw new MalformedTelemetryException($"Mapped capacity {reader.Capacity} is outside the safe range.");
    }

    public ParsedMemorySnapshot Parse(IReadOnlySet<string> watchedVariables)
    {
        Span<byte> header = stackalloc byte[FixedHeaderSize];
        ReadChecked(0, header);

        var status = ReadInt(header, 4);
        var tickRate = ReadInt(header, 8);
        var sessionInfoUpdate = ReadInt(header, 12);
        var sessionInfoLength = ReadInt(header, 16);
        var sessionInfoOffset = ReadInt(header, 20);
        var variableCount = ReadInt(header, 24);
        var variableHeaderOffset = ReadInt(header, 28);
        var bufferCount = ReadInt(header, 32);
        var bufferLength = ReadInt(header, 36);

        Require(tickRate is >= 1 and <= 1000, "Tick rate is outside 1..1000.");
        Require(sessionInfoLength is >= 0 and <= MaximumSessionInfoBytes, "Session metadata is too large or negative.");
        ValidateRange(sessionInfoOffset, sessionInfoLength, "session metadata");
        Require(variableCount is >= 0 and <= MaximumVariables, "Variable count is outside the safe range.");
        Require(bufferCount is >= 1 and <= MaximumBuffers, "Buffer count is outside the safe range.");
        Require(bufferLength > 0, "Buffer length must be positive.");
        ValidateRange(FixedHeaderSize, checked(bufferCount * BufferHeaderSize), "buffer headers");
        ValidateRange(variableHeaderOffset, checked(variableCount * VariableHeaderSize), "variable headers");

        var variables = ParseVariables(variableHeaderOffset, variableCount, bufferLength);
        var (tickCount, bufferOffset) = FindLatestBuffer(bufferCount, bufferLength);
        var values = ParseWatchedValues(variables, watchedVariables, bufferOffset);

        byte[]? sessionBytes = null;
        if (sessionInfoLength > 0)
        {
            sessionBytes = new byte[sessionInfoLength];
            ReadChecked(sessionInfoOffset, sessionBytes);
        }

        return new ParsedMemorySnapshot(
            IsConnected: (status & 1) != 0,
            TickCount: tickCount,
            TickRate: tickRate,
            SessionInfoUpdate: sessionInfoUpdate,
            Variables: variables,
            Values: values,
            SessionInfoBytes: sessionBytes);
    }

    private IReadOnlyDictionary<string, TelemetryVariable> ParseVariables(int baseOffset, int count, int bufferLength)
    {
        var variables = new Dictionary<string, TelemetryVariable>(count, StringComparer.Ordinal);
        var bytes = new byte[VariableHeaderSize];

        for (var index = 0; index < count; index++)
        {
            var offset = checked(baseOffset + checked(index * VariableHeaderSize));
            ReadChecked(offset, bytes);
            var typeNumber = ReadInt(bytes, 0);
            Require(typeNumber is >= 0 and < 6, $"Variable {index} has an unknown type {typeNumber}.");
            var valueOffset = ReadInt(bytes, 4);
            var elementCount = ReadInt(bytes, 8);
            Require(elementCount > 0, $"Variable {index} has a non-positive element count.");
            var valueSize = (long)elementCount * TypeSizes[typeNumber];
            Require(valueOffset >= 0 && (long)valueOffset + valueSize <= bufferLength,
                $"Variable {index} points outside its telemetry buffer.");

            var name = ReadFixedString(bytes.AsSpan(16, 32));
            Require(name.Length > 0, $"Variable {index} has an empty name.");
            Require(!variables.ContainsKey(name), $"Variable name '{name}' is duplicated.");

            variables.Add(name, new TelemetryVariable(
                (IrracingVariableType)typeNumber,
                valueOffset,
                elementCount,
                bytes[12] != 0,
                name,
                ReadFixedString(bytes.AsSpan(48, 64)),
                ReadFixedString(bytes.AsSpan(112, 32))));
        }

        return variables;
    }

    private (int TickCount, int BufferOffset) FindLatestBuffer(int bufferCount, int bufferLength)
    {
        Span<byte> descriptor = stackalloc byte[BufferHeaderSize];
        var latestTick = int.MinValue;
        var latestOffset = -1;

        for (var index = 0; index < bufferCount; index++)
        {
            ReadChecked(checked(FixedHeaderSize + index * BufferHeaderSize), descriptor);
            var tick = ReadInt(descriptor, 0);
            var offset = ReadInt(descriptor, 4);
            ValidateRange(offset, bufferLength, $"telemetry buffer {index}");
            if (tick > latestTick)
            {
                latestTick = tick;
                latestOffset = offset;
            }
        }

        Require(latestOffset >= 0, "No telemetry buffer was available.");
        return (latestTick, latestOffset);
    }

    private IReadOnlyDictionary<string, object?> ParseWatchedValues(
        IReadOnlyDictionary<string, TelemetryVariable> variables,
        IReadOnlySet<string> watched,
        int bufferOffset)
    {
        var values = new Dictionary<string, object?>(watched.Count, StringComparer.Ordinal);
        Span<byte> scalar = stackalloc byte[8];

        foreach (var name in watched)
        {
            if (!variables.TryGetValue(name, out var variable))
            {
                values[name] = null;
                continue;
            }

            var size = TypeSizes[(int)variable.Type];
            var target = scalar[..size];
            ReadChecked(checked(bufferOffset + variable.Offset), target);
            values[name] = variable.Type switch
            {
                IrracingVariableType.Char => (char)target[0],
                IrracingVariableType.Bool => target[0] != 0,
                IrracingVariableType.Int => BinaryPrimitives.ReadInt32LittleEndian(target),
                IrracingVariableType.BitField => BinaryPrimitives.ReadUInt32LittleEndian(target),
                IrracingVariableType.Float => BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(target)),
                IrracingVariableType.Double => BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64LittleEndian(target)),
                _ => throw new MalformedTelemetryException($"Unsupported variable type {variable.Type}.")
            };
        }

        return values;
    }

    private void ReadChecked(long offset, Span<byte> destination)
    {
        ValidateRange(offset, destination.Length, "read");
        try
        {
            _reader.Read(offset, destination);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            throw new MalformedTelemetryException("The shared-memory read failed bounds or access validation.", ex);
        }
    }

    private void ValidateRange(long offset, long length, string label)
    {
        try
        {
            Require(offset >= 0 && length >= 0 && checked(offset + length) <= _reader.Capacity,
                $"The {label} range is outside shared memory.");
        }
        catch (OverflowException ex)
        {
            throw new MalformedTelemetryException($"The {label} range overflowed.", ex);
        }
    }

    private static int ReadInt(ReadOnlySpan<byte> bytes, int offset) =>
        BinaryPrimitives.ReadInt32LittleEndian(bytes.Slice(offset, 4));

    private static string ReadFixedString(ReadOnlySpan<byte> bytes)
    {
        var terminator = bytes.IndexOf((byte)0);
        if (terminator >= 0) bytes = bytes[..terminator];
        return Encoding.Latin1.GetString(bytes).Trim();
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new MalformedTelemetryException(message);
    }
}

public sealed record ParsedMemorySnapshot(
    bool IsConnected,
    int TickCount,
    int TickRate,
    int SessionInfoUpdate,
    IReadOnlyDictionary<string, TelemetryVariable> Variables,
    IReadOnlyDictionary<string, object?> Values,
    byte[]? SessionInfoBytes);
