using System.Reflection;

namespace OasisRigAgent.Core;

/// <summary>
/// Which build of the agent this rig is running.
///
/// This is the venue's only answer to "which machines took the update", and the
/// update it exists for arrives on the whole room at once: iRacing updates are
/// forced, every rig takes the same one within a day, and a build that cannot
/// read the new telemetry layout stops the fleet scoring together (see
/// <see cref="IRacing.SimDecode"/>). Somebody then walks twenty-plus machines
/// with a USB stick, and the version on the staff dashboard is how they know
/// which ones are done.
///
/// So it is read from the running assembly and nowhere else. It used to be a
/// field in agent.config.json - the one file an update must *not* overwrite,
/// because it holds this rig's token - so the number the dashboard showed was
/// frozen at whatever was typed at install, or at a default no operator was ever
/// told about, and installing a new build could not change it.
/// </summary>
public static class AgentVersionInfo
{
    /// <summary>Names the program, so a version on a card is not a bare number that
    /// could belong to anything the venue runs.</summary>
    public const string Product = "oasis-rig-agent";

    /// <summary>The heartbeat contract caps `agentVersion` (apps/web/src/lib/events.ts).
    /// Overrunning it fails the whole heartbeat, and a rig that cannot heartbeat reads
    /// as offline on /staff - a worse answer than a shortened version string.</summary>
    public const int MaxWireLength = 40;

    /// <summary>What this build reports to the backend and prints for `--version`.</summary>
    public static string Current { get; } = Read(typeof(AgentVersionInfo).Assembly);

    public static string Read(Assembly assembly) => Format(
        assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
        assembly.GetName().Version?.ToString());

    /// <param name="informational">`AssemblyInformationalVersion`, which is what the
    /// build's own &lt;Version&gt; lands in.</param>
    /// <param name="assemblyVersion">Fallback for a build that carries no informational
    /// version, so the agent always names something rather than reporting nothing.</param>
    public static string Format(string? informational, string? assemblyVersion)
    {
        var version = Pick(informational) ?? Pick(assemblyVersion) ?? "unknown";

        // .NET appends "+<commit sha>" when the build has source information. That is
        // 41 characters of detail nobody reads off a rig card and would, on its own,
        // overrun the wire cap and take every heartbeat with it.
        var metadata = version.IndexOf('+');
        if (metadata >= 0) version = version[..metadata].TrimEnd();

        var reported = $"{Product}/{version}";
        return reported.Length <= MaxWireLength ? reported : reported[..MaxWireLength];
    }

    private static string? Pick(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}
