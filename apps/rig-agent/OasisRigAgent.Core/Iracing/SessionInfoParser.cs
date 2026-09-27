using System.Text;
using System.Text.RegularExpressions;

namespace OasisRigAgent.Core.Iracing;

/// <summary>
/// The three strings a lap is judged against, as iRacing itself spells them.
///
/// `TrackDisplayName` and `TrackConfigName` come from `WeekendInfo`; the car is
/// the player's own entry in `DriverInfo.Drivers`, found by `DriverCarIdx`. The
/// featured combo on the backend matches these by exact string equality
/// (`apps/web/src/lib/validity.ts`), which is why the agent logs them verbatim
/// and the diagnostic mode prints them for staff to copy.
/// </summary>
public sealed record SessionCombo(
    string TrackDisplayName,
    /// <summary>Null for a single-layout track, where iRacing leaves the field empty.</summary>
    string? TrackConfigName,
    string CarScreenName,
    int PlayerCarIdx,
    /// <summary>iRacing's internal short track name (e.g. "cota gp") and numeric ids -
    /// printed by the diagnostic so a wrong display string can still be traced.</summary>
    string? TrackName,
    int? TrackId,
    int? CarId);

/// <summary>
/// Pulls the combo out of iRacing's session-info YAML with a line scanner
/// instead of a YAML library. The document is machine-written with a fixed
/// shape (one `key: value` per line, list items as `- CarIdx: n` followed by
/// indented fields), so a scanner is enough and keeps the agent free of a
/// parser that would have to be trusted with untrusted shared memory.
/// </summary>
public static class SessionInfoParser
{
    private static readonly Regex KeyValue = new(@"^\s*(-\s*)?([A-Za-z0-9_]+):\s*(.*?)\s*$", RegexOptions.Compiled);

    /// <summary>The session string up to its NUL terminator; the region after it
    /// is padding or the tail of an older, longer document.</summary>
    public static string Decode(ReadOnlySpan<byte> bytes)
    {
        var end = bytes.IndexOf((byte)0);
        if (end >= 0) bytes = bytes[..end];

        // iRacing writes the session string in the sim's own encoding, which is
        // UTF-8 for current builds and Latin-1 for some older ones. Try strict
        // UTF-8 first and fall back rather than mangle an accented track name.
        try
        {
            return new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.Latin1.GetString(bytes);
        }
    }

    /// <summary>Null when the document does not yet carry a track display name and a
    /// car for the player - iRacing publishes session info in pieces while loading.
    /// <paramref name="telemetryPlayerCarIdx"/> is used when `DriverInfo.DriverCarIdx`
    /// is absent.</summary>
    public static SessionCombo? Parse(string yaml, int? telemetryPlayerCarIdx = null)
        => Scan(yaml, telemetryPlayerCarIdx).Combo;

    /// <summary>What the scanner did find, for a document <see cref="Parse"/> could
    /// not name a combo from - so a real session string this scanner does not
    /// match shows where it fell short.</summary>
    public static string DescribeFound(string yaml, int? telemetryPlayerCarIdx = null)
        => Scan(yaml, telemetryPlayerCarIdx).Found;

    private static (SessionCombo? Combo, string Found) Scan(string yaml, int? telemetryPlayerCarIdx)
    {
        string? trackDisplayName = null, trackConfigName = null, trackName = null;
        int? trackId = null, driverCarIdx = null;
        var cars = new Dictionary<int, (string? ScreenName, int? CarId)>();
        int? currentCarIdx = null;
        var section = "";

        foreach (var rawLine in yaml.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (line.Length == 0) continue;
            if (!char.IsWhiteSpace(line[0]) && line[0] != '-')
            {
                // Top-level section header such as `WeekendInfo:` or `DriverInfo:`.
                var header = KeyValue.Match(line);
                section = header.Success ? header.Groups[2].Value : "";
                currentCarIdx = null;
                continue;
            }

            var m = KeyValue.Match(line);
            if (!m.Success) continue;
            var isListItem = m.Groups[1].Success && m.Groups[1].Value.Length > 0;
            var key = m.Groups[2].Value;
            var value = Unquote(m.Groups[3].Value);

            switch (section)
            {
                case "WeekendInfo":
                    if (key == "TrackDisplayName") trackDisplayName = value;
                    else if (key == "TrackConfigName") trackConfigName = value;
                    else if (key == "TrackName") trackName = value;
                    else if (key == "TrackID" && int.TryParse(value, out var tid)) trackId = tid;
                    break;
                case "DriverInfo":
                    if (key == "DriverCarIdx" && int.TryParse(value, out var idx)) driverCarIdx = idx;
                    if (isListItem && key == "CarIdx" && int.TryParse(value, out var carIdx))
                    {
                        currentCarIdx = carIdx;
                        cars.TryAdd(carIdx, (null, null));
                    }
                    else if (currentCarIdx is int cur && cars.TryGetValue(cur, out var entry))
                    {
                        if (key == "CarScreenName") cars[cur] = (value, entry.CarId);
                        else if (key == "CarID" && int.TryParse(value, out var cid)) cars[cur] = (entry.ScreenName, cid);
                    }
                    break;
            }
        }

        var playerIdx = driverCarIdx ?? telemetryPlayerCarIdx;
        var hasCar = cars.TryGetValue(playerIdx ?? -1, out var car);
        var found = $"TrackDisplayName={Quote(trackDisplayName)} TrackConfigName={Quote(trackConfigName)} "
                  + $"DriverCarIdx={driverCarIdx?.ToString() ?? "none"} telemetry PlayerCarIdx={telemetryPlayerCarIdx?.ToString() ?? "none"} "
                  + $"drivers listed={cars.Count} player's CarScreenName={(hasCar ? Quote(car.ScreenName) : "no entry")}";
        if (string.IsNullOrWhiteSpace(trackDisplayName) || playerIdx is null) return (null, found);
        if (!hasCar || string.IsNullOrWhiteSpace(car.ScreenName)) return (null, found);

        return (new SessionCombo(
            trackDisplayName,
            string.IsNullOrWhiteSpace(trackConfigName) ? null : trackConfigName,
            car.ScreenName,
            playerIdx.Value,
            trackName,
            trackId,
            car.CarId), found);
    }

    private static string Quote(string? value) => value is null ? "none" : $"\"{value}\"";

    private static string Unquote(string value)
    {
        if (value.Length >= 2 && value[0] == '\'' && value[^1] == '\'')
            return value[1..^1].Replace("''", "'");
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            return value[1..^1].Replace("\\\"", "\"");
        return value;
    }
}
