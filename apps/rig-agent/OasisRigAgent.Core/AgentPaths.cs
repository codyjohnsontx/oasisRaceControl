namespace OasisRigAgent.Core;

/// <summary>
/// Where the agent keeps its files on a rig.
///
/// The agent is installed on every simulator in the venue, and on a real
/// Windows machine the folder it runs from is usually not one it may write to:
/// anything under <c>C:\Program Files</c> is read-only to the account the rig
/// signs in as. Keeping the outbox beside the executable therefore fails on the
/// machines that matter and works on a developer's, which is the worst way round
/// for a fleet of twenty-plus.
///
/// So the two kinds of file are separated:
///
/// <list type="bullet">
/// <item>Read-only material - the per-rig config - is looked for beside the
/// executable first, because that is where an installer writing a machine's
/// identity puts it, and falls back to the data directory so an operator can
/// change a token without administrator rights.</item>
/// <item>Everything the agent writes - the lap outbox, the logs, the
/// single-instance lock - always lives in the data directory, which is a
/// per-machine location the rig account owns.</item>
/// </list>
///
/// <c>OASIS_DATA_DIR</c> overrides the data directory, which is what makes the
/// whole layout testable and lets a second agent run side by side on a bench
/// machine.
/// </summary>
public sealed record AgentPaths
{
    public const string ConfigFileName = "agent.config.json";
    public const string OutboxFileName = "outbox.db";
    public const string LockFileName = "agent.lock";
    public const string LogDirectoryName = "logs";

    /// <summary>Where the per-rig config was resolved to. Reported at startup:
    /// with two candidate locations, an operator editing the wrong one is the
    /// obvious failure and the log is what settles it.</summary>
    public required string ConfigPath { get; init; }

    /// <summary>True when <see cref="ConfigPath"/> came from beside the
    /// executable rather than the data directory.</summary>
    public required bool ConfigIsBesideExecutable { get; init; }

    public required string DataDirectory { get; init; }
    public required string OutboxPath { get; init; }
    public required string LogDirectory { get; init; }
    public required string LockPath { get; init; }

    /// <summary>Where this machine's installation seed lives (see
    /// <see cref="InstallationIdentity"/>). In the data directory rather than
    /// beside the executable, so copying the program folder to the next rig
    /// cannot copy the identity with it.</summary>
    public required string InstallationIdPath { get; init; }

    /// <summary>Resolve against this machine: the running executable's folder,
    /// the OASIS_DATA_DIR override, and the platform's per-machine data
    /// location.</summary>
    public static AgentPaths ForApp() => Resolve(
        AppContext.BaseDirectory,
        Environment.GetEnvironmentVariable("OASIS_DATA_DIR"),
        DefaultDataDirectory(),
        File.Exists);

    /// <summary>The layout rules, with every environment lookup passed in so the
    /// venue's cases - installed read-only, running portable, two agents on one
    /// bench - are reachable from a test on any platform.</summary>
    public static AgentPaths Resolve(
        string appDirectory,
        string? dataDirectoryOverride,
        string defaultDataDirectory,
        Func<string, bool> fileExists)
    {
        var chosen = string.IsNullOrWhiteSpace(dataDirectoryOverride)
            ? defaultDataDirectory
            : dataDirectoryOverride.Trim();
        var data = Path.GetFullPath(chosen);

        var besideExe = Path.Combine(Path.GetFullPath(appDirectory), ConfigFileName);
        var inData = Path.Combine(data, ConfigFileName);
        var configIsBesideExe = fileExists(besideExe);

        return new AgentPaths
        {
            ConfigPath = configIsBesideExe ? besideExe : inData,
            ConfigIsBesideExecutable = configIsBesideExe,
            DataDirectory = data,
            OutboxPath = Path.Combine(data, OutboxFileName),
            LogDirectory = Path.Combine(data, LogDirectoryName),
            LockPath = Path.Combine(data, LockFileName),
            InstallationIdPath = Path.Combine(data, InstallationIdentity.FileName),
        };
    }

    /// <summary>
    /// %ProgramData%\OasisRaceControl on Windows - per machine, not per user, so
    /// the outbox is the same one whichever account the rig happens to be signed
    /// in as, and a lap queued before a sign-out still carries afterwards.
    /// Elsewhere (developer machines) the per-user data location, which needs no
    /// privileges.
    /// </summary>
    public static string DefaultDataDirectory()
    {
        if (OperatingSystem.IsWindows())
        {
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (!string.IsNullOrWhiteSpace(programData))
                return Path.Combine(programData, "OasisRaceControl");
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local))
            local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
        return Path.Combine(local, "oasis-rig-agent");
    }

    /// <summary>Create the data directory and prove it is writable, before the
    /// outbox, the log, or the lock try and fail one at a time. A rig that
    /// cannot write is a rig that cannot keep a lap through an outage, so it
    /// says so at startup naming the path and the override rather than
    /// discovering it hours later.</summary>
    public void EnsureWritable()
    {
        try
        {
            Directory.CreateDirectory(DataDirectory);
            Directory.CreateDirectory(LogDirectory);
            var probe = Path.Combine(DataDirectory, ".write-probe");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            throw new InvalidOperationException(
                $"The agent cannot write to its data folder \"{DataDirectory}\" ({ex.Message}). "
                + "Grant the rig's account write access to that folder, or set OASIS_DATA_DIR to one it owns.",
                ex);
        }
    }
}
