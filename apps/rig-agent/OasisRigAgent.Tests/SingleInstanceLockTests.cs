using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Two agents on one rig share an outbox and a rig identity, so the second one
/// has to refuse to start. The realistic way there is an agent set to start with
/// Windows plus somebody double-clicking the desktop shortcut.
/// </summary>
public sealed class SingleInstanceLockTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"oasis-lock-{Guid.NewGuid():N}");
    private string LockPath => Path.Combine(_dir, "agent.lock");

    public SingleInstanceLockTests() => Directory.CreateDirectory(_dir);

    [Fact]
    public void The_first_agent_takes_the_lock_and_the_second_is_refused()
    {
        using var first = SingleInstanceLock.TryAcquire(LockPath);
        Assert.NotNull(first);

        var second = SingleInstanceLock.TryAcquire(LockPath);

        Assert.Null(second);
    }

    [Fact]
    public void Releasing_lets_the_next_agent_start()
    {
        var first = SingleInstanceLock.TryAcquire(LockPath);
        Assert.NotNull(first);
        first!.Dispose();

        using var second = SingleInstanceLock.TryAcquire(LockPath);

        Assert.NotNull(second);
    }

    [Fact]
    public void A_lock_file_left_behind_by_a_crash_does_not_block_the_restart()
    {
        // The operating system owns the lock, so a machine that lost power comes
        // back with the file still on disk and nothing holding it. Nobody should
        // have to visit the rig to delete it.
        File.WriteAllText(LockPath, "pid=999999 started=whenever machine=RIG-07");

        using var restarted = SingleInstanceLock.TryAcquire(LockPath);

        Assert.NotNull(restarted);
    }

    [Fact]
    public void The_holder_is_recorded_so_a_refused_start_can_name_it()
    {
        using var first = SingleInstanceLock.TryAcquire(LockPath);

        var holder = SingleInstanceLock.DescribeHolder(LockPath);

        Assert.Contains($"pid={Environment.ProcessId}", holder);
        Assert.Contains(Environment.MachineName, holder);
    }

    [Fact]
    public void Reading_the_holder_does_not_disturb_the_lock()
    {
        using var first = SingleInstanceLock.TryAcquire(LockPath);

        SingleInstanceLock.DescribeHolder(LockPath);

        Assert.Null(SingleInstanceLock.TryAcquire(LockPath));
    }

    [Fact]
    public void Two_rigs_sharing_one_bench_machine_do_not_block_each_other()
    {
        // Separate data folders (OASIS_DATA_DIR) is how a bench runs two agents.
        var otherDir = Path.Combine(_dir, "rig-2");
        Directory.CreateDirectory(otherDir);

        using var rig1 = SingleInstanceLock.TryAcquire(LockPath);
        using var rig2 = SingleInstanceLock.TryAcquire(Path.Combine(otherDir, "agent.lock"));

        Assert.NotNull(rig1);
        Assert.NotNull(rig2);
    }

    [Fact]
    public void A_missing_data_folder_is_a_deployment_fault_not_a_second_instance()
    {
        // Reporting "already running" for a broken install would send whoever is
        // on shift looking for a process that is not there.
        var missing = Path.Combine(_dir, "does-not-exist", "agent.lock");

        Assert.ThrowsAny<Exception>(() => SingleInstanceLock.TryAcquire(missing));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }
}
