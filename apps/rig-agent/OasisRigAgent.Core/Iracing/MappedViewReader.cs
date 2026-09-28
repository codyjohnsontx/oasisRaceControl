using System.Buffers;
using System.IO.MemoryMappedFiles;

namespace OasisRigAgent.Core.Iracing;

/// <summary>
/// <see cref="IReadOnlyMemoryReader"/> over a mapped view. Every read is one
/// <c>ReadArray</c> through a pooled buffer: the parser reads each 144-byte
/// variable header on every frame, and a per-byte <c>ReadByte</c> loop acquires
/// and releases the view's pointer once per byte - millions of times a second
/// at 60 Hz, on the PC that is running the sim.
/// </summary>
public sealed class MappedViewReader : IReadOnlyMemoryReader
{
    private readonly MemoryMappedViewAccessor _accessor;
    public MappedViewReader(MemoryMappedViewAccessor accessor) => _accessor = accessor;
    public long Capacity => _accessor.Capacity;

    public void Read(long offset, Span<byte> destination)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(destination.Length);
        try
        {
            var read = _accessor.ReadArray(offset, buffer, 0, destination.Length);
            if (read != destination.Length)
                throw new ArgumentException($"Read {read} of {destination.Length} bytes at offset {offset}.");
            buffer.AsSpan(0, destination.Length).CopyTo(destination);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
