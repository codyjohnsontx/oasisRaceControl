using System.Text.Json;
using OasisSpike;

namespace OasisSpike.Tests;

public sealed class LogBudgetTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "oasis-spike-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public void AllowsOnlyFixedOutputNames()
    {
        using var logs = new LogBudget(_directory, 1024 * 1024);
        Assert.Throws<IOException>(() => logs.WriteTextFile("../escape.txt", "no"));
        Assert.Throws<IOException>(() => logs.WriteTextFile("arbitrary.txt", "no"));
        logs.WriteTextFile("telemetry-vars.txt", "ok");
        Assert.True(File.Exists(Path.Combine(_directory, "telemetry-vars.txt")));
    }

    [Fact]
    public void EnforcesTotalByteBudget()
    {
        using var logs = new LogBudget(_directory, 64);
        Assert.Throws<LogLimitException>(() => logs.WriteTextFile("telemetry-vars.txt", new string('x', 65)));
    }

    [Fact]
    public void ConcurrentJsonWritesRemainCompleteLines()
    {
        using var logs = new LogBudget(_directory, 1024 * 1024);
        Parallel.For(0, 100, index => logs.WriteJsonLine("events.jsonl", new { index }));
        var lines = File.ReadAllLines(Path.Combine(_directory, "events.jsonl"));
        Assert.Equal(100, lines.Length);
        foreach (var line in lines) Assert.NotNull(JsonDocument.Parse(line));
    }

    [Fact]
    public void SessionFilenameRangeIsBounded()
    {
        using var logs = new LogBudget(_directory, 1024 * 1024);
        logs.WriteFile("sessioninfo-001.yaml", "test"u8);
        Assert.Throws<IOException>(() => logs.WriteFile("sessioninfo-000.yaml", "no"u8));
        Assert.Throws<IOException>(() => logs.WriteFile("sessioninfo-257.yaml", "no"u8));
    }

    [Fact]
    public void DiskWriteFailureIsSurfacedInsteadOfIgnored()
    {
        using var logs = new LogBudget(_directory, 1024 * 1024);
        Directory.CreateDirectory(Path.Combine(_directory, "events.jsonl"));
        var error = Record.Exception(() => logs.WriteJsonLine("events.jsonl", new { value = 1 }));
        Assert.True(error is IOException or UnauthorizedAccessException, error?.ToString());
    }

    [Fact]
    public void ManifestReplacementIsCompleteAndLeavesNoTemporaryFile()
    {
        using var logs = new LogBudget(_directory, 1024 * 1024);
        logs.WriteManifest(new { state = "running" });
        logs.WriteManifest(new { state = "stopped" });

        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(_directory, "run-manifest.json")));
        Assert.Equal("stopped", manifest.RootElement.GetProperty("state").GetString());
        Assert.Single(Directory.GetFiles(_directory));
    }

    [Fact]
    public void ManifestBudgetTracksShrinkAndRegrowthByOnDiskSize()
    {
        using var logs = new LogBudget(_directory, 100);
        var hundredByteManifest = new string('x', 98 - Environment.NewLine.Length);
        var tenByteManifest = new string('x', 8 - Environment.NewLine.Length);

        logs.WriteManifest(hundredByteManifest);
        Assert.Equal(100, logs.BytesWritten);
        logs.WriteManifest(tenByteManifest);
        Assert.Equal(10, logs.BytesWritten);
        logs.WriteManifest(hundredByteManifest);

        Assert.Equal(100, logs.BytesWritten);
        Assert.Equal(100, new FileInfo(Path.Combine(_directory, "run-manifest.json")).Length);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory)) Directory.Delete(_directory, recursive: true);
    }
}
