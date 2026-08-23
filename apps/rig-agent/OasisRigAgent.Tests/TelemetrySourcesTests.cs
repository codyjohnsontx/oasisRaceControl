using OasisRigAgent.Core;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Which source a machine gets. The rigs are Windows and read the live simulator;
/// anything else honestly reports no sim rather than failing to start, so the agent
/// can be worked on from a developer machine.
/// </summary>
public sealed class TelemetrySourcesTests
{
    [Fact]
    public void ARigReadsTheLiveSimAndAnyOtherMachineReportsNoSim()
    {
        var source = TelemetrySources.CreateLive(rigNumber: 7);
        try
        {
            if (OperatingSystem.IsWindows()) Assert.IsType<IRacingTelemetrySource>(source);
            else Assert.IsType<NullTelemetrySource>(source);

            // Nothing is read until it is started, so building one is safe on a rig with
            // iRacing closed - which is how every venue machine boots.
            Assert.False(source.SimRunning);
        }
        finally
        {
            (source as IDisposable)?.Dispose();
        }
    }
}
