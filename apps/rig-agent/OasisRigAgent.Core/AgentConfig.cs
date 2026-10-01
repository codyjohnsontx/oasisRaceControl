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

    /// <summary>Which telemetry source to run: "iracing" (read the sim's shared
    /// memory on the rig PC), "simulated" (fake laps for testing), or "none"
    /// (heartbeat and driver display only). Absent means <see cref="SimulateTelemetry"/>
    /// decides, which keeps every existing config file meaning what it did.</summary>
    public string? Telemetry { get; init; }

    /// <summary>Older spelling of <c>"telemetry": "simulated"</c>. Ignored when
    /// <see cref="Telemetry"/> is set.</summary>
    public bool SimulateTelemetry { get; init; }

    public TelemetryMode TelemetryMode => Telemetry?.Trim().ToLowerInvariant() switch
    {
        null or "" => SimulateTelemetry ? TelemetryMode.Simulated : TelemetryMode.None,
        "none" => TelemetryMode.None,
        "simulated" => TelemetryMode.Simulated,
        "iracing" => TelemetryMode.Iracing,
        _ => throw new InvalidOperationException(
            $"telemetry must be \"iracing\", \"simulated\" or \"none\" (got \"{Telemetry}\")"),
    };

    /// <summary>Reported on every heartbeat, so the staff dashboard can tell
    /// which rigs stamp laps with their capture-time assignment (0.2 and later)
    /// and which are still on an agent whose laps the backend can only store
    /// unattributed, where they are kept but can never rank. Bump
    /// CURRENT_AGENT_VERSION in apps/web/src/lib/monitor/agent-version.ts with
    /// it: the rig monitor warns about every rig on any other version, and
    /// agent-version.test.ts fails until the two agree.</summary>
    public string AgentVersion { get; init; } = "rig-agent/0.5-monitor";

    /// <summary>This rig's check-in QR token (the slug in its /r/&lt;token&gt; URL).
    /// When set, the console runs the walk-up loop: it asks for a name and a
    /// 4-digit PIN, signs that driver in on this rig through the backend's own
    /// login, register and check-in routes, posts their laps, and signs them
    /// out when they press Enter or close the program. Absent, the agent keeps
    /// the staff-style s/q console.</summary>
    public string? RigQrToken { get; init; }

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
            SimulateTelemetry = ParseSimulateOverride() ?? config.SimulateTelemetry,
            Telemetry = Env("OASIS_TELEMETRY") ?? config.Telemetry,
            RigQrToken = Env("OASIS_RIG_QR_TOKEN") ?? config.RigQrToken,
        };
    }

    /// <summary>OASIS_SIMULATE is a true override: absent → keep the file value,
    /// truthy/falsy → use it, anything else → fail loudly instead of silently
    /// running without (or with) fake laps.</summary>
    private static bool? ParseSimulateOverride()
    {
        var v = Env("OASIS_SIMULATE");
        return v?.ToLowerInvariant() switch
        {
            null => null,
            "1" or "true" => true,
            "0" or "false" => false,
            _ => throw new InvalidOperationException($"OASIS_SIMULATE must be 1, 0, true, or false (got \"{v}\")"),
        };
    }

    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(BackendBaseUrl))
            throw new InvalidOperationException("BackendBaseUrl is not set (agent.config.json or OASIS_BACKEND_URL)");
        // The rig token rides on every request, so plain http is only acceptable
        // against a local dev backend.
        if (!Uri.TryCreate(BackendBaseUrl, UriKind.Absolute, out var url)
            || (url.Scheme != Uri.UriSchemeHttps && !(url.Scheme == Uri.UriSchemeHttp && url.IsLoopback)))
            throw new InvalidOperationException(
                $"BackendBaseUrl must be an absolute https:// URL (http:// only for localhost): \"{BackendBaseUrl}\"");
        if (string.IsNullOrWhiteSpace(RigToken))
            throw new InvalidOperationException("RigToken is not set (agent.config.json or OASIS_RIG_TOKEN)");
        if (RigNumber <= 0)
            throw new InvalidOperationException("RigNumber is not set (agent.config.json or OASIS_RIG_NUMBER)");
        _ = TelemetryMode; // throws on an unknown value
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

public enum TelemetryMode
{
    None,
    Simulated,
    Iracing,
}
