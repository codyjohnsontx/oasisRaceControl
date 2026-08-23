using System.Globalization;

namespace OasisRigAgent.Core;

/// <summary>
/// Keeps one agent per rig.
///
/// A venue machine reaches two running copies the easy way: the agent is set to
/// start with Windows, and then somebody double-clicks the desktop shortcut
/// because the window is not where they expected it. Two copies share one outbox
/// database, so they interleave writes to it, both heartbeat, both poll, and both
/// attach to the simulator - and the rig's own display starts disagreeing with
/// itself about who is checked in.
///
/// The guard is an exclusive handle on a file in the data directory. The
/// operating system owns it, so a copy that was killed, crashed, or lost power
/// releases it without leaving a stale lock behind for someone to clear by hand.
/// Who holds it is written to a separate, freely readable file, because the
/// locked one cannot be opened by the process that wants to name the holder.
/// </summary>
public sealed class SingleInstanceLock : IDisposable
{
    private readonly FileStream _stream;

    private SingleInstanceLock(FileStream stream, string path)
    {
        _stream = stream;
        Path = path;
    }

    public string Path { get; }

    /// <summary>Take the lock, or return null when another agent already holds
    /// it. A folder that is missing or cannot be written to throws instead -
    /// that is a deployment fault, not another instance, and reporting the two
    /// as the same thing sends whoever is on shift looking for a process that
    /// is not there.</summary>
    public static SingleInstanceLock? TryAcquire(string path)
    {
        FileStream stream;
        try
        {
            stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException ex) when (ex is not DirectoryNotFoundException and not FileNotFoundException)
        {
            return null;
        }

        try
        {
            // Leave the owner behind so a refused start can say which process to
            // look at. Written beside the lock rather than inside it: the lock is
            // exclusive by definition, so nothing else could read it.
            File.WriteAllText(OwnerPath(path), string.Create(CultureInfo.InvariantCulture,
                $"pid={Environment.ProcessId} started={DateTimeOffset.UtcNow:o} machine={Environment.MachineName}"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The lock is what matters; failing to annotate it is not a reason
            // to refuse the start.
        }

        return new SingleInstanceLock(stream, path);
    }

    /// <summary>What the agent holding the lock recorded about itself, for the
    /// message shown when a start is refused. Empty when it cannot be read.</summary>
    public static string DescribeHolder(string path)
    {
        try
        {
            return File.ReadAllText(OwnerPath(path)).Trim();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    private static string OwnerPath(string lockPath) => lockPath + ".owner";

    public void Dispose() => _stream.Dispose();
}
