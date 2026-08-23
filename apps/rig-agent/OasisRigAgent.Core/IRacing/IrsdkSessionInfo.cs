using System.Globalization;
using System.Text;

namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// What the venue needs to label a lap: which track/configuration it was set on,
/// and which car set it. These are the names customers read on the leaderboard,
/// so they come from the sim's display names rather than its internal slugs.
/// </summary>
public sealed record SimSessionIdentity(
    string TrackName,
    string? TrackConfig,
    string CarName,
    int? TrackId,
    int? CarId)
{
    /// <summary>Identity of the track/car combination, for detecting a combo change.</summary>
    public string ComboKey => $"{TrackName}|{TrackConfig}|{CarName}";
}

/// <summary>
/// Extracts the handful of fields the venue needs from the sim's session-metadata
/// payload.
///
/// The payload is a large YAML document, but the agent deliberately does not take
/// a YAML library dependency (<c>docs/venue-safety.md</c> bounds what runs on venue
/// computers). It is also not general YAML in practice: the sim emits a flat,
/// machine-generated subset - one <c>key: value</c> per line, space indentation,
/// and list entries introduced by <c>- </c>. This scanner reads only that subset,
/// treats every value as an opaque string, and never evaluates anything.
///
/// Nothing here throws on unfamiliar content: an unrecognised or truncated payload
/// yields null, which the caller treats as "the combo is not known yet" and holds
/// laps rather than mislabelling them.
/// </summary>
public static class IrsdkSessionInfo
{
    private const int MaximumLines = 200_000;

    public static SimSessionIdentity? Parse(byte[]? payload)
    {
        if (payload is null || payload.Length == 0) return null;
        return Parse(DecodeText(payload));
    }

    public static SimSessionIdentity? Parse(string text)
    {
        string? trackDisplayName = null, trackName = null, trackConfig = null;
        int? trackId = null;
        int? driverCarIdx = null;
        var cars = new Dictionary<int, (string? ScreenName, int? CarId)>();

        var section = string.Empty;
        var inDriversList = false;
        int? currentCarIdx = null;
        var lines = 0;

        foreach (var raw in EnumerateLines(text))
        {
            if (++lines > MaximumLines) break;
            if (raw.Length == 0) continue;

            var indent = CountIndent(raw);
            var line = raw[indent..].TrimEnd();
            if (line.Length == 0 || line[0] == '#' || line is "---" or "...") continue;

            // A top-level key opens a section. Everything indented under it belongs
            // to that section until the next one.
            if (indent == 0)
            {
                section = TrimKey(line);
                inDriversList = false;
                currentCarIdx = null;
                continue;
            }

            var isListEntry = line[0] == '-';
            if (isListEntry) line = line[1..].TrimStart();
            if (line.Length == 0) continue;

            var separator = line.IndexOf(':');
            if (separator <= 0) continue;
            var key = line[..separator].Trim();
            var value = CleanValue(line[(separator + 1)..]);

            switch (section)
            {
                case "WeekendInfo":
                    // First occurrence wins: these keys sit directly under WeekendInfo,
                    // ahead of its nested WeekendOptions block.
                    if (key == "TrackDisplayName") trackDisplayName ??= value;
                    else if (key == "TrackName") trackName ??= value;
                    else if (key == "TrackConfigName") trackConfig ??= value;
                    else if (key == "TrackID") trackId ??= ParseInt(value);
                    break;

                case "DriverInfo":
                    if (key == "DriverCarIdx") driverCarIdx ??= ParseInt(value);
                    else if (key == "Drivers") inDriversList = true;
                    else if (!inDriversList) break;
                    else if (isListEntry && key == "CarIdx")
                    {
                        currentCarIdx = ParseInt(value);
                        if (currentCarIdx is int started) cars.TryAdd(started, (null, null));
                    }
                    else if (currentCarIdx is int idx && cars.TryGetValue(idx, out var car))
                    {
                        if (key == "CarScreenName") cars[idx] = car with { ScreenName = NullIfEmpty(value) };
                        else if (key == "CarID") cars[idx] = car with { CarId = ParseInt(value) };
                    }
                    break;
            }
        }

        var track = NullIfEmpty(trackDisplayName) ?? NullIfEmpty(trackName);
        if (track is null) return null;

        // Only the checked-in driver's own car labels the lap. Without the index we
        // cannot tell which entry is theirs, and guessing would mislabel every lap.
        if (driverCarIdx is not int playerIdx || !cars.TryGetValue(playerIdx, out var player)) return null;
        if (player.ScreenName is null) return null;

        return new SimSessionIdentity(
            TrackName: Clamp(track),
            TrackConfig: NullIfEmpty(trackConfig) is { } config ? Clamp(config) : null,
            CarName: Clamp(player.ScreenName),
            TrackId: trackId,
            CarId: player.CarId);
    }

    /// <summary>
    /// The payload is a fixed-size region, so it carries whatever trailing bytes the
    /// producer left behind. Read up to the first terminator and no further.
    /// </summary>
    private static string DecodeText(byte[] payload)
    {
        var end = Array.IndexOf(payload, (byte)0);
        if (end < 0) end = payload.Length;
        return Encoding.UTF8.GetString(payload, 0, end);
    }

    private static IEnumerable<string> EnumerateLines(string text)
    {
        var start = 0;
        while (start <= text.Length)
        {
            var end = text.IndexOf('\n', start);
            if (end < 0)
            {
                yield return text[start..].TrimEnd('\r');
                yield break;
            }

            yield return text[start..end].TrimEnd('\r');
            start = end + 1;
        }
    }

    private static int CountIndent(string line)
    {
        var index = 0;
        while (index < line.Length && (line[index] == ' ' || line[index] == '\t')) index++;
        return index;
    }

    private static string TrimKey(string line)
    {
        var separator = line.IndexOf(':');
        return separator < 0 ? line.Trim() : line[..separator].Trim();
    }

    /// <summary>The sim quotes any value that would otherwise break the line.</summary>
    private static string CleanValue(string value)
    {
        value = value.Trim();
        if (value.Length >= 2 && (value[0] == '"' || value[0] == '\'') && value[^1] == value[0])
            value = value[1..^1];
        return value.Trim();
    }

    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    private static int? ParseInt(string value) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;

    /// <summary>The backend rejects names longer than 120 characters; truncate rather
    /// than lose the whole lap to a validation error.</summary>
    private static string Clamp(string value) => value.Length <= 120 ? value : value[..120];
}
