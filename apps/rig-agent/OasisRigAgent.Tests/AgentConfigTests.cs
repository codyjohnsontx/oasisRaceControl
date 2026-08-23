using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The per-rig config file. It is written once at install and then deliberately
/// left alone for the life of the machine - it holds this rig's bearer token, so
/// a fleet update copies the program folder over it rather than replacing it.
/// That is exactly why the agent's version no longer lives here.
/// </summary>
public sealed class AgentConfigTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"oasis-config-{Guid.NewGuid():N}");

    private string Write(string json)
    {
        Directory.CreateDirectory(_dir);
        var path = Path.Combine(_dir, "agent.config.json");
        File.WriteAllText(path, json);
        return path;
    }

    [Theory]
    [InlineData("\"agentVersion\": \"rig-agent/0.1-skeleton\"", "rig-agent/0.1-skeleton")]
    // An operator typing the field by hand does not match our casing, and a
    // silently-ignored line is the thing this reports.
    [InlineData("\"AgentVersion\": \"1.2.3\"", "1.2.3")]
    public void A_config_that_still_declares_a_version_is_read_so_the_agent_can_say_it_is_ignored(
        string field, string expected)
    {
        var config = AgentConfig.Load(Write($$"""
            { "backendBaseUrl": "https://x.test", "rigToken": "t", "rigNumber": 3, {{field}} }
            """));

        Assert.Equal(expected, config.IgnoredConfigVersion);
        Assert.Equal(3, config.RigNumber);
    }

    [Fact]
    public void An_ordinary_config_has_nothing_to_say_about_the_version()
    {
        var config = AgentConfig.Load(Write("""
            { "backendBaseUrl": "https://x.test", "rigToken": "t", "rigNumber": 1 }
            """));

        Assert.Null(config.IgnoredConfigVersion);
    }

    [Fact]
    public void A_version_field_of_the_wrong_shape_does_not_stop_the_rig_starting()
    {
        // Reporting a retired field is worth a line in the log and nothing more. A rig
        // that refuses to start over one is a rig that scores nothing all night.
        var config = AgentConfig.Load(Write("""
            { "backendBaseUrl": "https://x.test", "rigToken": "t", "rigNumber": 1, "agentVersion": 7 }
            """));

        config.Validate();
        Assert.Equal("7", config.IgnoredConfigVersion);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }
}
