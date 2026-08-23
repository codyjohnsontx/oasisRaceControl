using System.Buffers.Binary;
using System.Text;

namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// Decodes one frame of the iRacing shared-memory telemetry layout.
///
/// This is a repository-owned parser rather than a third-party SDK binding, for
/// the reason documented in <c>docs/venue-safety.md</c>: the agent runs on ~25
/// computers the venue depends on, reading a memory region another process
/// rewrites underneath it. Every offset in that region is untrusted input, so
/// each one is range-checked against the mapping's real capacity before it is
/// followed, and anything that does not check out raises
/// <see cref="MalformedTelemetryException"/> instead of being tolerated.
///
/// It also follows iRacing's own reader protocol for getting a frame out of a
/// region the sim is still writing to: take the newest buffer, copy it whole, and
/// only keep it if the sim did not touch it in the meantime. Reading the channels
/// one at a time straight out of shared memory is what a frame stitched from two
/// different ticks looks like, and the lap rules read channels that only mean
/// anything together - a lap counter beside that lap's time, and beside whether the
/// car was in the pits for it. See <see cref="TryReadStableBuffer"/>.
///
/// The layout (little-endian, 48-byte fixed header) is:
///   0  int version        16 int sessionInfoLength  32 int bufferCount
///   4  int status          20 int sessionInfoOffset  36 int bufferLength
///   8  int tickRate        24 int variableCount      48 buffer descriptors
///   12 int sessionUpdate   28 int variableOffset        (16 bytes each)
/// </summary>
public sealed class IrsdkMemoryParser
{
    /// <summary>
    /// The layout version this parser was written against, and the value iRacing
    /// stamps in the first four bytes of its header (its own <c>IRSDK_VER</c>).
    ///
    /// Checked before anything else in the frame, because every other offset below is
    /// only meaningful under this version. A build that changes it moves the whole
    /// header, and the range checks would then either refuse the frame for a reason
    /// that has nothing to do with the cause, or - worse - pass on numbers that happen
    /// to look plausible and hand the lap rules a lap nobody drove.
    /// </summary>
    public const int SupportedLayoutVersion = 2;

    public const long MaximumMappedBytes = 64L * 1024 * 1024;
    public const int MaximumSessionInfoBytes = 4 * 1024 * 1024;
    public const int MaximumVariables = 4096;
    public const int MaximumBuffers = 8;
    public const int VariableHeaderSize = 144;
    private const int FixedHeaderSize = 48;
    private const int BufferHeaderSize = 16;

    /// <summary>Attempts at an untouched copy of the telemetry buffer before the frame
    /// is given up on. iRacing's own client tries twice; the third costs one more copy
    /// of a few kilobytes and is cheap next to losing a customer's lap on a rig whose
    /// scheduler is busy running the simulator.</summary>
    private const int StableCopyAttempts = 3;

    private static readonly int[] TypeSizes = [1, 1, 4, 4, 4, 8];
    private readonly IReadOnlyMemoryReader _reader;

    /// <summary>Where the telemetry buffer is copied to. Held across frames rather than
    /// allocated per frame: this runs 60 times a second on a machine whose only real job
    /// is running the simulator smoothly. One parser belongs to one connection and is
    /// read by one thread, which is what makes reusing it safe.</summary>
    private byte[] _snapshot = [];

    /// <summary>The channel table's bytes as they were when it was last decoded, and the
    /// spare buffer this frame's copy is read into before the two are compared. Swapped
    /// rather than copied when they differ, so a steady state allocates nothing.</summary>
    private byte[] _channelTable = [];
    private byte[] _channelTableScratch = [];

    /// <summary>The decode of <see cref="_channelTable"/>, and the buffer length its
    /// offsets were checked against. Held because the sim publishes its channel table
    /// once and then leaves it alone, while rebuilding it costs a few hundred strings a
    /// frame - and allocation at 60 Hz is what causes the collection pauses that leave a
    /// reader mid-copy while the sim publishes underneath it.</summary>
    private IReadOnlyDictionary<string, IrsdkVariable>? _channels;
    private int _channelsBufferLength;
    private int _channelTableSize;

    /// <summary>The session document as last copied out, and the sim's own revision
    /// number for it. The document runs to hundreds of kilobytes, the sim says when it
    /// changed, and the reader above this one already ignores bytes arriving under an
    /// unchanged revision - so copying it every frame buys nothing.</summary>
    private byte[]? _sessionInfo;
    private int _sessionInfoRevision;
    private int _sessionInfoAt = -1;
    private bool _rereadSessionInfo;

    public IrsdkMemoryParser(IReadOnlyMemoryReader reader)
    {
        _reader = reader;
        if (reader.Capacity < FixedHeaderSize || reader.Capacity > MaximumMappedBytes)
            throw new MalformedTelemetryException($"Mapped capacity {reader.Capacity} is outside the safe range.");
    }

    /// <summary>
    /// Decodes one frame, or returns null when the sim rewrote the telemetry buffer
    /// under every attempt to copy it.
    ///
    /// Null is an ordinary outcome and not a fault - it is what iRacing's own client
    /// reports as "no new data" - and the caller's answer is to wait for the sim's next
    /// frame. Returning a frame anyway would mean handing the lap rules a mixture of two
    /// ticks, which is how a lap reaches the leaderboard carrying the previous lap's time.
    /// </summary>
    /// <summary>
    /// Asks for the session document to be copied out again on the next frame, even
    /// though the sim has not announced a new revision of it.
    ///
    /// The sim rewrites that document in place, so a payload that did not parse is
    /// usually one caught half-written - and retrying the cached bytes could only fail
    /// the same way. This is the caller's way of saying the copy it was given was no
    /// use to it. Nothing else re-reads a revision already read.
    /// </summary>
    public void RefreshSessionInfo() => _rereadSessionInfo = true;

    public IrsdkFrame? Parse(IReadOnlySet<string> watchedVariables)
    {
        Span<byte> header = stackalloc byte[FixedHeaderSize];
        ReadChecked(0, header);

        var layoutVersion = ReadInt(header, 0);
        if (layoutVersion != SupportedLayoutVersion)
            throw new UnsupportedTelemetryFormatException(layoutVersion, SupportedLayoutVersion);

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
        Require(bufferLength > 0 && bufferLength <= _reader.Capacity,
            "Buffer length must be positive and within the mapping.");
        ValidateRange(FixedHeaderSize, checked(bufferCount * BufferHeaderSize), "buffer headers");
        ValidateRange(variableHeaderOffset, checked(variableCount * VariableHeaderSize), "variable headers");

        var variables = ReadChannelTable(variableHeaderOffset, variableCount, bufferLength);
        if (!TryReadStableBuffer(bufferCount, bufferLength, out var tickCount)) return null;
        var values = ParseWatchedValues(variables, watchedVariables, _snapshot.AsSpan(0, bufferLength));
        var sessionBytes = ReadSessionInfo(sessionInfoOffset, sessionInfoLength, sessionInfoUpdate);

        return new IrsdkFrame(
            IsConnected: (status & 1) != 0,
            TickCount: tickCount,
            TickRate: tickRate,
            SessionInfoUpdate: sessionInfoUpdate,
            Variables: variables,
            Values: values,
            SessionInfoBytes: sessionBytes);
    }

    /// <summary>
    /// The sim's channel table: where each named channel sits inside a telemetry buffer
    /// and how to read it.
    ///
    /// The table is read from shared memory on every frame, because iRacing rewrites it
    /// when the customer changes car and a reader still holding the old one would read
    /// every channel at an offset that now belongs to something else - with every value
    /// still a plausible number. Reading it is a few tens of kilobytes of memory copy;
    /// what actually costs is decoding it, several hundred records and three times as
    /// many strings, so that is done only when the bytes are not the ones already
    /// decoded. The comparison is against the copy the current decode came from, so the
    /// two can never disagree.
    /// </summary>
    private IReadOnlyDictionary<string, IrsdkVariable> ReadChannelTable(int baseOffset, int count, int bufferLength)
    {
        var size = checked(count * VariableHeaderSize);
        if (_channelTableScratch.Length < size) _channelTableScratch = new byte[size];
        var table = _channelTableScratch.AsSpan(0, size);
        ReadChecked(baseOffset, table);

        // The size has to match as well as the bytes: a sim that republishes fewer
        // channels leaves the ones it dropped byte-identical in front of the new count,
        // and a decode kept on that evidence would report channels nothing publishes any
        // more - and read them at offsets that now belong to something else.
        if (_channels is not null
            && _channelsBufferLength == bufferLength
            && _channelTableSize == size
            && table.SequenceEqual(_channelTable.AsSpan(0, size)))
            return _channels;

        var channels = ParseChannelTable(table, count, bufferLength);
        (_channelTable, _channelTableScratch) = (_channelTableScratch, _channelTable);
        _channels = channels;
        _channelsBufferLength = bufferLength;
        _channelTableSize = size;
        return channels;
    }

    private Dictionary<string, IrsdkVariable> ParseChannelTable(ReadOnlySpan<byte> table, int count, int bufferLength)
    {
        var variables = new Dictionary<string, IrsdkVariable>(count, StringComparer.Ordinal);

        for (var index = 0; index < count; index++)
        {
            var bytes = table.Slice(index * VariableHeaderSize, VariableHeaderSize);
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

            variables.Add(name, new IrsdkVariable(
                (IrsdkVariableType)typeNumber,
                valueOffset,
                elementCount,
                bytes[12] != 0,
                name,
                ReadFixedString(bytes.Slice(48, 64)),
                ReadFixedString(bytes.Slice(112, 32))));
        }

        return variables;
    }

    /// <summary>
    /// The session document, copied out only when the sim says it is a different one.
    ///
    /// This is the sim's own change signal, and the only consumer of these bytes -
    /// <see cref="IRacingTelemetrySource"/> - already ignores a payload arriving under a
    /// revision it has read, so copying hundreds of kilobytes at 60 Hz to find out
    /// nothing changed buys nothing and lands on the large-object heap on the way.
    ///
    /// The returned array belongs to the parser and is handed out again unchanged for as
    /// long as the revision holds: read it, do not write into it.
    /// </summary>
    private byte[]? ReadSessionInfo(int offset, int length, int revision)
    {
        if (length == 0)
        {
            _sessionInfo = null;
            return null;
        }

        if (!_rereadSessionInfo
            && _sessionInfo is { } cached
            && cached.Length == length
            && _sessionInfoRevision == revision
            && _sessionInfoAt == offset)
            return cached;

        var document = new byte[length];
        ReadChecked(offset, document);
        _sessionInfo = document;
        _sessionInfoRevision = revision;
        _sessionInfoAt = offset;
        _rereadSessionInfo = false;
        return document;
    }

    /// <summary>
    /// Copies the newest telemetry buffer and proves the sim did not write into it
    /// while the copy was in flight.
    ///
    /// The sim publishes at 60 Hz into a rotation of buffers, so it comes back around
    /// to any one of them within a few frames. A reader delayed by that much - a garbage
    /// collection pause, or the machine's scheduler favouring the simulator, both routine
    /// on a rig - reads part of one tick and part of the next. Nothing about the result
    /// looks wrong: every value is a plausible number, so it reaches the lap rules as a
    /// lap the customer never drove.
    ///
    /// Checking the buffer's tick before and after the copy is what rules that out, and
    /// it is why the copy is one contiguous read rather than a read per channel: the
    /// shorter the window, the less often the retry is needed at all.
    ///
    /// The copied buffer must also still be the newest one afterwards, which iRacing's
    /// own client does not check and which a reader stalled long enough needs. The sim
    /// publishes a buffer's data before it stamps the tick that claims it, so a writer
    /// that has come all the way back around is part-way through overwriting a buffer
    /// whose tick has not moved yet - the one arrangement where reading the tick twice
    /// says nothing. It cannot be back there without having stamped every other buffer
    /// with a higher tick first, so "still the newest" catches it.
    ///
    /// Being wrong in this direction is free: the answer is to read the next frame 16
    /// milliseconds later, and the channels the lap rules watch hold their values for a
    /// whole lap rather than for one frame.
    /// </summary>
    private bool TryReadStableBuffer(int bufferCount, int bufferLength, out int tickCount)
    {
        if (_snapshot.Length < bufferLength) _snapshot = new byte[bufferLength];
        var destination = _snapshot.AsSpan(0, bufferLength);

        for (var attempt = 0; attempt < StableCopyAttempts; attempt++)
        {
            var newest = FindLatestBuffer(bufferCount, bufferLength);
            ReadChecked(newest.BufferOffset, destination);
            if (FindLatestBuffer(bufferCount, bufferLength) != newest) continue;
            tickCount = newest.TickCount;
            return true;
        }

        tickCount = 0;
        return false;
    }

    private (int Index, int TickCount, int BufferOffset) FindLatestBuffer(int bufferCount, int bufferLength)
    {
        Span<byte> descriptor = stackalloc byte[BufferHeaderSize];
        var latestIndex = -1;
        var latestTick = int.MinValue;
        var latestOffset = -1;

        for (var index = 0; index < bufferCount; index++)
        {
            ReadChecked(checked(FixedHeaderSize + index * BufferHeaderSize), descriptor);
            var tick = ReadInt(descriptor, 0);
            var offset = ReadInt(descriptor, 4);
            if (!InRange(offset, bufferLength))
                throw new MalformedTelemetryException($"The telemetry buffer {index} range is outside shared memory.");
            if (tick > latestTick)
            {
                latestIndex = index;
                latestTick = tick;
                latestOffset = offset;
            }
        }

        Require(latestOffset >= 0, "No telemetry buffer was available.");
        return (latestIndex, latestTick, latestOffset);
    }

    private static IReadOnlyDictionary<string, object?> ParseWatchedValues(
        IReadOnlyDictionary<string, IrsdkVariable> variables,
        IReadOnlySet<string> watched,
        ReadOnlySpan<byte> buffer)
    {
        var values = new Dictionary<string, object?>(watched.Count, StringComparer.Ordinal);

        foreach (var name in watched)
        {
            if (!variables.TryGetValue(name, out var variable))
            {
                values[name] = null;
                continue;
            }

            var size = TypeSizes[(int)variable.Type];
            if ((long)variable.Offset + size > buffer.Length)
                throw new MalformedTelemetryException($"Channel '{name}' points past the end of the telemetry buffer.");
            var target = buffer.Slice(variable.Offset, size);
            values[name] = variable.Type switch
            {
                IrsdkVariableType.Char => (char)target[0],
                IrsdkVariableType.Bool => target[0] != 0,
                IrsdkVariableType.Int => BinaryPrimitives.ReadInt32LittleEndian(target),
                IrsdkVariableType.BitField => BinaryPrimitives.ReadUInt32LittleEndian(target),
                IrsdkVariableType.Float => BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(target)),
                IrsdkVariableType.Double => BitConverter.Int64BitsToDouble(BinaryPrimitives.ReadInt64LittleEndian(target)),
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
        if (!InRange(offset, length))
            throw new MalformedTelemetryException($"The {label} range is outside shared memory.");
    }

    /// <summary>
    /// Whether a declared range lies inside the mapping.
    ///
    /// Separate from the message so the message is only built when the range is bad.
    /// This is checked several times per frame and the frames arrive sixty times a
    /// second: an interpolated string constructed to describe a failure that did not
    /// happen was most of what a healthy frame allocated, and allocation on this path is
    /// what produces the collection pauses that leave a read half-done while the sim
    /// publishes underneath it.
    /// </summary>
    private bool InRange(long offset, long length)
    {
        try
        {
            return offset >= 0 && length >= 0 && checked(offset + length) <= _reader.Capacity;
        }
        catch (OverflowException)
        {
            return false;
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
