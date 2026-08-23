using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// Which computer an agent says it is.
///
/// A rig's token is its whole identity to the backend, and a venue installs
/// twenty-plus simulators by copying one machine's folder to the next. Copy
/// agent.config.json with it and two rigs share a token: both machines look
/// healthy, and half the laps on the board belong to the other customer. The
/// backend can only see that if the heartbeat says which computer sent it.
///
/// So the identity has two jobs that pull against each other - it must survive
/// a restart, or every restart would look like a second machine, and it must
/// differ between two computers however the mistake was made.
/// </summary>
public sealed class InstallationIdentityTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"oasis-install-{Guid.NewGuid():N}");

    private string Seed(string name = "installation-id") => Path.Combine(_dir, name);

    [Fact]
    public void The_same_machine_is_the_same_installation_after_a_restart()
    {
        // Twice a minute, every rig in the venue, all day. If a restart minted a
        // new identity the backend would see a takeover attempt on every reboot.
        var first = InstallationIdentity.Resolve(Seed(), "RIG-03");
        var second = InstallationIdentity.Resolve(Seed(), "RIG-03");

        Assert.Equal(first.Id, second.Id);
        Assert.Equal("RIG-03", second.MachineName);
    }

    [Fact]
    public void The_next_rig_installed_from_a_copied_folder_is_a_different_installation()
    {
        // The realistic mistake: the program folder is copied to rig 7, config
        // and all. Nothing writable travels with it, so the new machine mints
        // its own seed the first time it starts.
        var rigThree = InstallationIdentity.Resolve(Seed("rig-3"), "RIG-03");
        var rigSeven = InstallationIdentity.Resolve(Seed("rig-7"), "RIG-07");

        Assert.NotEqual(rigThree.Id, rigSeven.Id);
    }

    [Fact]
    public void A_cloned_disk_image_is_still_a_different_installation()
    {
        // The other way a venue builds twenty machines: image one and clone it.
        // That copies the seed too, so the seed alone would report twenty
        // machines as one. Folding in the machine's own name is what separates
        // them - Windows machines on one network do not share a name.
        var master = InstallationIdentity.Resolve(Seed(), "RIG-03");
        var clone = InstallationIdentity.Resolve(Seed(), "RIG-07");

        Assert.NotEqual(master.Id, clone.Id);
    }

    [Fact]
    public void A_machine_name_in_another_case_is_the_same_machine()
    {
        // Windows machine names are case-insensitive, so a rig re-registered as
        // "rig-03" must not read as a second computer claiming the same rig.
        var upper = InstallationIdentity.Resolve(Seed(), "RIG-03");
        var lower = InstallationIdentity.Resolve(Seed(), "rig-03");

        Assert.Equal(upper.Id, lower.Id);
        // The name is still reported as the machine spells it, because it is
        // what staff read on the dashboard.
        Assert.Equal("rig-03", lower.MachineName);
    }

    [Fact]
    public void The_seed_is_kept_next_to_the_agents_own_files()
    {
        var identity = InstallationIdentity.Resolve(Seed(), "RIG-03");

        Assert.True(File.Exists(Seed()));
        // And it is genuinely the file that decides: delete it and the machine
        // is a new installation, which is what makes a wiped data folder read as
        // a reinstall rather than as a second computer.
        File.Delete(Seed());
        Assert.NotEqual(identity.Id, InstallationIdentity.Resolve(Seed(), "RIG-03").Id);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   \n")]
    public void A_seed_file_with_nothing_usable_in_it_is_replaced(string contents)
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Seed(), contents);

        var identity = InstallationIdentity.Resolve(Seed(), "RIG-03");

        // A half-written file must not produce an identity that changes every
        // start; it is rewritten once and then stable.
        Assert.Equal(identity.Id, InstallationIdentity.Resolve(Seed(), "RIG-03").Id);
        Assert.NotEmpty(File.ReadAllText(Seed()).Trim());
    }

    [Fact]
    public void A_folder_it_cannot_write_still_produces_an_identity()
    {
        // The identity is nice to have; losing the heartbeat over it would take
        // the rig off the dashboard entirely. A path that cannot be created is
        // the case: the agent still reports something, and says so in its log.
        var log = new RecordingLog();
        var unwritable = Path.Combine(Seed("not-a-directory"), "installation-id");
        Directory.CreateDirectory(_dir);
        File.WriteAllText(Seed("not-a-directory"), "i am a file");

        var identity = InstallationIdentity.Resolve(unwritable, "RIG-03", log);

        Assert.Equal(32, identity.Id.Length);
        Assert.Contains(log.Lines, l => l.Contains("installation id", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_machine_with_no_usable_name_still_reports_one()
    {
        // Env.MachineName can come back empty on an oddly configured machine.
        // A blank name on the wire is refused by the contract, which would cost
        // the whole heartbeat.
        var identity = InstallationIdentity.Resolve(Seed(), "  ");

        Assert.Equal("unnamed-pc", identity.MachineName);
    }

    [Fact]
    public void A_very_long_machine_name_is_cut_to_what_the_contract_accepts()
    {
        var identity = InstallationIdentity.Resolve(Seed(), new string('x', 200));

        Assert.Equal(InstallationIdentity.MaxMachineNameLength, identity.MachineName.Length);
    }

    [Fact]
    public void The_identity_the_backend_sees_is_opaque_and_fixed_width()
    {
        // It is compared, never parsed, and the contract caps it at 64 - so it
        // carries no machine name, no path, and nothing of variable length.
        var identity = InstallationIdentity.Resolve(Seed(), "RIG-03");

        Assert.Equal(32, identity.Id.Length);
        Assert.Matches("^[0-9a-f]{32}$", identity.Id);
        Assert.DoesNotContain("RIG-03", identity.Id, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_seed_lives_in_the_data_folder_not_beside_the_executable()
    {
        // Beside the executable it would be copied to the next rig along with
        // the program, which is exactly the mistake this exists to catch. It is
        // also a folder the agent may not write to on a real rig.
        var paths = AgentPaths.Resolve(
            appDirectory: Path.Combine(_dir, "app"),
            dataDirectoryOverride: Path.Combine(_dir, "data"),
            defaultDataDirectory: Path.Combine(_dir, "default"),
            fileExists: _ => false);

        Assert.StartsWith(paths.DataDirectory, paths.InstallationIdPath, StringComparison.Ordinal);
        Assert.EndsWith(InstallationIdentity.FileName, paths.InstallationIdPath, StringComparison.Ordinal);
    }

    private sealed class RecordingLog : IAgentLog
    {
        public readonly List<string> Lines = new();
        public void Write(string level, string message) { lock (Lines) Lines.Add(message); }
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); } catch { }
    }
}
