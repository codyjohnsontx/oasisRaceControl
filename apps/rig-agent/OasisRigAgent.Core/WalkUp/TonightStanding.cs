using System.Text.Json.Nodes;

namespace OasisRigAgent.Core.WalkUp;

/// <summary>One row of tonight's leaderboard as the public feed gives it.</summary>
public sealed record TonightRow(string DriverId, string DisplayName, int LapTimeMs);

/// <summary>
/// Where the seated driver stands on tonight's leaderboard, for the top of the
/// driving screen: their best valid lap tonight and their place among the
/// drivers with one. Both come from the same public feed the wall's tonight
/// board polls (`GET /api/leaderboard/tonight?limit=all`), so the rig and the
/// wall agree by construction - a lap in the wrong car, or over the incident
/// limit, is on neither. Null place and best lap mean the driver has no valid
/// lap tonight yet, which is the normal state while they warm up.
/// </summary>
public sealed record TonightStanding(int? Place, int Drivers, int? BestLapMs, string? Combo)
{
    /// <summary>The driver's standing in a feed answer. The feed is ordered
    /// fastest first, so a driver's place is their row's position; drivers
    /// is how many rows there are.</summary>
    public static TonightStanding For(IReadOnlyList<TonightRow> rows, string driverId, string? combo)
    {
        for (var i = 0; i < rows.Count; i++)
        {
            if (rows[i].DriverId == driverId)
                return new TonightStanding(i + 1, rows.Count, rows[i].LapTimeMs, combo);
        }
        return new TonightStanding(null, rows.Count, null, combo);
    }

    /// <summary>True when the driver is leading tonight.</summary>
    public bool Leading => Place == 1;
}

/// <summary>What one poll of the feed holds: every row and tonight's combo.</summary>
public sealed record TonightBoard(IReadOnlyList<TonightRow> Rows, string? Combo)
{
    /// <summary>The feed's JSON as the route writes it: `rows` fastest first,
    /// and `combo` (null when no featured combo is set today).</summary>
    public static TonightBoard Parse(JsonNode? body)
    {
        var rows = new List<TonightRow>();
        foreach (var row in body?["rows"]?.AsArray() ?? throw new FormatException("the tonight feed had no rows"))
        {
            var driverId = row?["driver_id"]?.GetValue<string>();
            var name = row?["display_name"]?.GetValue<string>();
            var lapTimeMs = row?["lap_time_ms"]?.GetValue<int>();
            if (driverId is null || name is null || lapTimeMs is null)
                throw new FormatException("a tonight row lacked its driver, name or time");
            rows.Add(new TonightRow(driverId, name, lapTimeMs.Value));
        }
        var combo = body["combo"] is JsonObject c
            ? string.Join(" · ", new[] { c["track_name"]?.GetValue<string>(), c["track_config"]?.GetValue<string>(), c["car_name"]?.GetValue<string>() }
                .Where(part => !string.IsNullOrWhiteSpace(part)))
            : null;
        return new TonightBoard(rows, string.IsNullOrEmpty(combo) ? null : combo);
    }
}

/// <summary>Reads the public tonight feed. No cookie, no token: the same
/// request a wall or a phone makes.</summary>
public sealed class TonightBoardClient
{
    private readonly HttpClient _http;
    private readonly Uri _feed;

    public TonightBoardClient(HttpClient http, string baseUrl)
    {
        _http = http;
        _feed = new Uri(new Uri(baseUrl.TrimEnd('/') + "/"), "api/leaderboard/tonight?limit=all");
    }

    public async Task<TonightBoard> FetchAsync(CancellationToken ct)
    {
        using var res = await _http.GetAsync(_feed, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        res.EnsureSuccessStatusCode();
        await using var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return TonightBoard.Parse(await JsonNode.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false));
    }
}
