using System.Buffers.Binary;
using System.Text;
using OasisSpike;

namespace OasisSpike.Tests;

internal sealed class ByteArrayMemoryReader : IReadOnlyMemoryReader
{
    private readonly byte[] _bytes;
    public ByteArrayMemoryReader(byte[] bytes) => _bytes = bytes;
    public long Capacity => _bytes.Length;
    public void Read(long offset, Span<byte> destination) => _bytes.AsSpan(checked((int)offset), destination.Length).CopyTo(destination);
}

internal sealed class MemoryFixture
{
    internal const int VariableHeadersOffset = 1024;
    internal const int SessionInfoOffset = 4096;
    internal const int BufferOffset = 8192;
    internal const int BufferLength = 4096;
    internal byte[] Bytes { get; } = new byte[16 * 1024];
    private int _variableCount;

    internal MemoryFixture()
    {
        WriteInt(0, 2);                    // SDK version
        WriteInt(4, 1);                    // connected
        WriteInt(8, 60);                   // tick rate
        WriteInt(12, 1);                   // session update
        WriteInt(24, 0);                   // variable count, updated by AddVariable
        WriteInt(28, VariableHeadersOffset);
        WriteInt(32, 1);                   // buffer count
        WriteInt(36, BufferLength);
        WriteInt(48, 100);                 // latest tick
        WriteInt(52, BufferOffset);
        SetSessionInfo("WeekendInfo:\n  TrackName: test\n");
    }

    internal MemoryFixture SetSessionInfo(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        bytes.CopyTo(Bytes.AsSpan(SessionInfoOffset));
        WriteInt(16, bytes.Length);
        WriteInt(20, SessionInfoOffset);
        return this;
    }

    internal MemoryFixture AddVariable(string name, IrracingVariableType type, int valueOffset, object value, int count = 1)
    {
        var header = VariableHeadersOffset + _variableCount * IrracingMemoryParser.VariableHeaderSize;
        WriteInt(header, (int)type);
        WriteInt(header + 4, valueOffset);
        WriteInt(header + 8, count);
        WriteFixed(header + 16, 32, name);
        WriteFixed(header + 48, 64, "test description");
        WriteFixed(header + 112, 32, "unit");
        WriteValue(BufferOffset + valueOffset, type, value);
        _variableCount++;
        WriteInt(24, _variableCount);
        return this;
    }

    internal void WriteInt(int offset, int value) => BinaryPrimitives.WriteInt32LittleEndian(Bytes.AsSpan(offset, 4), value);

    private void WriteValue(int offset, IrracingVariableType type, object value)
    {
        switch (type)
        {
            case IrracingVariableType.Char: Bytes[offset] = Convert.ToByte(value); break;
            case IrracingVariableType.Bool: Bytes[offset] = Convert.ToBoolean(value) ? (byte)1 : (byte)0; break;
            case IrracingVariableType.Int: WriteInt(offset, Convert.ToInt32(value)); break;
            case IrracingVariableType.BitField: BinaryPrimitives.WriteUInt32LittleEndian(Bytes.AsSpan(offset, 4), Convert.ToUInt32(value)); break;
            case IrracingVariableType.Float: WriteInt(offset, BitConverter.SingleToInt32Bits(Convert.ToSingle(value))); break;
            case IrracingVariableType.Double: BinaryPrimitives.WriteInt64LittleEndian(Bytes.AsSpan(offset, 8), BitConverter.DoubleToInt64Bits(Convert.ToDouble(value))); break;
        }
    }

    private void WriteFixed(int offset, int length, string value)
    {
        var encoded = Encoding.Latin1.GetBytes(value);
        encoded.AsSpan(0, Math.Min(encoded.Length, length - 1)).CopyTo(Bytes.AsSpan(offset, length));
    }
}
