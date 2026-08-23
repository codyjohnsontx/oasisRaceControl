using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The venue installs this agent on twenty-plus Windows machines, where the
/// folder the app runs from is normally not one the rig's account may write to.
/// These cover the layout that has to hold there and on a developer's machine at
/// the same time.
/// </summary>
public sealed class AgentPathsTests : IDisposable
{
    private readonly string _temp = Path.Combine(Path.GetTempPath(), $"oasis-paths-{Guid.NewGuid():N}");

    private static AgentPaths Resolve(
        string appDir,
        string? dataOverride,
        string defaultData,
        params string[] existingFiles)
        => AgentPaths.Resolve(appDir, dataOverride, defaultData, p => existingFiles.Contains(p));

    [Fact]
    public void Everything_the_agent_writes_lives_in_the_data_folder_not_beside_the_app()
    {
        // The Program Files case: the app folder is read-only to the account the
        // rig signs in as, so an outbox beside the executable is an outbox that
        // cannot take a lap.
        var paths = Resolve(@"/opt/oasis-agent", null, "/var/lib/oasis");

        Assert.Equal(Path.GetFullPath("/var/lib/oasis"), paths.DataDirectory);
        Assert.Equal(Path.Combine(paths.DataDirectory, "outbox.db"), paths.OutboxPath);
        Assert.Equal(Path.Combine(paths.DataDirectory, "logs"), paths.LogDirectory);
        Assert.Equal(Path.Combine(paths.DataDirectory, "agent.lock"), paths.LockPath);
        Assert.DoesNotContain("oasis-agent", paths.OutboxPath);
    }

    [Fact]
    public void Config_beside_the_app_wins_because_that_is_where_an_installer_writes_the_rigs_identity()
    {
        var appDir = Path.GetFullPath("/opt/oasis-agent");
        var besideExe = Path.Combine(appDir, "agent.config.json");

        var paths = Resolve(appDir, null, "/var/lib/oasis", besideExe);

        Assert.Equal(besideExe, paths.ConfigPath);
        Assert.True(paths.ConfigIsBesideExecutable);
    }

    [Fact]
    public void Config_falls_back_to_the_data_folder_so_a_token_can_be_changed_without_admin_rights()
    {
        var paths = Resolve(Path.GetFullPath("/opt/oasis-agent"), null, "/var/lib/oasis");

        Assert.Equal(Path.Combine(paths.DataDirectory, "agent.config.json"), paths.ConfigPath);
        Assert.False(paths.ConfigIsBesideExecutable);
    }

    [Fact]
    public void OASIS_DATA_DIR_moves_the_whole_writable_side()
    {
        var paths = Resolve(Path.GetFullPath("/opt/oasis-agent"), "/bench/rig-7", "/var/lib/oasis");

        Assert.Equal(Path.GetFullPath("/bench/rig-7"), paths.DataDirectory);
        Assert.StartsWith(paths.DataDirectory, paths.OutboxPath);
        Assert.StartsWith(paths.DataDirectory, paths.LockPath);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void A_blank_override_is_treated_as_unset_rather_than_as_the_current_directory(string blank)
    {
        var paths = Resolve(Path.GetFullPath("/opt/oasis-agent"), blank, "/var/lib/oasis");

        Assert.Equal(Path.GetFullPath("/var/lib/oasis"), paths.DataDirectory);
    }

    [Fact]
    public void Paths_are_absolute_so_the_working_directory_a_scheduled_task_starts_in_cannot_move_them()
    {
        // Task Scheduler starts a task in C:\Windows\System32 unless told
        // otherwise; a relative data folder would put the outbox there.
        var paths = Resolve(".", "relative-data", "also-relative");

        Assert.True(Path.IsPathRooted(paths.DataDirectory));
        Assert.True(Path.IsPathRooted(paths.OutboxPath));
        Assert.True(Path.IsPathRooted(paths.ConfigPath));
    }

    [Fact]
    public void The_default_data_folder_is_per_machine_not_per_repo()
    {
        var actual = AgentPaths.DefaultDataDirectory();

        Assert.True(Path.IsPathRooted(actual));
        if (OperatingSystem.IsWindows())
        {
            // Per machine rather than per user: the rig's outbox has to be the
            // same one whichever account is signed in.
            Assert.Equal(
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "OasisRaceControl"),
                actual);
        }
        else
        {
            Assert.EndsWith("oasis-rig-agent", actual);
        }
    }

    [Fact]
    public void EnsureWritable_creates_the_folders_the_agent_needs()
    {
        var paths = AgentPaths.Resolve("/opt/oasis-agent", _temp, "/unused", _ => false);

        paths.EnsureWritable();

        Assert.True(Directory.Exists(paths.DataDirectory));
        Assert.True(Directory.Exists(paths.LogDirectory));
        Assert.False(File.Exists(Path.Combine(paths.DataDirectory, ".write-probe")));
    }

    [Fact]
    public void EnsureWritable_is_safe_to_call_over_an_existing_installation()
    {
        var paths = AgentPaths.Resolve("/opt/oasis-agent", _temp, "/unused", _ => false);
        paths.EnsureWritable();
        File.WriteAllText(paths.OutboxPath, "pretend outbox");

        paths.EnsureWritable();

        Assert.Equal("pretend outbox", File.ReadAllText(paths.OutboxPath));
    }

    [Fact]
    public void A_data_folder_the_rig_cannot_write_to_is_reported_with_the_path_and_the_way_out()
    {
        // Unix permissions stand in for the Windows case this protects against:
        // an installer that put the data folder somewhere the rig's account
        // does not own.
        if (OperatingSystem.IsWindows()) return; // chmod is not the mechanism there

        Directory.CreateDirectory(_temp);
        var locked = Path.Combine(_temp, "locked");
        Directory.CreateDirectory(locked);
        File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserExecute);

        var paths = AgentPaths.Resolve("/opt/oasis-agent", Path.Combine(locked, "data"), "/unused", _ => false);
        var ex = Assert.Throws<InvalidOperationException>(paths.EnsureWritable);

        Assert.Contains(paths.DataDirectory, ex.Message);
        Assert.Contains("OASIS_DATA_DIR", ex.Message);

        File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_temp)) Directory.Delete(_temp, recursive: true); } catch { }
    }
}
