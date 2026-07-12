using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OasisRigAgent.Core;

/// <summary>
/// Talks to the Oasis Race Control backend on behalf of one rig. Every request
/// carries the rig's bearer token, so the backend only ever lets it act on its
/// own rig.
/// </summary>
public sealed class BackendClient
{
    private readonly HttpClient _http;

    public BackendClient(HttpClient http, string baseUrl, string rigToken)
    {
        _http = http;
        _http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", rigToken);
    }

    /// <summary>Send a heartbeat so the rig shows as online on the staff dashboard.</summary>
    public async Task HeartbeatAsync(string agentVersion, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["events"] = new JsonArray(
                new JsonObject { ["type"] = "RIG_HEARTBEAT", ["agentVersion"] = agentVersion }),
        };
        using var res = await PostJsonAsync("api/agent/events", body, ct);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>Submit a batch of queued lap payloads. Returns the event_ids the
    /// backend accepted or deduplicated (safe to remove from the queue). Laps
    /// rejected because no driver is checked in are NOT returned, so they stay
    /// queued until someone checks in.</summary>
    public async Task<IReadOnlyList<string>> SendLapsAsync(IReadOnlyList<QueuedEvent> events, CancellationToken ct)
    {
        var array = new JsonArray();
        foreach (var e in events) array.Add(e.Payload.DeepClone());
        var body = new JsonObject { ["events"] = array };

        using var res = await PostJsonAsync("api/agent/events", body, ct);
        res.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        var results = json?["results"]?.AsArray();
        if (results is null) return Array.Empty<string>();

        // Map each result back to its event by order (the API preserves order).
        var settled = new List<string>();
        for (var i = 0; i < results.Count && i < events.Count; i++)
        {
            var status = results[i]?["status"]?.GetValue<string>();
            if (status is "accepted" or "accepted_invalid" or "duplicate")
                settled.Add(events[i].EventId);
        }
        return settled;
    }

    /// <summary>The rig's current driver assignment, or null if nobody is checked in.</summary>
    public async Task<Assignment?> GetAssignmentAsync(CancellationToken ct)
    {
        using var res = await _http.GetAsync("api/agent/assignment", ct);
        res.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        var a = json?["assignment"];
        if (a is null || a is JsonValue) return null;

        return new Assignment(
            a["id"]!.GetValue<string>(),
            a["driver"]!["id"]!.GetValue<string>(),
            a["driver"]!["displayName"]!.GetValue<string>(),
            DateTimeOffset.Parse(a["startedAt"]!.GetValue<string>()));
    }

    /// <summary>End the rig's current assignment (the "switch driver" button).</summary>
    public async Task<bool> CheckoutAsync(CancellationToken ct)
    {
        using var res = await _http.PostAsync("api/agent/checkout", null, ct);
        res.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        return json?["ended"]?.GetValue<bool>() ?? false;
    }

    private Task<HttpResponseMessage> PostJsonAsync(string path, JsonNode body, CancellationToken ct)
    {
        var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return _http.PostAsync(path, content, ct);
    }
}
