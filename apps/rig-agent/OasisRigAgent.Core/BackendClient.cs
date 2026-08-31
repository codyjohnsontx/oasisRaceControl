using System.Globalization;
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

    /// <summary>Statuses that mean the lap is now the backend's problem and the
    /// agent may delete it from the outbox. "accepted_unattributed" counts: the
    /// lap IS stored, just with no driver, so keeping it here would grow the
    /// outbox without bound on a rig nobody checks into. Anything else - an
    /// error, or a status this agent version does not recognise - keeps the lap
    /// queued, because the only durable copy is the one on this disk.</summary>
    private static readonly HashSet<string> SettledStatuses =
        new(StringComparer.Ordinal)
        {
            "accepted", "accepted_invalid", "accepted_unattributed", "duplicate",
        };

    /// <summary>Submit a batch of queued lap payloads.
    ///
    /// Two answers come back, and the difference is the point. <em>Settled</em>
    /// event_ids are the ones the backend stored or deduplicated, safe to remove
    /// from the queue; anything it did not store - a transient error, or a status
    /// this agent is too old to understand - is left out, so the lap stays queued
    /// rather than being silently dropped. <em>Rejected</em> events are the ones
    /// it refused as invalid input, named individually, which the caller must
    /// stop sending.
    ///
    /// Only a call that could not reach a backend at all still throws.</summary>
    public async Task<SendLapsOutcome> SendLapsAsync(IReadOnlyList<QueuedEvent> events, CancellationToken ct)
    {
        var array = new JsonArray();
        foreach (var e in events) array.Add(e.Payload.DeepClone());
        var body = new JsonObject { ["events"] = array };

        using var res = await PostJsonAsync("api/agent/events", body, ct);
        var payload = await res.Content.ReadAsStringAsync(ct);

        // A refusal is an answer, not an outage. The batch is validated whole,
        // so one bad lap fails all of them; throwing here - which is what this
        // did - marked the rig offline and left the next flush re-sending the
        // identical batch every five seconds, with every lap queued behind the
        // bad one going nowhere for the rest of the night.
        //
        // Only a refusal that NAMES the events it is about is treated this way.
        // A 401 from a rotated token, a 429, a proxy's HTML error page: all 4xx,
        // none of them says which lap is wrong, and parking laps on any of them
        // would quarantine a whole venue's night over a bad token. Those still
        // throw, so they keep retrying and lose nothing.
        if ((int)res.StatusCode is >= 400 and < 500)
        {
            var rejected = ReadRejections(payload, events);
            if (rejected.Count > 0) return new SendLapsOutcome(Array.Empty<string>(), rejected);
        }
        res.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(payload);
        var results = json?["results"]?.AsArray();
        if (results is null) return SendLapsOutcome.Empty;

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
        return new SendLapsOutcome(settled, Array.Empty<RejectedEvent>());
    }

    /// <summary>Which of the events just sent the backend named as invalid, read
    /// from the zod issue list it returns as `detail`.
    ///
    /// Events are identified by their POSITION in the batch - `events[1]` is the
    /// second payload posted - which is the same key the backend's own
    /// attribution uses and for the same reason: a batch may legitimately repeat
    /// an eventId, so position is the only field unique per row by construction.
    ///
    /// Deliberately unforgiving: an index this batch does not contain, a path
    /// that is not about `events`, a body that is not JSON at all - each is
    /// skipped, and a response that yields nothing usable ends up back on the
    /// throwing path rather than quarantining a lap on a guess.</summary>
    private static IReadOnlyList<RejectedEvent> ReadRejections(
        string body, IReadOnlyList<QueuedEvent> sent)
    {
        JsonNode? json;
        try { json = JsonNode.Parse(body); }
        catch (JsonException) { return Array.Empty<RejectedEvent>(); }

        // Matched as objects before either is indexed, because indexing a
        // JSON node that is not one throws rather than answering null: a 4xx
        // body that is a bare number, a string, or a gateway's top-level array
        // would leave this method by an exception, and the whole point of it is
        // that a reachable backend's refusal never does that.
        if (json is not JsonObject root || root["detail"] is not JsonArray issues)
            return Array.Empty<RejectedEvent>();

        // First reason wins per lap: several issues can name the same event, and
        // one line a human can act on beats a concatenation of all of them.
        var reasons = new Dictionary<string, string>(StringComparer.Ordinal);
        var order = new List<string>();
        foreach (var issue in issues)
        {
            if (issue is not JsonObject fields) continue;
            if (fields["path"] is not JsonArray path || path.Count < 2) continue;
            if (Text(path[0]) != "events") continue;
            if (path[1] is not JsonValue at || !at.TryGetValue<int>(out var index)) continue;
            if (index < 0 || index >= sent.Count) continue;

            var eventId = sent[index].EventId;
            if (reasons.ContainsKey(eventId)) continue;
            reasons[eventId] = Describe(fields, path);
            order.Add(eventId);
        }
        return order.Select(id => new RejectedEvent(id, reasons[id])).ToList();
    }

    /// <summary>One issue as a line worth printing on a rig: the field it is
    /// about, then what was wrong with it.</summary>
    private static string Describe(JsonObject issue, JsonArray path)
    {
        var field = string.Join(
            ".", path.Skip(2).Select(Text).Where(part => part.Length > 0));
        var message = Text(issue["message"]);
        if (message.Length == 0) message = Text(issue["code"]);
        if (message.Length == 0) message = "rejected as invalid input";
        return field.Length == 0 ? message : $"{field}: {message}";
    }

    /// <summary>A JSON node as plain text, empty when it is absent or not a
    /// string - a path element is normally a string or a number and neither may
    /// throw here.</summary>
    private static string Text(JsonNode? node)
        => node is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : node?.ToString() ?? "";

    /// <summary>The rig's current driver assignment (null if nobody is checked
    /// in), together with the offset between this machine's clock and the
    /// server's, read from the response's Date header. Attribution compares a
    /// rig-stamped completedAt against a server-stamped StartedAt, so it needs
    /// that offset to stay within one clock; a missing Date header falls back to
    /// zero, which is the old same-clock assumption and no worse than it.</summary>
    public async Task<AssignmentPoll> GetAssignmentAsync(CancellationToken ct)
    {
        using var res = await _http.GetAsync("api/agent/assignment", ct);
        res.EnsureSuccessStatusCode();

        // Read the clock before touching the body: the closer this is to the
        // response arriving, the less network time leaks into the offset.
        var offset = res.Headers.Date is { } serverNow
            ? serverNow - DateTimeOffset.UtcNow
            : TimeSpan.Zero;

        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        var a = json?["assignment"];
        if (a is null || a is JsonValue) return new AssignmentPoll(null, offset);

        return new AssignmentPoll(new Assignment(
            a["id"]!.GetValue<string>(),
            a["driver"]!["id"]!.GetValue<string>(),
            a["driver"]!["displayName"]!.GetValue<string>(),
            // Parsed against InvariantCulture, not the machine's. This value is
            // one side of the completedAt >= StartedAt comparison that decides
            // who owns a deferred lap, and EventQueue.OwnerOf already parses its
            // side invariantly; both sides should read a machine-generated
            // timestamp the same way on any rig.
            //
            // Measured, not assumed: DateTimeOffset.Parse WITHOUT a provider also
            // returns the correct instant for this input, including with a
            // ThaiBuddhistCalendar forced onto CurrentCulture - .NET recognises
            // ISO 8601 with a Z offset through a culture-invariant path. So this
            // is defence in depth against a future format change, not a fix for
            // a reproduced misparse.
            DateTimeOffset.Parse(
                a["startedAt"]!.GetValue<string>(), CultureInfo.InvariantCulture)), offset);
    }

    /// <summary>End one of the rig's assignments - the "switch driver" button.
    /// Returns whether this call was the one that closed it.
    ///
    /// <paramref name="assignmentId"/> names the stint to end. Naming it is what
    /// makes the call safe to repeat: a checkout the agent could not deliver
    /// when the driver pressed the button is re-sent later, by which time the
    /// seat may legitimately belong to somebody else, and an unqualified "close
    /// whatever is open on this rig" would end THEIR stint instead. A backend
    /// that has already closed the named assignment - staff cleared the rig, or
    /// the next driver's check-in took it over - answers false and changes
    /// nothing, so the retry is a no-op rather than a second effect.
    ///
    /// Null means the unqualified form, which is still what the button sends
    /// when the agent has never managed to poll and so cannot name the
    /// stint.</summary>
    public async Task<bool> CheckoutAsync(string? assignmentId, CancellationToken ct)
    {
        var body = new JsonObject();
        if (assignmentId is not null) body["assignmentId"] = assignmentId;

        using var res = await PostJsonAsync("api/agent/checkout", body, ct);
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

/// <summary>What one flush learned. Settled laps are gone from the backend's
/// point of view and can leave the outbox; rejected laps were refused by name
/// and must stop being offered. Both lists are usually empty - the ordinary
/// case is that everything sent was stored.</summary>
public sealed record SendLapsOutcome(
    IReadOnlyList<string> Settled, IReadOnlyList<RejectedEvent> Rejected)
{
    public static SendLapsOutcome Empty { get; } =
        new(Array.Empty<string>(), Array.Empty<RejectedEvent>());
}
