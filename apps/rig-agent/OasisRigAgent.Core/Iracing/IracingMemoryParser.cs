using System.Buffers.Binary;
using System.Text;

namespace OasisRigAgent.Core.Iracing;

/// <summary>
/// Bounds-checked reader over iRacing's shared-memory telemetry block.
///
/// Ported from the Phase 1 spike recorder (`spike/OasisSpike/IrracingMemoryParser.cs`)
/// rather than taking a package dependency: the spike's parser is repository-owned,
/// dependency-free, opens the map read-only, treats every header field as untrusted,
/// and already has synthetic-buffer tests for negative, overflowed, truncated and
/// duplicated input. The candidate libraries (IRSDKSharper, irsdkSharp,
/// iRacingSdkWrapper) are permissively licensed but each pulls in YAML and reflection
/// machinery this agent does not need, and none has been run on an Oasis rig either -
/// so a new dependency would buy nothing the spike had not already proven off-site.
///
/// Layout (irsdk_header in the iRacing SDK): a 48-byte fixed header, then
/// `bufferCount` 16-byte buffer descriptors, `variableCount` 144-byte variable
/// headers at `variableHeaderOffset`, the session-info YAML string at
/// `sessionInfoOffset`, and the telemetry buffers themselves. The producer
/// rotates buffers; the one with the highest tick count is the newest frame.
/// </summary>
public interface IReadOnlyMemoryReader
{
    long Capacity { get; }
    void Read(long offset, Span<byte> destination);
}

public sealed class IracingMemoryParser
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
    private byte[] _variableBytes = [];

    public IracingMemoryParser(IReadOnlyMemoryReader reader)
    {
        _reader = reader;
        if (reader.Capacity < FixedHeaderSize || reader.Capacity > MaximumMappedBytes)
            throw new MalformedTelemetryException($"Mapped capacity {reader.Capacity} is outside the safe range.");
    }

    /// <summary>The fixed header exactly as the sim wrote it, unvalidated. Small
    /// enough to read from any block that could be a header at all; a block
    /// shorter than that is malformed.</summary>
    public static RawHeader ReadHeader(IReadOnlyMemoryReader reader)
    {
        if (reader.Capacity < RawHeader.Size)
            throw new MalformedTelemetryException($"Mapped capacity {reader.Capacity} is smaller than the {RawHeader.Size}-byte header.");
        Span<byte> header = stackalloc byte[RawHeader.Size];
        try
        {
            reader.Read(0, header);
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            throw new MalformedTelemetryException("The shared-memory header read failed.", ex);
        }
        return new RawHeader(
            Version: ReadInt(header, 0),
            Status: ReadInt(header, 4),
            TickRate: ReadInt(header, 8),
            SessionInfoUpdate: ReadInt(header, 12),
            SessionInfoLength: ReadInt(header, 16),
            SessionInfoOffset: ReadInt(header, 20),
            VariableCount: ReadInt(header, 24),
            VariableHeaderOffset: ReadInt(header, 28),
            BufferCount: ReadInt(header, 32),
            BufferLength: ReadInt(header, 36));
    }

    public ParsedMemorySnapshot Parse(IReadOnlySet<string> watchedVariables)
    {
        var raw = ReadHeader(_reader);

        // A header whose connected bit is clear is not looked at any further:
        // while iRacing loads a session it fills the block in stages, and the
        // zeros it holds meanwhile are "not ready", not corruption.
        if (!raw.Connected)
        {
            return new ParsedMemorySnapshot(
                IsConnected: false,
                TickCount: 0,
                TickRate: raw.TickRate,
                SessionInfoUpdate: raw.SessionInfoUpdate,
                Variables: new Dictionary<string, TelemetryVariable>(),
                Values: new Dictionary<string, object?>());
        }

        var tickRate = raw.TickRate;
        var sessionInfoUpdate = raw.SessionInfoUpdate;
        var sessionInfoLength = raw.SessionInfoLength;
        var sessionInfoOffset = raw.SessionInfoOffset;
        var variableCount = raw.VariableCount;
        var variableHeaderOffset = raw.VariableHeaderOffset;
        var bufferCount = raw.BufferCount;
        var bufferLength = raw.BufferLength;

        Require(tickRate is >= 1 and <= 1000, $"Tick rate {tickRate} is outside 1..1000.");
        Require(sessionInfoLength is >= 0 and <= MaximumSessionInfoBytes, "Session metadata is too large or negative.");
        ValidateRange(sessionInfoOffset, sessionInfoLength, "session metadata");
        Require(variableCount is >= 1 and <= MaximumVariables, $"Variable count {variableCount} is outside 1..{MaximumVariables}.");
        Require(bufferCount is >= 1 and <= MaximumBuffers, $"Buffer count {bufferCount} is outside 1..{MaximumBuffers}.");
        Require(bufferLength > 0, $"Buffer length {bufferLength} must be positive.");
        ValidateRange(FixedHeaderSize, checked(bufferCount * BufferHeaderSize), "buffer headers");
        ValidateRange(variableHeaderOffset, checked(variableCount * VariableHeaderSize), "variable headers");

        var variables = ParseVariables(variableHeaderOffset, variableCount, bufferLength);
        var (tickCount, bufferOffset) = FindLatestBuffer(bufferCount, bufferLength);
        var values = ParseWatchedValues(variables, watchedVariables, bufferOffset);

        return new ParsedMemorySnapshot(
            IsConnected: true,
            TickCount: tickCount,
            TickRate: tickRate,
            SessionInfoUpdate: sessionInfoUpdate,
            Variables: variables,
            Values: values);
    }

    /// <summary>The session-info region as the header currently places it (empty
    /// when the sim publishes none), or null when the sim is no longer connected.
    /// Read on its own
    /// because it is large and changes rarely, so it is not copied every frame.</summary>
    public byte[]? ReadSessionInfo()
    {
        var raw = ReadHeader(_reader);
        if (!raw.Connected) return null;
        if (raw.SessionInfoLength == 0) return [];
        Require(raw.SessionInfoLength is > 0 and <= MaximumSessionInfoBytes, "Session metadata is too large or negative.");
        var bytes = new byte[raw.SessionInfoLength];
        ReadChecked(raw.SessionInfoOffset, bytes);
        return bytes;
    }

    /// <summary>The variable table, read in one piece rather than one read per
    /// header, then parsed and validated from those bytes.</summary>
    private IReadOnlyDictionary<string, TelemetryVariable> ParseVariables(int baseOffset, int count, int bufferLength)
    {
        var length = checked(count * VariableHeaderSize);
        if (_variableBytes.Length != length) _variableBytes = new byte[length];
        ReadChecked(baseOffset, _variableBytes);

        var variables = new Dictionary<string, TelemetryVariable>(count, StringComparer.Ordinal);
        for (var index = 0; index < count; index++)
        {
            var bytes = _variableBytes.AsSpan(index * VariableHeaderSize, VariableHeaderSize);
            var typeNumber = ReadInt(bytes, 0);
            Require(typeNumber is >= 0 and < 6, $"Variable {index} has an unknown type {typeNumber}.");
            var valueOffset = ReadInt(bytes, 4);
            var elementCount = ReadInt(bytes, 8);
            Require(elementCount > 0, $"Variable {index} has a non-positive element count.");
            var valueSize = (long)elementCount * TypeSizes[typeNumber];
            Require(valueOffset >= 0 && (long)valueOffset + valueSize <= bufferLength,
                $"Variable {index} points outside its telemetry buffer.");

            var name = ReadFixedString(bytes.Slice(16, 32));
            Require(name.Length > 0, $"Variable {index} has an empty name.");
            Require(!variables.ContainsKey(name), $"Variable name '{name}' is duplicated.");

            variables.Add(name, new TelemetryVariable(
                (IracingVariableType)typeNumber,
                valueOffset,
                elementCount,
                bytes[12] != 0,
                name,
                ReadFixedString(bytes.Slice(48, 64)),
                ReadFixedString(bytes.Slice(112, 32))));
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
                IracingVariableType.Char => (char)target[0],
                IracingVariableType.Bool => target[0] != 0,
                IracingVariableType.Int => BinaryPrimitives.ReadInt32LittleEndian(target),
                IracingVariableType.BitField => BinaryPrimitives.ReadUInt32LittleEndian(target),
                IracingVariableType.Float => BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(target)),
                IracingVariableType.Double => BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64LittleEndian(target)),
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

/// <summary>
/// irsdk_header from the iRacing SDK (irsdk_defines.h), field for field:
/// <c>int ver; int status; int tickRate; int sessionInfoUpdate; int sessionInfoLen;
/// int sessionInfoOffset; int numVars; int varHeaderOffset; int numBuf; int bufLen;
/// int pad1[2];</c> - ten ints at offsets 0..36, then two pad ints, so the
/// <c>irsdk_varBuf</c> entries (<c>int tickCount; int bufOffset; int pad[2];</c>,
/// 16 bytes each) start at byte 48. <c>status</c> is the <c>irsdk_StatusField</c>
/// bit set and <c>irsdk_stConnected</c> is bit 1.
/// </summary>
public sealed record RawHeader(
    int Version,
    int Status,
    int TickRate,
    int SessionInfoUpdate,
    int SessionInfoLength,
    int SessionInfoOffset,
    int VariableCount,
    int VariableHeaderOffset,
    int BufferCount,
    int BufferLength)
{
    public const int Size = 40;
    public bool Connected => (Status & 1) != 0;

    public override string ToString()
        => $"ver={Version} status={Status} tickRate={TickRate} sessionInfoUpdate={SessionInfoUpdate} "
         + $"sessionInfoLen={SessionInfoLength} sessionInfoOffset={SessionInfoOffset} numVars={VariableCount} "
         + $"varHeaderOffset={VariableHeaderOffset} numBuf={BufferCount} bufLen={BufferLength}";
}

public enum IracingVariableType
{
    Char = 0,
    Bool = 1,
    Int = 2,
    BitField = 3,
    Float = 4,
    Double = 5
}

public sealed record TelemetryVariable(
    IracingVariableType Type,
    int Offset,
    int Count,
    bool CountAsTime,
    string Name,
    string Description,
    string Unit);

public sealed record ParsedMemorySnapshot(
    bool IsConnected,
    int TickCount,
    int TickRate,
    int SessionInfoUpdate,
    IReadOnlyDictionary<string, TelemetryVariable> Variables,
    IReadOnlyDictionary<string, object?> Values);

public sealed class MalformedTelemetryException : Exception
{
    public MalformedTelemetryException(string message) : base(message) { }
    public MalformedTelemetryException(string message, Exception innerException) : base(message, innerException) { }
}
