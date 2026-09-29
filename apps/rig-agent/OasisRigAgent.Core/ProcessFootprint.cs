using System.Diagnostics;

namespace OasisRigAgent.Core;

/// <summary>
/// The agent's own CPU and memory, reported on every heartbeat so the promise
/// that it stays out of iRacing's way is checked on every rig, every minute,
/// not only on the day it was measured.
///
/// CPU is the share of ONE core this process used since the previous sample -
/// the same unit as Windows' <c>\Process(OasisRigAgent)\% Processor Time</c>
/// counter, so the two can be compared directly. Memory is the working set.
/// Both come from the process's own accounting: nothing is polled in between,
/// so sampling once a minute costs one Refresh and nothing else.
/// </summary>
public sealed class ProcessFootprint
{
    private readonly Func<(TimeSpan Cpu, long WorkingSetBytes)> _read;
    private readonly Func<long> _clock;
    private TimeSpan _lastCpu;
    private long _lastTimestamp;
    private bool _primed;

    public ProcessFootprint() : this(ReadCurrentProcess, Stopwatch.GetTimestamp) { }

    /// <summary>For tests: the process's counters and a Stopwatch-tick clock.</summary>
    public ProcessFootprint(Func<(TimeSpan Cpu, long WorkingSetBytes)> read, Func<long> clock)
    {
        _read = read;
        _clock = clock;
    }

    /// <summary>CPU percent of one core since the previous call (null on the
    /// first call, which has nothing to measure against), and memory in MB.</summary>
    public (double? CpuPercent, double MemoryMb) Sample()
    {
        var (cpu, workingSet) = _read();
        var now = _clock();
        double? percent = null;
        if (_primed)
        {
            var wall = Stopwatch.GetElapsedTime(_lastTimestamp, now);
            if (wall > TimeSpan.Zero)
                percent = Math.Round(Math.Max(0, (cpu - _lastCpu) / wall * 100), 2);
        }
        _lastCpu = cpu;
        _lastTimestamp = now;
        _primed = true;
        return (percent, Math.Round(workingSet / (1024.0 * 1024.0), 1));
    }

    private static (TimeSpan, long) ReadCurrentProcess()
    {
        using var process = Process.GetCurrentProcess();
        return (process.TotalProcessorTime, process.WorkingSet64);
    }
}
