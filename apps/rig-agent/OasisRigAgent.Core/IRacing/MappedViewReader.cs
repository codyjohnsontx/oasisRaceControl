using System.Buffers;
using System.IO.MemoryMappedFiles;

namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// Reads bytes out of a memory-mapped view of the simulator's shared memory.
///
/// This is the only reader the agent uses on a rig, and it sits directly under
/// <see cref="IrsdkMemoryParser"/>: everything the venue's leaderboards show comes
/// through here. It lives in its own file, outside the Windows-only attachment code
/// that builds it, for one reason - a <see cref="MemoryMappedViewAccessor"/> is not
/// Windows-only, so keeping this separate is what lets the tests exercise the reader
/// production runs against a mapping the operating system really made, on any machine
/// CI has. Held inside the attachment class it was reachable only from Windows and in
/// practice from nothing at all, and the parser above it was proved entirely against a
/// byte array - which is not what a rig reads.
///
/// The two behaviours that a byte array does not have, and that this must therefore
/// get right:
///
/// * <b>A view is at least as large as the mapping, and on Windows it is larger.</b>
///   The size reported back is the mapped region, which Windows rounds up to a whole
///   number of pages, so <see cref="Capacity"/> can exceed the bytes the sim actually
///   published and the tail reads as zeroes. Callers must therefore treat capacity as
///   an upper bound they may not read past, never as a statement about how much the
///   sim published - <see cref="IrsdkMemoryParser"/> checks every declared offset
///   against the sim's own lengths as well.
/// * <b>A read that runs off the end is short rather than loud.</b>
///   <see cref="MemoryMappedViewAccessor.ReadArray{T}"/> clamps at the end of the view
///   and returns how much it copied, so a partly-satisfied read would otherwise be
///   handed to the parser as a frame with a plausible tail of stale bytes. It is turned
///   into a failure here instead, which the parser reports as malformed telemetry.
/// </summary>
public sealed class MappedViewReader : IReadOnlyMemoryReader
{
    private readonly MemoryMappedViewAccessor _accessor;

    /// <param name="accessor">A view of the simulator's mapping. Opened for reading
    /// only on a rig; this type never writes through it whatever it was opened as.</param>
    public MappedViewReader(MemoryMappedViewAccessor accessor) => _accessor = accessor;

    public long Capacity => _accessor.Capacity;

    /// <summary>
    /// Copies <paramref name="destination"/>'s worth of bytes out of the view.
    ///
    /// Every read is copied out before it is looked at, so the parser never holds a
    /// pointer into memory the simulator is rewriting - a value cannot change halfway
    /// through being interpreted. Buffers are rented rather than allocated because this
    /// runs at the sim's frame rate for as long as a customer is driving, and a
    /// collection pause on this path is what leaves a read half-done.
    /// </summary>
    public void Read(long offset, Span<byte> destination)
    {
        if (destination.IsEmpty) return;
        var buffer = ArrayPool<byte>.Shared.Rent(destination.Length);
        try
        {
            var read = _accessor.ReadArray(offset, buffer, 0, destination.Length);
            if (read != destination.Length)
                throw new IOException($"Read {read} of {destination.Length} bytes at offset {offset}.");
            buffer.AsSpan(0, destination.Length).CopyTo(destination);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
}
