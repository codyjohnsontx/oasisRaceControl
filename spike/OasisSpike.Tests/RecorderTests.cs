using System.Text.Json;
using OasisSpike;

namespace OasisSpike.Tests;

public sealed class RecorderTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "oasis-recorder-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void RecordsConnectSessionTelemetryAndLapBoundary()
    {
        var source = new FakeSource();
        using var logs = new LogBudget(_directory, 1024 * 1024);
        using var recorder = new Recorder(source, logs, RecorderMode.Canary, new SafetyLimits(TimeSpan.FromSeconds(5), 1024 * 1024), "test", "commit");
        recorder.Start();
        source.EmitConnected();
        source.EmitSession("WeekendInfo:\n  TrackName: test\n"u8.ToArray());
        source.EmitTelemetry(Values(0, 0, 0, 10f));
        source.EmitTelemetry(Values(1, 1, 0, 61.234f));
        recorder.Stop("test-complete");

        var events = File.ReadAllLines(Path.Combine(_directory, "events.jsonl"));
        Assert.Contains(events, line => line.Contains("CONNECTED", StringComparison.Ordinal));
        Assert.Contains(events, line => line.Contains("SESSION_INFO", StringComparison.Ordinal));
        Assert.Contains(events, line => line.Contains("LAP_BOUNDARY", StringComparison.Ordinal));
        Assert.True(File.Exists(Path.Combine(_directory, "sessioninfo-001.yaml")));
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(_directory, "run-manifest.json")));
        Assert.Equal("test-complete", manifest.RootElement.GetProperty("state").GetString());
    }

    [Fact]
    public void DurationLimitStopsWithoutConsoleInput()
    {
        var source = new FakeSource();
        using var logs = new LogBudget(_directory, 1024 * 1024);
        using var recorder = new Recorder(source, logs, RecorderMode.Canary, new SafetyLimits(TimeSpan.FromMilliseconds(50), 1024 * 1024), "test", "commit");
        recorder.Start();
        Assert.True(SpinWait.SpinUntil(() => recorder.Stopped, TimeSpan.FromSeconds(2)));
        Assert.Equal("duration-limit", recorder.ExitReason);
    }

    [Fact]
    public void SourceFaultProducesSafetyExit()
    {
        var source = new FakeSource();
        using var logs = new LogBudget(_directory, 1024 * 1024);
        using var recorder = new Recorder(source, logs, RecorderMode.Canary, new SafetyLimits(TimeSpan.FromSeconds(5), 1024 * 1024), "test", "commit");
        recorder.Start();
        source.EmitFault(new MalformedTelemetryException("bad map"));
        Assert.True(recorder.Stopped);
        Assert.Equal(RecorderExitCode.MalformedTelemetry, recorder.ExitCode);
    }

    [Fact]
    public void UnexpectedCallbackFailureProducesInternalFailureExit()
    {
        var source = new FakeSource();
        var logs = new LogBudget(_directory, 1024 * 1024);
        using var recorder = new Recorder(source, logs, RecorderMode.Canary, new SafetyLimits(TimeSpan.FromSeconds(5), 1024 * 1024), "test", "commit");
        recorder.Start();
        logs.Dispose();

        source.EmitConnected();

        Assert.True(recorder.Stopped);
        Assert.Equal("internal-failure", recorder.ExitReason);
        Assert.Equal(RecorderExitCode.InternalFailure, recorder.ExitCode);
    }

    [Fact]
    public void DisconnectResetsLapStateWithoutOverwritingVariableDump()
    {
        var source = new FakeSource();
        using var logs = new LogBudget(_directory, 1024 * 1024);
        using var recorder = new Recorder(source, logs, RecorderMode.Canary, new SafetyLimits(TimeSpan.FromSeconds(5), 1024 * 1024), "test", "commit");
        recorder.Start();
        source.EmitTelemetry(Values(10, 10, 4, 50f));
        source.EmitDisconnected();
        source.EmitTelemetry(Values(0, 0, 0, 0f));
        recorder.Stop("test-complete");

        Assert.Equal(RecorderExitCode.Success, recorder.ExitCode);
        Assert.True(File.Exists(Path.Combine(_directory, "telemetry-vars.txt")));
        var events = File.ReadAllLines(Path.Combine(_directory, "events.jsonl"));
        Assert.DoesNotContain(events, line => line.Contains("LAP_COUNTER_RESET", StringComparison.Ordinal));
    }

    [Fact]
    public void SessionCounterRollbackIsRecorded()
    {
        var source = new FakeSource();
        using var logs = new LogBudget(_directory, 1024 * 1024);
        using var recorder = new Recorder(source, logs, RecorderMode.Canary, new SafetyLimits(TimeSpan.FromSeconds(5), 1024 * 1024), "test", "commit");
        recorder.Start();
        source.EmitTelemetry(Values(5, 5, 0, 50f));
        source.EmitTelemetry(Values(0, 0, 0, 0f));
        recorder.Stop("test-complete");

        Assert.Contains(File.ReadAllLines(Path.Combine(_directory, "events.jsonl")),
            line => line.Contains("LAP_COUNTER_RESET", StringComparison.Ordinal));
    }

    private static TelemetrySnapshot Values(int lap, int completed, int incidents, float time)
    {
        var values = Recorder.WatchedVariableNames.ToDictionary(name => name, _ => (object?)null);
        values["Lap"] = lap;
        values["LapCompleted"] = completed;
        values["PlayerCarMyIncidentCount"] = incidents;
        values["LapLastLapTime"] = time;
        values["PlayerTrackSurface"] = 3;
        values["OnPitRoad"] = false;
        values["IsOnTrack"] = true;
        values["IsInGarage"] = false;
        values["SessionTime"] = 1d;
        return new TelemetrySnapshot(lap, 60, 1, new Dictionary<string, TelemetryVariable>(), values);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }

    private sealed class FakeSource : IIrracingTelemetrySource
    {
        public event Action? Connected;
        public event Action? Disconnected;
        public event Action<TelemetrySnapshot>? Telemetry;
        public event Action<SessionInfoSnapshot>? SessionInfo;
        public event Action<Exception>? Faulted;
        public void Start() { }
        public void Stop() { }
        public void Dispose() { }
        internal void EmitConnected() => Connected?.Invoke();
        internal void EmitDisconnected() => Disconnected?.Invoke();
        internal void EmitTelemetry(TelemetrySnapshot value) => Telemetry?.Invoke(value);
        internal void EmitSession(byte[] value) => SessionInfo?.Invoke(new SessionInfoSnapshot(1, value));
        internal void EmitFault(Exception value) => Faulted?.Invoke(value);
    }
}
