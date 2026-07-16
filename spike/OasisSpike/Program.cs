using System.Reflection;
using System.Security.Principal;
using OasisSpike;

return ProgramEntry.Run(args);

internal static class ProgramEntry
{
    internal static int Run(string[] args)
    {
        if (args.Length == 1 && args[0] is "--help" or "-h")
        {
            PrintHelp();
            return (int)RecorderExitCode.Success;
        }

        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine(BuildInfo.Version);
            return (int)RecorderExitCode.Success;
        }

        if (args.Length != 2 || args[0] != "--mode" || !RecorderModeExtensions.TryParse(args[1], out var mode))
        {
            PrintHelp();
            return (int)RecorderExitCode.InvalidArguments;
        }

        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("OasisSpike runs only on Windows.");
            return (int)RecorderExitCode.UnsupportedPlatform;
        }

        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            if (principal.IsInRole(WindowsBuiltInRole.Administrator))
            {
                Console.Error.WriteLine("Safety stop: do not run OasisSpike elevated or as Administrator.");
                return (int)RecorderExitCode.Elevated;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Safety stop: could not verify the Windows user token: {ex.Message}");
            return (int)RecorderExitCode.Elevated;
        }

        using var singleInstance = SingleInstanceGuard.TryAcquire("Local\\OasisRaceControl.OasisSpike");
        if (singleInstance is null)
        {
            Console.Error.WriteLine("Safety stop: another OasisSpike recorder is already running in this user session.");
            return (int)RecorderExitCode.DuplicateInstance;
        }

        var limits = SafetyLimits.For(mode);
        var baseDirectory = Path.GetFullPath(AppContext.BaseDirectory);
        var drive = new DriveInfo(Path.GetPathRoot(baseDirectory)!);
        if (drive.AvailableFreeSpace < SafetyLimits.MinimumFreeBytes)
        {
            Console.Error.WriteLine("Safety stop: the executable volume has less than 500 MiB free.");
            return (int)RecorderExitCode.OutputFailure;
        }

        var runDirectory = RunDirectory.Create(baseDirectory);
        Console.WriteLine("Oasis Race Control — read-only telemetry recorder");
        Console.WriteLine($"Version: {BuildInfo.Version} ({BuildInfo.SourceRevision})");
        Console.WriteLine($"Mode: {mode.ToCliValue()} — hard stop after {limits.MaxDuration.TotalMinutes:0} minutes / {limits.MaxOutputBytes / 1024 / 1024} MiB");
        Console.WriteLine($"Logging only to: {runDirectory}");
        Console.WriteLine("Press M + Enter to add a marker. Press Q + Enter or Ctrl+C to stop.");
        Console.WriteLine();

        try
        {
            using var budget = new LogBudget(runDirectory, limits.MaxOutputBytes);
            using var source = new WindowsIrracingTelemetrySource();
            using var recorder = new Recorder(source, budget, mode, limits, BuildInfo.Version, BuildInfo.SourceRevision);

            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                recorder.Stop("ctrl-c");
            };

            recorder.Start();
            var inputThread = new Thread(() => ReadCommands(recorder))
            {
                IsBackground = true,
                Name = "OasisSpike.ConsoleInput"
            };
            inputThread.Start();
            recorder.WaitForStop();
            Console.WriteLine($"Recorder stopped ({recorder.ExitReason}). Logs are in: {runDirectory}");
            return (int)recorder.ExitCode;
        }
        catch (LogLimitException ex)
        {
            Console.Error.WriteLine($"Safety stop: {ex.Message}");
            return (int)RecorderExitCode.LogLimit;
        }
        catch (MalformedTelemetryException ex)
        {
            Console.Error.WriteLine($"Safety stop: malformed iRacing shared memory: {ex.Message}");
            return (int)RecorderExitCode.MalformedTelemetry;
        }
        catch (IOException ex)
        {
            Console.Error.WriteLine($"Safety stop: output failure: {ex.Message}");
            return (int)RecorderExitCode.OutputFailure;
        }
        catch (UnauthorizedAccessException ex)
        {
            Console.Error.WriteLine($"Safety stop: output access denied: {ex.Message}");
            return (int)RecorderExitCode.OutputFailure;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Safety stop: unexpected recorder failure: {ex}");
            return (int)RecorderExitCode.InternalFailure;
        }
    }

    private static void ReadCommands(Recorder recorder)
    {
        while (!recorder.Stopped)
        {
            var line = Console.ReadLine();
            if (line is null) return;
            if (line.Trim().Equals("q", StringComparison.OrdinalIgnoreCase))
            {
                recorder.Stop("operator-quit");
                return;
            }
            if (line.Trim().Equals("m", StringComparison.OrdinalIgnoreCase))
            {
                Console.Write("marker note> ");
                recorder.Marker(Console.ReadLine() ?? string.Empty);
            }
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine("Oasis Race Control — read-only iRacing telemetry recorder");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  OasisSpike.exe --mode canary   10-minute / 25-MiB safety canary");
        Console.WriteLine("  OasisSpike.exe --mode full     120-minute / 100-MiB approved spike");
        Console.WriteLine("  OasisSpike.exe --version");
        Console.WriteLine("  OasisSpike.exe --help");
        Console.WriteLine();
        Console.WriteLine("No mode is selected by default. Limits cannot be weakened from the command line.");
    }
}

internal static class BuildInfo
{
    private static readonly Assembly Assembly = typeof(BuildInfo).Assembly;
    internal static string Version => Assembly.GetName().Version?.ToString(3) ?? "unknown";
    internal static string SourceRevision => Assembly
        .GetCustomAttributes<AssemblyMetadataAttribute>()
        .FirstOrDefault(attribute => attribute.Key == "SourceRevisionId")?.Value ?? "unknown";
}

internal sealed class SingleInstanceGuard : IDisposable
{
    private readonly Mutex _mutex;

    private SingleInstanceGuard(Mutex mutex) => _mutex = mutex;

    internal static SingleInstanceGuard? TryAcquire(string name)
    {
        var mutex = new Mutex(initiallyOwned: true, name, out var ownsMutex);
        if (ownsMutex) return new SingleInstanceGuard(mutex);
        mutex.Dispose();
        return null;
    }

    public void Dispose()
    {
        try { _mutex.ReleaseMutex(); } catch (ApplicationException) { }
        _mutex.Dispose();
    }
}
