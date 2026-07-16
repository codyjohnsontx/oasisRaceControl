using System.IO.MemoryMappedFiles;
using OasisSpike;

namespace OasisSpike.Tests;

public sealed class WindowsReadOnlyIntegrationTests
{
    [Fact]
    public void ReaderObservesNamedMapWithoutChangingProducerBytes()
    {
        if (!OperatingSystem.IsWindows()) return;

        var testId = Guid.NewGuid().ToString("N");
        var memoryMapName = $"Local\\OasisSpike.Tests.Map.{testId}";
        var dataEventName = $"Local\\OasisSpike.Tests.Event.{testId}";
        var fixture = new MemoryFixture().AddVariable("Lap", IrracingVariableType.Int, 0, 7);
        using var map = MemoryMappedFile.CreateOrOpen(memoryMapName, fixture.Bytes.Length, MemoryMappedFileAccess.ReadWrite);
        using var view = map.CreateViewAccessor(0, fixture.Bytes.Length, MemoryMappedFileAccess.ReadWrite);
        view.WriteArray(0, fixture.Bytes, 0, fixture.Bytes.Length);
        view.Flush();
        using var dataEvent = new EventWaitHandle(false, EventResetMode.AutoReset, dataEventName);
        using var observed = new ManualResetEventSlim(false);
        using var source = new WindowsIrracingTelemetrySource(memoryMapName, dataEventName);
        source.Telemetry += _ => observed.Set();

        source.Start();
        for (var attempt = 0; attempt < 20 && !observed.IsSet; attempt++)
        {
            dataEvent.Set();
            observed.Wait(TimeSpan.FromMilliseconds(100));
        }
        source.Stop();

        Assert.True(observed.IsSet);
        var after = new byte[fixture.Bytes.Length];
        view.ReadArray(0, after, 0, after.Length);
        Assert.Equal(fixture.Bytes, after);
    }
}
