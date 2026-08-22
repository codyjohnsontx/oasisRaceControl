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

    /// <summary>Statuses that mean the backend is done with a lap and the agent
    /// may delete it from the outbox. Anything else - a lap the backend could
    /// not attribute, or a status this agent version does not recognise - keeps
    /// the lap queued, because the only durable copy is the one on this disk.</summary>
    private static readonly HashSet<string> SettledStatuses =
        new(StringComparer.Ordinal) { "accepted", "accepted_invalid", "duplicate" };

    /// <summary>Submit a batch of queued lap payloads. Returns the event_ids the
    /// backend accepted or deduplicated (safe to remove from the queue). Laps the
    /// backend refuses - because nobody was checked in when they were captured,
    /// or because it does not recognise the assignment - are NOT returned, so
    /// they stay queued rather than being silently dropped.</summary>
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

        // Match each result to its event by the idempotency key it echoes back,
        // never by position. Deleting the wrong row here would drop a lap that
        // was never stored, and position is the kind of assumption that holds
        // until the day the backend batches, reorders, or filters a response.
        var sent = new HashSet<string>(events.Select(e => e.EventId), StringComparer.Ordinal);
        var settled = new List<string>();
        foreach (var result in results)
        {
            var eventId = result?["eventId"]?.GetValue<string>();
            var status = result?["status"]?.GetValue<string>();
            if (eventId is null || status is null) continue;
            if (SettledStatuses.Contains(status) && sent.Remove(eventId))
                settled.Add(eventId);
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
