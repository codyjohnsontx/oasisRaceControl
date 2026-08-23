using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// A rig runs unattended with nobody watching a console, so "what did it say at
/// the time" has to still be on the machine hours later - and has to stay
/// bounded, because nobody visits twenty-plus machines to clear a log folder.
/// </summary>
public sealed class AgentLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"oasis-log-{Guid.NewGuid():N}");

    [Fact]
    public void Lines_are_on_disk_as_soon_as_they_are_written()
    {
        // The case worth logging for is the agent that was killed or lost power.
        // A line still sitting in a buffer is a line that was never written.
        using var log = new RotatingFileLog(_dir);

        ((IAgentLog)log).Warn("sim stopped publishing frames");

        var text = File.ReadAllText(log.ActivePath);
        Assert.Contains("sim stopped publishing frames", text);
        Assert.Contains("warn", text);
    }

    [Fact]
    public void Every_line_is_timestamped_in_utc_so_rigs_can_be_compared_with_each_other()
    {
        using var log = new RotatingFileLog(_dir);

        ((IAgentLog)log).Info("hello");

        var line = File.ReadAllLines(log.ActivePath)[0];
        Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\s+info\s+hello$", line);
    }

    [Fact]
    public void A_restart_appends_rather_than_erasing_what_the_last_run_said()
    {
        using (var first = new RotatingFileLog(_dir)) ((IAgentLog)first).Info("before the restart");
        using (var second = new RotatingFileLog(_dir)) ((IAgentLog)second).Info("after the restart");

        var text = File.ReadAllText(Path.Combine(_dir, "agent.log"));
        Assert.Contains("before the restart", text);
        Assert.Contains("after the restart", text);
    }

    [Fact]
    public void The_log_folder_stays_bounded_over_a_long_unattended_run()
    {
        using var log = new RotatingFileLog(_dir, maxBytes: 512, keepFiles: 2);

        for (var i = 0; i < 400; i++) ((IAgentLog)log).Info($"line {i} " + new string('x', 100));

        var files = Directory.GetFiles(_dir, "*.log");
        Assert.True(files.Length <= 3, $"expected at most the active log plus 2 archives, got {files.Length}");
        Assert.All(files, f => Assert.True(new FileInfo(f).Length < 512 * 4));
        // The most recent history is what a rig is diagnosed from, so it is the
        // oldest that gets dropped.
        var kept = string.Concat(files.Select(File.ReadAllText));
        Assert.Contains("line 399 ", kept);
        Assert.DoesNotContain("line 0 ", kept);
    }

    [Fact]
    public void Rotation_survives_the_folder_being_written_to_from_elsewhere()
    {
        using var log = new RotatingFileLog(_dir, maxBytes: 256, keepFiles: 2);
        File.WriteAllText(Path.Combine(_dir, "agent-20200101T000000000.log"), "someone else's file");

        for (var i = 0; i < 50; i++) ((IAgentLog)log).Info(new string('y', 80));

        Assert.True(File.Exists(log.ActivePath));
    }

    [Fact]
    public async Task Concurrent_writers_do_not_lose_or_interleave_lines()
    {
        // Laps arrive on the telemetry thread while the heartbeat, poll, and
        // flush loops all report from their own.
        using var log = new RotatingFileLog(_dir);
        var writers = Enumerable.Range(0, 8).Select(w => Task.Run(() =>
        {
            for (var i = 0; i < 50; i++) ((IAgentLog)log).Info($"writer {w} line {i}");
        }));

        await Task.WhenAll(writers);

        var lines = File.ReadAllLines(log.ActivePath);
        Assert.Equal(400, lines.Length);
        Assert.All(lines, l => Assert.Matches(@"^\S+  \S+\s+writer \d line \d+$", l));
    }

    [Fact]
    public void A_log_that_cannot_write_never_takes_the_agent_down()
    {
        using var log = new CompositeLog(new ThrowingLog());

        // A full disk is a reason to lose the log, never a reason to stop
        // scoring laps.
        ((IAgentLog)log).Error("the rig still has to keep running");
    }

    [Fact]
    public void One_failing_log_does_not_silence_the_others()
    {
        var recording = new RecordingLog();
        using var log = new CompositeLog(new ThrowingLog(), recording);

        ((IAgentLog)log).Error("disk full on the console sink");

        Assert.Contains("disk full on the console sink", recording.Lines);
    }

    private sealed class ThrowingLog : IAgentLog
    {
        public void Write(string level, string message) => throw new IOException("no space left on device");
    }

    private sealed class RecordingLog : IAgentLog
    {
        public List<string> Lines { get; } = new();
        public void Write(string level, string message) => Lines.Add(message);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); } catch { }
    }
}
