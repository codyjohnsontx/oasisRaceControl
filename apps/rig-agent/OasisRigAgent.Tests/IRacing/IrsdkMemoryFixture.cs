using System.Buffers.Binary;
using System.Text;
using OasisRigAgent.Core.IRacing;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>Stands in for the sim's mapping so the parser can be exercised with
/// both well-formed and hostile bytes on any operating system.</summary>
internal sealed class ByteArrayMemoryReader : IReadOnlyMemoryReader
{
    private readonly byte[] _bytes;
    public ByteArrayMemoryReader(byte[] bytes) => _bytes = bytes;
    public long Capacity => _bytes.Length;
    public void Read(long offset, Span<byte> destination) =>
        _bytes.AsSpan(checked((int)offset), destination.Length).CopyTo(destination);
}

/// <summary>Builds a shared-memory image in the sim's layout, so tests can write
/// exactly the frame - valid or malformed - that a scenario needs.</summary>
internal sealed class IrsdkMemoryFixture
{
    internal const int VariableHeadersOffset = 1024;
    internal const int SessionInfoOffset = 4096;
    internal const int BufferOffset = 8192;
    internal const int BufferLength = 4096;

    internal byte[] Bytes { get; }
    private readonly int _headersAt;
    private readonly int _sessionInfoAt;
    private readonly int _bufferAt;
    private readonly int _bufferLength;
    private int _variableCount;

    internal IrsdkMemoryFixture()
        : this(16 * 1024, VariableHeadersOffset, SessionInfoOffset, BufferOffset, BufferLength)
    {
    }

    /// <summary>
    /// A mapping laid out to whatever size a scenario needs. The sim's real one holds a
    /// few hundred channels and a session document measured in tens of kilobytes, which
    /// is what the per-frame cost of reading it is worth measuring against; the default
    /// layout above is deliberately tiny so a hostile-offset test can reach every edge
    /// of it.
    /// </summary>
    internal IrsdkMemoryFixture(int capacity, int headersAt, int sessionInfoAt, int bufferAt, int bufferLength)
    {
        Bytes = new byte[capacity];
        _headersAt = headersAt;
        _sessionInfoAt = sessionInfoAt;
        _bufferAt = bufferAt;
        _bufferLength = bufferLength;
        WriteInt(0, 2);                     // SDK version
        WriteInt(4, 1);                     // status: connected
        WriteInt(8, 60);                    // tick rate
        WriteInt(12, 1);                    // session metadata update number
        WriteInt(24, 0);                    // variable count, maintained by AddVariable
        WriteInt(28, _headersAt);
        WriteInt(32, 1);                    // buffer count
        WriteInt(36, _bufferLength);
        WriteInt(48, 100);                  // latest buffer tick
        WriteInt(52, _bufferAt);
        SetSessionInfo("WeekendInfo:\n TrackName: test\n");
    }

    internal IrsdkMemoryFixture SetSessionInfo(string value)
    {
        Array.Clear(Bytes, _sessionInfoAt, _bufferAt - _sessionInfoAt);
        var bytes = Encoding.UTF8.GetBytes(value);
        bytes.CopyTo(Bytes.AsSpan(_sessionInfoAt));
        WriteInt(16, bytes.Length);
        WriteInt(20, _sessionInfoAt);
        return this;
    }

    /// <summary>
    /// The document the sim is part-way through writing: it has already declared how
    /// long the finished one will be, and only the first <paramref name="written"/>
    /// bytes of it have landed. This is what a reader that gets there first sees.
    /// </summary>
    internal IrsdkMemoryFixture SetPartialSessionInfo(string value, int written)
    {
        Array.Clear(Bytes, _sessionInfoAt, _bufferAt - _sessionInfoAt);
        var bytes = Encoding.UTF8.GetBytes(value);
        bytes.AsSpan(0, written).CopyTo(Bytes.AsSpan(_sessionInfoAt));
        WriteInt(16, bytes.Length);
        WriteInt(20, _sessionInfoAt);
        return this;
    }

    /// <summary>Announces a new revision of the session document, as the sim does when
    /// it republishes one.</summary>
    internal IrsdkMemoryFixture AnnounceSessionInfo(int revision)
    {
        WriteInt(12, revision);
        return this;
    }

    internal IrsdkMemoryFixture AddVariable(string name, IrsdkVariableType type, int valueOffset, object value, int count = 1)
    {
        var header = _headersAt + _variableCount * IrsdkMemoryParser.VariableHeaderSize;
        WriteInt(header, (int)type);
        WriteInt(header + 4, valueOffset);
        WriteInt(header + 8, count);
        WriteFixed(header + 16, 32, name);
        WriteFixed(header + 48, 64, "test description");
        WriteFixed(header + 112, 32, "unit");
        WriteValue(_bufferAt + valueOffset, type, value);
        _variableCount++;
        WriteInt(24, _variableCount);
        return this;
    }

    internal void WriteInt(int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(Bytes.AsSpan(offset, 4), value);

    private void WriteValue(int offset, IrsdkVariableType type, object value)
    {
        switch (type)
        {
            case IrsdkVariableType.Char: Bytes[offset] = Convert.ToByte(value); break;
            case IrsdkVariableType.Bool: Bytes[offset] = Convert.ToBoolean(value) ? (byte)1 : (byte)0; break;
            case IrsdkVariableType.Int: WriteInt(offset, Convert.ToInt32(value)); break;
            case IrsdkVariableType.BitField:
                BinaryPrimitives.WriteUInt32LittleEndian(Bytes.AsSpan(offset, 4), Convert.ToUInt32(value)); break;
            case IrsdkVariableType.Float:
                WriteInt(offset, BitConverter.SingleToInt32Bits(Convert.ToSingle(value))); break;
            case IrsdkVariableType.Double:
                BinaryPrimitives.WriteInt64LittleEndian(Bytes.AsSpan(offset, 8), BitConverter.DoubleToInt64Bits(Convert.ToDouble(value))); break;
        }
    }

    private void WriteFixed(int offset, int length, string value)
    {
        var encoded = Encoding.Latin1.GetBytes(value);
        encoded.AsSpan(0, Math.Min(encoded.Length, length - 1)).CopyTo(Bytes.AsSpan(offset, length));
    }
}

/// <summary>
/// The same window, read by a thread that is genuinely racing the writer. The barrier
/// is the test's own concern rather than the parser's: production reads go through a
/// memory-mapped view, and this keeps the assertion about the copy-and-check protocol
/// instead of about how one machine happens to order two plain array reads.
/// </summary>
internal sealed class OrderedMemoryReader : IReadOnlyMemoryReader
{
    private readonly byte[] _bytes;
    internal OrderedMemoryReader(byte[] bytes) => _bytes = bytes;
    public long Capacity => _bytes.Length;

    public void Read(long offset, Span<byte> destination)
    {
        Thread.MemoryBarrier();
        _bytes.AsSpan(checked((int)offset), destination.Length).CopyTo(destination);
        Thread.MemoryBarrier();
    }
}

/// <summary>
/// The sim rewriting its telemetry buffer while the agent is part-way through
/// reading it - the one thing about this mapping that a static byte array cannot
/// reproduce, and the reason iRacing's own reader copies the buffer and then
/// proves the tick did not move.
///
/// The sim publishes at 60 Hz into a rotation of buffers, so it comes back around
/// to the one being read every few frames. A reader that is late by that much - a
/// garbage collection pause, or the scheduler favouring the sim on a busy rig -
/// reads part of one tick and part of another.
/// </summary>
internal sealed class TearingMemoryReader : IReadOnlyMemoryReader
{
    private readonly byte[] _bytes;
    private readonly Action _publishNextTick;
    private readonly int _tearAfterReads;
    private int _readsInsideBuffer;

    /// <param name="publishNextTick">What the sim writes when it catches up with the
    /// reader. Must move the buffer descriptor's tick, as the real sim does.</param>
    /// <param name="tearAfterReads">How many reads from inside the telemetry buffer are
    /// served from the current tick before the sim publishes the next one. One tears
    /// between the first channel read and every channel after it, whichever order the
    /// parser happens to read them in.</param>
    /// <param name="maxTears">How many times the sim gets in the way. One models the
    /// ordinary race; a large number models a reader that never gets a clean copy.</param>
    internal TearingMemoryReader(
        byte[] bytes,
        Action publishNextTick,
        int tearAfterReads = 1,
        int maxTears = 1)
    {
        _bytes = bytes;
        _publishNextTick = publishNextTick;
        _tearAfterReads = tearAfterReads;
        MaxTears = maxTears;
    }

    /// <summary>How many more times the sim may publish underneath a read. Settable so a
    /// test can let a rig read cleanly and then take that away from it.</summary>
    internal int MaxTears { get; set; }

    /// <summary>
    /// Whether the sim gets in before the bytes are taken rather than after. Both are the
    /// same event - the sim writing during a read - and which side of the copy it lands on
    /// decides whether the copy comes away stale or half-rewritten.
    /// </summary>
    internal bool PublishBeforeRead { get; set; }

    /// <summary>How many times the sim published underneath a read in progress.</summary>
    internal int Tears { get; private set; }

    public long Capacity => _bytes.Length;

    public void Read(long offset, Span<byte> destination)
    {
        var interrupted = offset >= IrsdkMemoryFixture.BufferOffset
            && Tears < MaxTears
            && ++_readsInsideBuffer >= _tearAfterReads;

        if (interrupted)
        {
            _readsInsideBuffer = 0;
            Tears++;
            if (PublishBeforeRead) _publishNextTick();
        }

        _bytes.AsSpan(checked((int)offset), destination.Length).CopyTo(destination);

        if (interrupted && !PublishBeforeRead) _publishNextTick();
    }
}
