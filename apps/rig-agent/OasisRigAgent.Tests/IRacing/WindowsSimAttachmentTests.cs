using System.IO.MemoryMappedFiles;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// The agent finding and attaching to a simulator through Windows itself.
///
/// <see cref="WindowsSimConnectionFactory"/> is the only code in the agent that asks
/// the operating system for anything, and until now the only part of it any test
/// reached was <c>CurrentWindowsSession</c>. Everything else - opening the sim's
/// session-local mapping with read rights alone, taking a view of it, opening the
/// frame signal by hand with <c>SYNCHRONIZE</c> and nothing else, waiting on that
/// handle, and letting all three go again - was first executed on a venue computer.
/// Each of those is a claim about Windows rather than about this repository's logic,
/// and every one of them is fleet-wide: they are the same on all twenty-plus rigs, so
/// if any is wrong the whole room reads as "iRacing is not running" and no lap is ever
/// scored.
///
/// These run for real on the Windows runner in <c>.github/workflows/rig-agent.yml</c>,
/// against a mapping and an event this test publishes under names of its own. They do
/// not need iRacing: what is under test is the attachment, and iRacing's contribution
/// to it is a name and some bytes.
/// </summary>
public sealed class WindowsSimAttachmentTests
{
    /// <summary>Names of the shape iRacing uses - session-local, so they resolve in the
    /// signed-in user's own session - made unique so a run cannot collide with another
    /// test, another run, or a simulator that happens to be open.</summary>
    private static (string Map, string Signal) UniqueNames(string scenario) =>
        ($@"Local\OasisTest-{scenario}-{Guid.NewGuid():N}-map",
         $@"Local\OasisTest-{scenario}-{Guid.NewGuid():N}-signal");

    [Fact]
    public void NothingAttachesWhenNoSimIsPublishingUnderThatName()
    {
        if (!OperatingSystem.IsWindows()) return;

        var (map, signal) = UniqueNames("absent");
        var factory = new WindowsSimConnectionFactory(map, signal, windowsSession: () => 1);

        Assert.Null(factory.TryConnect());
        // The ordinary state of a rig between customers, and it must stay ordinary:
        // a reason here would put a permanent fault on the staff dashboard for every
        // machine in the building every night.
        Assert.Null(factory.UnreachableReason);
    }

    [Fact]
    public void TheAgentAttachesToTheSimsOwnNamedMappingAndDecodesItsFrame()
    {
        if (!OperatingSystem.IsWindows()) return;

        var sim = new FakeSim();
        var (name, signal) = UniqueNames("attach");
        using var published = PublishAs(name, signal, sim);
        var factory = new WindowsSimConnectionFactory(name, signal, windowsSession: () => 1);

        using var connection = factory.TryConnect();

        Assert.NotNull(connection);
        // Read rights on the mapping and a read-only view of it are the smallest
        // request that can work, and "can work" is exactly the claim: nothing before
        // this proved a view opened that way is actually readable.
        Assert.True(connection!.Reader.Capacity >= sim.Bytes.Length);
        var frame = new IrsdkMemoryParser(connection.Reader).Parse(LapDetector.WatchedVariables);
        Assert.NotNull(frame);
        Assert.True(frame!.IsConnected);
        Assert.Equal(3, frame.Values["LapCompleted"]);
        Assert.True(TelemetryChannels.Check(frame.Variables).CanScore);
        Assert.Null(factory.UnreachableReason);
    }

    [Fact]
    public void TheAgentWaitsOnTheSimsOwnFrameSignalAndGivesUpWhenItGoesQuiet()
    {
        if (!OperatingSystem.IsWindows()) return;

        var (name, signal) = UniqueNames("signal");
        using var published = PublishAs(name, signal, new FakeSim());
        var factory = new WindowsSimConnectionFactory(name, signal, windowsSession: () => 1);
        using var connection = factory.TryConnect();

        // A quiet sim is the normal state whenever the driver is in a menu, so the
        // wait has to expire rather than hang - the read loop is what notices iRacing
        // has gone away, and it only gets to notice between waits.
        Assert.False(connection!.WaitForFrame(TimeSpan.FromMilliseconds(50)));

        published.RaiseFrameReady();

        // And the handle opened by hand with SYNCHRONIZE alone must genuinely be
        // waitable. .NET's own EventWaitHandle.OpenExisting asks for modify rights
        // too, which would let the agent reset an event the simulator owns; the
        // bespoke open is the whole reason this needs proving on a real machine.
        Assert.True(connection.WaitForFrame(TimeSpan.FromSeconds(5)));
    }

    [Fact]
    public void AttachingDoesNotStopTheSimPublishingItsNextFrame()
    {
        if (!OperatingSystem.IsWindows()) return;

        var sim = new FakeSim();
        var (name, signal) = UniqueNames("live");
        using var published = PublishAs(name, signal, sim);
        var factory = new WindowsSimConnectionFactory(name, signal, windowsSession: () => 1);
        using var connection = factory.TryConnect();
        var parser = new IrsdkMemoryParser(connection!.Reader);

        var before = parser.Parse(LapDetector.WatchedVariables);
        sim.CrossTheLine(9, 135.5f);
        published.Publish(sim);
        var after = parser.Parse(LapDetector.WatchedVariables);

        Assert.Equal(3, before!.Values["LapCompleted"]);
        Assert.Equal(9, after!.Values["LapCompleted"]);
    }

    [Fact]
    public void LettingGoOfTheSimReleasesItsMappingSoIRacingRestartingIsSeenAsANewOne()
    {
        if (!OperatingSystem.IsWindows()) return;

        var (name, signal) = UniqueNames("restart");
        var published = PublishAs(name, signal, new FakeSim());
        var factory = new WindowsSimConnectionFactory(name, signal, windowsSession: () => 1);
        var connection = factory.TryConnect();
        Assert.NotNull(connection);

        connection!.Dispose();
        published.Dispose();

        // Windows keeps a named section alive for as long as anybody holds a handle to
        // it, so an attachment that leaked its handle would keep answering with the
        // mapping of a simulator that has closed - the agent would sit on a dead
        // region reporting a live session for the rest of the day, which is the
        // failure IRacingTelemetrySource detaches to avoid. This is the only place
        // that can show the handle was really let go.
        Assert.Null(factory.TryConnect());
    }

    /// <summary>
    /// Proof that the tests above were executed rather than quietly stepped over.
    ///
    /// They are guarded by a platform check, which returns rather than fails
    /// everywhere else, so on any non-Windows machine they are five green ticks that
    /// asserted nothing. That is the same way <c>OASIS_REQUIRE_DB_TESTS</c> stops the
    /// web suite lying (see <c>AGENTS.md</c>, "What CI enforces, and the way it could
    /// have lied"): the job that is supposed to run them says so, and is failed if it
    /// did not.
    /// </summary>
    [Fact]
    public void TheAttachmentTestsRanOnTheMachineThatSaidTheyWould()
    {
        if (Environment.GetEnvironmentVariable("OASIS_REQUIRE_WINDOWS_SIM_TESTS") != "1") return;

        Assert.True(
            OperatingSystem.IsWindows(),
            "OASIS_REQUIRE_WINDOWS_SIM_TESTS=1 says this job proves the agent's attachment to iRacing "
            + "on a real PC, but it is not running on Windows, so every one of those tests was skipped.");
    }

    private static SimPublication PublishAs(string mapName, string signalName, FakeSim sim)
    {
        var publication = new SimPublication(mapName, signalName, sim.Bytes.Length);
        publication.Publish(sim);
        return publication;
    }

    /// <summary>
    /// Stands where iRacing stands: a named section and a named auto-reset event in
    /// this Windows session, with the sim's image in the section.
    /// </summary>
    private sealed class SimPublication : IDisposable
    {
        private readonly MemoryMappedFile _map;
        private readonly MemoryMappedViewAccessor _view;
        private readonly EventWaitHandle _frameReady;

        internal SimPublication(string mapName, string signalName, int capacity)
        {
            _map = MemoryMappedFile.CreateNew(mapName, capacity);
            _view = _map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.ReadWrite);
            _frameReady = new EventWaitHandle(false, EventResetMode.AutoReset, signalName);
        }

        internal void Publish(FakeSim sim) => _view.WriteArray(0, sim.Bytes, 0, sim.Bytes.Length);

        internal void RaiseFrameReady() => _frameReady.Set();

        public void Dispose()
        {
            _view.Dispose();
            _map.Dispose();
            _frameReady.Dispose();
        }
    }
}
