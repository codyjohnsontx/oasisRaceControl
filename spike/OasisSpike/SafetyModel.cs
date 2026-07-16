namespace OasisSpike;

public enum RecorderMode
{
    Canary,
    Full
}

public enum RecorderExitCode
{
    Success = 0,
    InvalidArguments = 2,
    UnsupportedPlatform = 3,
    Elevated = 10,
    DuplicateInstance = 11,
    OutputFailure = 12,
    MalformedTelemetry = 13,
    LogLimit = 14,
    InternalFailure = 15
}

public sealed record SafetyLimits(TimeSpan MaxDuration, long MaxOutputBytes)
{
    public const long MinimumFreeBytes = 500L * 1024 * 1024;

    public static SafetyLimits For(RecorderMode mode) => mode switch
    {
        RecorderMode.Canary => new(TimeSpan.FromMinutes(10), 25L * 1024 * 1024),
        RecorderMode.Full => new(TimeSpan.FromMinutes(120), 100L * 1024 * 1024),
        _ => throw new ArgumentOutOfRangeException(nameof(mode))
    };
}

internal static class RecorderModeExtensions
{
    internal static bool TryParse(string value, out RecorderMode mode)
    {
        if (value.Equals("canary", StringComparison.OrdinalIgnoreCase))
        {
            mode = RecorderMode.Canary;
            return true;
        }
        if (value.Equals("full", StringComparison.OrdinalIgnoreCase))
        {
            mode = RecorderMode.Full;
            return true;
        }
        mode = default;
        return false;
    }

    internal static string ToCliValue(this RecorderMode mode) => mode == RecorderMode.Canary ? "canary" : "full";
}

internal static class RunDirectory
{
    internal static string Create(string baseDirectory)
    {
        var logsRoot = Path.GetFullPath(Path.Combine(baseDirectory, "spike-logs"));
        EnsureChildOf(baseDirectory, logsRoot);
        Directory.CreateDirectory(logsRoot);

        for (var attempt = 0; attempt < 10; attempt++)
        {
            var suffix = Guid.NewGuid().ToString("N")[..8];
            var name = $"{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}Z-{suffix}";
            var runDirectory = Path.GetFullPath(Path.Combine(logsRoot, name));
            EnsureChildOf(logsRoot, runDirectory);
            if (Directory.Exists(runDirectory)) continue;
            try
            {
                Directory.CreateDirectory(runDirectory);
                return runDirectory;
            }
            catch (IOException) when (attempt < 9)
            {
            }
        }

        throw new IOException("Could not create a unique run directory.");
    }

    internal static void EnsureChildOf(string parent, string child)
    {
        var normalizedParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!Path.GetFullPath(child).StartsWith(normalizedParent, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Safety boundary violation: output path escaped its approved directory.");
    }
}
