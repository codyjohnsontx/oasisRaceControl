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

    /// <summary>
    /// Set when the config file still carries the old <c>agentVersion</c> field.
    /// It is ignored - <see cref="AgentVersionInfo"/> reads the build that is
    /// actually running - and this exists only so the agent can say so once at
    /// startup, rather than leaving an operator to wonder why the dashboard
    /// disagrees with the file. Deliberately not named <c>AgentVersion</c>, so
    /// the old key cannot bind to it.
    /// </summary>
    public string? IgnoredConfigVersion { get; init; }

    /// <summary>
    /// How long iRacing may stay closed with a customer still checked in before the
    /// agent ends their session (see <see cref="IdleWatch"/>). Ten minutes is long
    /// enough to survive a sim restart or a walk to the counter and short enough that
    /// the next walk-in does not inherit the last one's name. Set to 0 on a rig that
    /// should only ever be cleared by hand.
    /// </summary>
    public int IdleTimeoutSeconds { get; init; } = 600;

    /// <summary>How much of the end of that period the rig spends saying so on its own
    /// screen, so a customer who is still there can restart the sim instead of losing
    /// their check-in.</summary>
    public int IdleWarningSeconds { get; init; } = 60;

    public static AgentConfig Load(string path)
    {
        AgentConfig config;
        if (File.Exists(path))
        {
            var json = File.ReadAllText(path);
            config = JsonSerializer.Deserialize<AgentConfig>(json, JsonOptions)
                ?? throw new InvalidOperationException($"Could not parse {path}");
            config = config with { IgnoredConfigVersion = LegacyVersionField(json) };
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
            IdleTimeoutSeconds = ParseSeconds("OASIS_IDLE_TIMEOUT_SECONDS") ?? config.IdleTimeoutSeconds,
            IdleWarningSeconds = ParseSeconds("OASIS_IDLE_WARNING_SECONDS") ?? config.IdleWarningSeconds,
        };
    }

    /// <summary>
    /// Reads the retired <c>agentVersion</c> field, if an install from before the
    /// running build became authoritative still writes one. An unknown JSON member is
    /// otherwise dropped silently, and a config that looks like it is setting the
    /// version while the dashboard shows another number is exactly the confusion this
    /// change exists to end.
    /// </summary>
    private static string? LegacyVersionField(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            foreach (var property in doc.RootElement.EnumerateObject())
            {
                if (!property.NameEquals("agentVersion")
                    && !string.Equals(property.Name, "agentVersion", StringComparison.OrdinalIgnoreCase))
                    continue;
                return property.Value.ValueKind == JsonValueKind.String
                    ? property.Value.GetString()
                    : property.Value.ToString();
            }
        }
        catch (JsonException)
        {
            // The deserializer above already read this text; a parse failure here is
            // not worth failing a start over.
        }
        return null;
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

    /// <summary>Absent → keep the file value; a whole number of seconds → use it;
    /// anything else → say so, rather than quietly running with a default that signs
    /// customers out at a different time than whoever set it intended.</summary>
    private static int? ParseSeconds(string name)
    {
        var v = Env(name);
        if (v is null) return null;
        if (!int.TryParse(v, out var seconds) || seconds < 0)
            throw new InvalidOperationException($"{name} must be a whole number of seconds, 0 or more (got \"{v}\")");
        return seconds;
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
        if (IdleTimeoutSeconds < 0 || IdleWarningSeconds < 0)
            throw new InvalidOperationException(
                "IdleTimeoutSeconds and IdleWarningSeconds cannot be negative (0 disables the automatic sign-out)");
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
