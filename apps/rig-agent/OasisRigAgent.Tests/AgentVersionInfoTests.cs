using System.Reflection;
using System.Text.RegularExpressions;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The version a rig reports is the venue's only answer to "which of the
/// twenty-plus machines took the update", and the update it exists for lands on
/// the whole room within a day (a forced iRacing build the agent cannot read).
/// These hold the two properties that answer is worth anything without: it comes
/// from the build that is running, and it survives the wire.
/// </summary>
public sealed class AgentVersionInfoTests
{
    [Fact]
    public void The_rig_reports_the_build_it_is_running()
    {
        var declared = typeof(AgentService).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

        Assert.NotNull(declared);
        Assert.Equal($"oasis-rig-agent/{declared!.Split('+')[0]}", AgentVersionInfo.Current);
    }

    [Fact]
    public void A_real_version_number_not_a_placeholder()
    {
        // "rig-agent/0.1-skeleton" shipped for sixteen rounds of work because it was a
        // constant nobody had to touch. A version an update round can read has to be a
        // number that moves, so this refuses anything that is not one.
        Assert.StartsWith("oasis-rig-agent/", AgentVersionInfo.Current);
        var number = AgentVersionInfo.Current["oasis-rig-agent/".Length..];
        Assert.Matches(new Regex(@"^\d+\.\d+\.\d+$"), number);
    }

    [Fact]
    public void Fits_the_heartbeat_contract()
    {
        // A version over the cap is not a cosmetic problem: it 400s the heartbeat, and a
        // rig whose heartbeats are refused reads as offline on /staff - the same as one
        // that has been switched off.
        Assert.True(AgentVersionInfo.Current.Length <= AgentVersionInfo.MaxWireLength,
            $"{AgentVersionInfo.Current} is {AgentVersionInfo.Current.Length} characters");
    }

    [Fact]
    public void The_commit_the_build_came_from_is_dropped_rather_than_sent()
    {
        // A build with source information gets "1.4.0+<40 hex characters>" from .NET
        // itself. Sent whole it overruns the cap on its own and takes every heartbeat
        // with it; on a rig card it is 40 characters nobody reads.
        var withMetadata = AgentVersionInfo.Format(
            "1.4.0+8f3c2b1d9e0a4f5c6b7a8d9e0f1a2b3c4d5e6f70", null);

        Assert.Equal("oasis-rig-agent/1.4.0", withMetadata);
    }

    [Fact]
    public void A_version_too_long_to_send_is_shortened_rather_than_dropped()
    {
        var long_ = AgentVersionInfo.Format(new string('9', 60), null);

        Assert.Equal(AgentVersionInfo.MaxWireLength, long_.Length);
        Assert.StartsWith("oasis-rig-agent/9", long_);
    }

    [Fact]
    public void Falls_back_to_the_assembly_version_rather_than_reporting_nothing()
    {
        // A rig reporting no version at all is indistinguishable from an agent too old
        // to report one, which is the case the dashboard already treats as unknown.
        Assert.Equal("oasis-rig-agent/2.3.0.0", AgentVersionInfo.Format(null, "2.3.0.0"));
        Assert.Equal("oasis-rig-agent/2.3.0.0", AgentVersionInfo.Format("   ", "2.3.0.0"));
        Assert.Equal("oasis-rig-agent/unknown", AgentVersionInfo.Format(null, null));
    }

    [Fact]
    public void The_build_is_the_one_declared_for_the_whole_agent()
    {
        // Directory.Build.props is the one place a release is bumped. If a project ever
        // stops inheriting it, .NET quietly stamps its own 1.0.0 default instead - so
        // every rig would report the same number build after build, and a half-finished
        // update round would be indistinguishable from a finished one on /staff.
        var declared = DeclaredVersion();

        Assert.Equal($"oasis-rig-agent/{declared}", AgentVersionInfo.Current);
    }

    /// <summary>Reads &lt;Version&gt; out of apps/rig-agent/Directory.Build.props, found by
    /// walking up from the test binary so it works from any working directory.</summary>
    private static string DeclaredVersion()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var props = Path.Combine(dir.FullName, "Directory.Build.props");
            if (!File.Exists(props)) continue;
            var match = Regex.Match(File.ReadAllText(props), @"<Version>([^<]+)</Version>");
            Assert.True(match.Success, $"{props} does not declare a <Version> for the fleet to compare.");
            return match.Groups[1].Value.Trim();
        }
        throw new InvalidOperationException("No Directory.Build.props above " + AppContext.BaseDirectory);
    }

    [Fact]
    public void Every_project_in_the_agent_is_built_from_the_same_version()
    {
        // Version lives in apps/rig-agent/Directory.Build.props precisely so the number
        // an operator reads off the exe's file properties is the one the rig reports.
        // Two projects stamping different numbers would make one of them a lie.
        var core = typeof(AgentService).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        var tests = typeof(AgentVersionInfoTests).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

        Assert.Equal(core?.Split('+')[0], tests?.Split('+')[0]);
    }
}
