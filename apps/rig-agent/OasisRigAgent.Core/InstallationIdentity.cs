using System.Security.Cryptography;
using System.Text;

namespace OasisRigAgent.Core;

/// <summary>
/// Which computer this agent is running on, as far as the backend is concerned.
///
/// A rig's bearer token is its whole identity: the backend looks the token up,
/// finds one rig row, and every lap that arrives with it is credited to whoever
/// is checked in on that rig. That is fine while one token lives on one machine.
/// Installing twenty-plus rigs by copying a folder is how it stops being true -
/// copy <c>agent.config.json</c> along with the executable and two simulators
/// now share a rig. Nothing errors. Both machines heartbeat, both look healthy,
/// and half the laps on the board belong to the other customer.
///
/// So every heartbeat says which computer it came from, and the backend refuses
/// to attribute laps for a rig two live installations are claiming. The identity
/// has to survive a restart (or every restart would look like a second machine)
/// and has to differ between two machines however the mistake was made:
///
/// <list type="bullet">
/// <item>Copying the program folder to the next rig leaves the new machine
/// without an id file, so it mints its own.</item>
/// <item>Cloning a whole disk image copies the id file too - so the machine's
/// own name is folded in, and Windows machines on one network have different
/// names.</item>
/// </list>
///
/// Two clones that also share a hostname are indistinguishable to anything on
/// the network, and are not what this can catch.
/// </summary>
public sealed record InstallationIdentity(string Id, string MachineName)
{
    public const string FileName = "installation-id";

    /// <summary>Sent on the wire, so it is capped to what the contract accepts.</summary>
    public const int MaxMachineNameLength = 80;

    /// <summary>This machine, reading (and if needed creating) the seed in the
    /// agent's own data directory.</summary>
    public static InstallationIdentity ForMachine(AgentPaths paths, IAgentLog? log = null)
        => Resolve(paths.InstallationIdPath, Environment.MachineName, log);

    /// <summary>The identity rules, with the file and the machine name passed in
    /// so a venue's cases are reachable from a test on any platform.</summary>
    public static InstallationIdentity Resolve(string seedPath, string? machineName, IAgentLog? log = null)
    {
        var name = NormalizeName(machineName);
        var seed = ReadSeed(seedPath);

        if (seed is null)
        {
            seed = Guid.NewGuid().ToString("n");
            // A machine that cannot keep the seed still reports an identity - it
            // just mints a new one each start, which reads as this rig being
            // reinstalled rather than as a second computer. Losing the whole
            // check because a folder is read-only would be the worse trade.
            if (!TryWriteSeed(seedPath, seed))
                log?.Error($"[agent] could not save this machine's installation id to \"{seedPath}\"; "
                    + "it will be minted again at every start.");
        }

        return new InstallationIdentity(Fingerprint(seed, name), name);
    }

    /// <summary>Machine name and seed hashed together: the seed alone misses a
    /// cloned disk image, the name alone misses two agents on one machine, and
    /// neither is worth sending raw when a stable opaque id is all the backend
    /// compares.</summary>
    private static string Fingerprint(string seed, string machineName)
    {
        // Windows machine names are case-insensitive, so a rig re-registered as
        // "rig-03" must not read as a different computer from "RIG-03".
        var material = seed + "\n" + machineName.ToUpperInvariant();
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return Convert.ToHexString(hash).ToLowerInvariant()[..32];
    }

    private static string NormalizeName(string? machineName)
    {
        var name = machineName?.Trim();
        if (string.IsNullOrEmpty(name)) return "unnamed-pc";
        return name.Length > MaxMachineNameLength ? name[..MaxMachineNameLength] : name;
    }

    /// <summary>The saved seed, or null when there is none to trust. A blank,
    /// oversized or unreadable file is treated as absent rather than repaired,
    /// because a seed only has to be stable - what it says does not matter.</summary>
    private static string? ReadSeed(string path)
    {
        try
        {
            if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path).Trim();
            return text.Length is > 0 and <= 200 ? text : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return null;
        }
    }

    private static bool TryWriteSeed(string path, string seed)
    {
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(path, seed);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return false;
        }
    }
}
