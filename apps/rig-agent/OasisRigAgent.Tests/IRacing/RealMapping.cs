using System.IO.MemoryMappedFiles;
using OasisRigAgent.Core.IRacing;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// A shared-memory mapping the operating system really made, with the simulator's
/// image published into it and the agent reading it through the reader it uses on a
/// rig (<see cref="MappedViewReader"/>).
///
/// Every other test in this folder hands the parser a byte array, which is the right
/// way to drive hostile bytes and lap rules but is not what a venue computer reads.
/// A mapping has behaviour an array does not: the view is at least as large as the
/// mapping and on Windows is rounded up to whole pages, a read that runs off the end
/// comes back short instead of throwing, and the publisher goes on writing into the
/// same pages while the agent reads them. This is what puts those behaviours under
/// the production code rather than under a stand-in.
///
/// Anonymous rather than named because a named mapping is a Windows-only feature -
/// .NET refuses one outright on macOS and Linux - and the point of this fixture is
/// that it runs wherever CI runs. The named half, which is how the agent finds
/// iRacing in the first place, is proved on real Windows by
/// <see cref="WindowsSimAttachmentTests"/>.
/// </summary>
internal sealed class RealMapping : IDisposable
{
    private readonly MemoryMappedFile _map;
    private readonly MemoryMappedViewAccessor _simsView;
    private readonly MemoryMappedViewAccessor _agentsView;

    /// <param name="capacity">How large the mapping is. Deliberately settable apart
    /// from the image published into it, because that is the interesting case: the
    /// sim's image is smaller than the region the agent is handed.</param>
    internal RealMapping(long capacity)
    {
        _map = MemoryMappedFile.CreateNew(mapName: null, capacity);
        _simsView = _map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.ReadWrite);
        _agentsView = _map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
        Reader = new MappedViewReader(_agentsView);
    }

    /// <summary>What the agent reads the mapping with. The production type.</summary>
    internal MappedViewReader Reader { get; }

    /// <summary>What the agent is told the mapping's size is, which is not the same
    /// as what was asked for or what the sim published into it.</summary>
    internal long Capacity => _agentsView.Capacity;

    /// <summary>Writes the sim's current image into the mapping, as the simulator
    /// publishing a frame does.</summary>
    internal RealMapping Publish(byte[] image)
    {
        _simsView.WriteArray(0, image, 0, image.Length);
        return this;
    }

    public void Dispose()
    {
        _agentsView.Dispose();
        _simsView.Dispose();
        _map.Dispose();
    }
}

/// <summary>
/// One attachment to <see cref="RealMapping"/>, so the whole live path -
/// <see cref="IRacingTelemetrySource"/>, <see cref="IrsdkMemoryParser"/>, the lap
/// rules - can be driven against a mapping the operating system made.
/// </summary>
internal sealed class RealMappingConnectionFactory : ISimConnectionFactory
{
    private readonly FakeSim _sim;
    private readonly RealMapping _mapping;

    internal RealMappingConnectionFactory(FakeSim sim, RealMapping mapping)
    {
        _sim = sim;
        _mapping = mapping;
        _mapping.Publish(_sim.Bytes);
    }

    /// <summary>Whether iRacing is running. Flipping it closes and re-opens the sim
    /// under the agent, as <see cref="FakeSimConnectionFactory"/> does.</summary>
    internal bool SimIsRunning { get; set; } = true;

    /// <summary>Copies whatever the fake sim has been driven to into the mapping. The
    /// test calls this instead of the sim doing it, so a frame the agent must not see
    /// yet can be staged.</summary>
    internal void PublishFrame() => _mapping.Publish(_sim.Bytes);

    public ISimConnection? TryConnect() =>
        SimIsRunning ? new RealMappingConnection(_mapping.Reader) : null;

    private sealed class RealMappingConnection : ISimConnection
    {
        internal RealMappingConnection(IReadOnlyMemoryReader reader) => Reader = reader;
        public IReadOnlyMemoryReader Reader { get; }
        public bool WaitForFrame(TimeSpan timeout) => true;
        public void Dispose() { }
    }
}
