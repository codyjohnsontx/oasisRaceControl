using System.Text.Json;

namespace OasisRigAgent.Core;

/// <summary>
/// Per-rig configuration. In production this is written once at enrollment and
/// the token is DPAPI-protected on disk; for the skeleton it is a plain JSON
/// file next to the executable (agent.config.json) with env-var overrides.
/// </summary>
public sealed record AgentConfig
{
    public required string BackendBaseUrl { get; init; }
    public required string RigToken { get; init; }
    public required int RigNumber { get; init; }

    /// <summary>Skeleton demo aid: drive the SimulatedTelemetrySource instead of
    /// the (not-yet-built) real iRacing source, so the agent submits laps.</summary>
    public bool SimulateTelemetry { get; init; }

    public string AgentVersion { get; init; } = "rig-agent/0.1-skeleton";

    public static AgentConfig Load(string path)
    {
        AgentConfig config;
        if (File.Exists(path))
        {
            var json = File.ReadAllText(path);
            config = JsonSerializer.Deserialize<AgentConfig>(json, JsonOptions)
                ?? throw new InvalidOperationException($"Could not parse {path}");
        }
        else
        {
            config = new AgentConfig { BackendBaseUrl = "", RigToken = "", RigNumber = 0 };
        }

        // Env overrides make it easy to run without editing the file (and keep
        // secrets out of source control during development).
        return config with
        {
            BackendBaseUrl = Env("OASIS_BACKEND_URL") ?? config.BackendBaseUrl,
            RigToken = Env("OASIS_RIG_TOKEN") ?? config.RigToken,
            RigNumber = int.TryParse(Env("OASIS_RIG_NUMBER"), out var n) ? n : config.RigNumber,
            SimulateTelemetry = Env("OASIS_SIMULATE") is "1" or "true" || config.SimulateTelemetry,
        };
    }

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(BackendBaseUrl))
            throw new InvalidOperationException("BackendBaseUrl is not set (agent.config.json or OASIS_BACKEND_URL)");
        if (string.IsNullOrWhiteSpace(RigToken))
            throw new InvalidOperationException("RigToken is not set (agent.config.json or OASIS_RIG_TOKEN)");
        if (RigNumber <= 0)
            throw new InvalidOperationException("RigNumber is not set (agent.config.json or OASIS_RIG_NUMBER)");
    }

    private static string? Env(string name)
    {
        var v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(v) ? null : v;
    }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };
}
