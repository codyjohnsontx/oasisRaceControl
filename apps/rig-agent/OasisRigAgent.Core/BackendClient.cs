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

    /// <summary>
    /// Send a heartbeat so the rig shows as online on the staff dashboard, carrying
    /// what this machine can currently do with its simulator.
    ///
    /// The health goes on every heartbeat rather than only when it changes: it is a
    /// live reading the backend replaces each time, so a rig that goes quiet and comes
    /// back needs no catch-up, and no missed message can leave a stale verdict on the
    /// board. <paramref name="detail"/> is only sent with
    /// <see cref="SimHealth.Unreadable"/>, because it is the answer to "why".
    /// </summary>
    public async Task HeartbeatAsync(
        string agentVersion,
        SimHealth sim,
        string? detail,
        InstallationIdentity? installation,
        CancellationToken ct)
    {
        var heartbeat = new JsonObject
        {
            ["type"] = "RIG_HEARTBEAT",
            ["agentVersion"] = agentVersion,
            ["simHealth"] = sim.WireName(),
        };
        if (installation is not null)
        {
            // Which computer this heartbeat came from. The backend holds a rig's
            // laps back while two live installations claim it, because it cannot
            // tell which machine's customer a lap belongs to.
            heartbeat["installationId"] = installation.Id;
            heartbeat["machineName"] = installation.MachineName;
        }
        if (sim == SimHealth.Unreadable && !string.IsNullOrWhiteSpace(detail))
        {
            // The contract caps this; a truncated explanation still names the first
            // channels, which is worth more than a 400 that loses the whole heartbeat.
            heartbeat["simHealthDetail"] = detail.Length > 300 ? detail[..300] : detail;
        }

        var body = new JsonObject { ["events"] = new JsonArray(heartbeat) };
        using var res = await PostJsonAsync("api/agent/events", body, ct);
        EnsureIdentityAccepted(res);
        res.EnsureSuccessStatusCode();
    }

    /// <summary>Statuses the backend can return for a lap that mean the queue
    /// entry is finished with, whether it was stored (`accepted`,
    /// `accepted_invalid`, `duplicate`) or refused (`no_active_assignment` when
    /// nobody could own it, `assignment_mismatch` when the driver this rig
    /// named could not).
    ///
    /// Both refusals are terminal, not "try again later": the backend only ever
    /// attributes a lap to an assignment whose window contains the lap's own
    /// completion time, so a lap it declines to own now can never be owned by a
    /// later check-in. Leaving those queued would retry them until closing time
    /// and hold every lap behind them. `error` is deliberately absent — that is
    /// a server-side failure worth retrying, and so is `rig_conflict`: the
    /// backend is refusing to guess which of two computers sharing this rig's
    /// token drove the lap, and the lap becomes deliverable the moment somebody
    /// gives the second machine its own token.</summary>
    /// <summary>The backend's answer when this rig's token is in use by a second
    /// computer. Not settled: the lap keeps its place in the queue.</summary>
    public const string RigConflictStatus = "rig_conflict";

    private static readonly HashSet<string> SettledStatuses = new(StringComparer.Ordinal)
    {
        "accepted",
        "accepted_invalid",
        "duplicate",
        "no_active_assignment",
        "assignment_mismatch",
    };

    /// <summary>Submit a batch of queued lap payloads.
    ///
    /// The backend validates the request as one document, so a single event it
    /// cannot parse fails the whole batch with a 400 and none of the laps behind
    /// it are ever looked at. Left alone that is permanent: the rig resubmits the
    /// same doomed batch every five seconds until closing time, laps stop
    /// appearing on the leaderboard, and the staff dashboard shows a rig that has
    /// been offline for hours. So a 400 is not retried — the batch is halved
    /// until the offending event is alone, which sends the rest of the laps on
    /// their way and names the one that has to be set aside.</summary>
    public async Task<LapSubmission> SendLapsAsync(IReadOnlyList<QueuedEvent> events, CancellationToken ct)
    {
        if (events.Count == 0) return LapSubmission.Empty;

        var array = new JsonArray();
        foreach (var e in events) array.Add(e.Payload.DeepClone());
        var body = new JsonObject { ["events"] = array };

        using var res = await PostJsonAsync("api/agent/events", body, ct);

        // Asked before the 400 branch: a refused identity is not a document the
        // backend could not parse, and halving the batch to find "the one bad
        // lap" would quarantine good customer times to explain a wrong token.
        EnsureIdentityAccepted(res);

        if (res.StatusCode == System.Net.HttpStatusCode.BadRequest)
        {
            var detail = Summarize(await res.Content.ReadAsStringAsync(ct));

            // One event left and the backend still refuses the document: this is
            // the one. It is quarantined rather than dropped, because a 400 from
            // something in front of the backend would look identical from here
            // and the lap should still be recoverable from the rig.
            if (events.Count == 1)
                return new LapSubmission(Array.Empty<string>(), new[] { new RejectedEvent(events[0].EventId, detail) });

            var half = events.Count / 2;
            var first = await SendLapsAsync(events.Take(half).ToList(), ct);
            var second = await SendLapsAsync(events.Skip(half).ToList(), ct);
            return first.Concat(second);
        }

        res.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        var results = json?["results"]?.AsArray();
        if (results is null) return LapSubmission.Empty;

        // Map each result back to its event by order (the API preserves order).
        var settled = new List<string>();
        var heldForConflict = 0;
        for (var i = 0; i < results.Count && i < events.Count; i++)
        {
            var status = results[i]?["status"]?.GetValue<string>();
            if (status is null) continue;
            if (SettledStatuses.Contains(status)) settled.Add(events[i].EventId);
            else if (status == RigConflictStatus) heldForConflict++;
        }
        return new LapSubmission(settled, Array.Empty<RejectedEvent>(), heldForConflict);
    }

    /// <summary>A refusal reason short enough for a rig's log line, from a body
    /// that may be a zod issue list, an HTML error page, or nothing at all.</summary>
    private static string Summarize(string body)
    {
        var text = body.Replace('\n', ' ').Replace('\r', ' ').Trim();
        if (text.Length == 0) return "HTTP 400 with no body";
        return text.Length <= 300 ? text : text[..300] + "…";
    }

    /// <summary>
    /// The rig's current driver assignment, and the rig the backend authenticated
    /// this token as.
    ///
    /// The two arrive together because they answer the same question - who is this
    /// machine working for - and because this is the agent's one read-only call, so
    /// it is also the one <c>--check-backend</c> may run against a rig with a
    /// customer on it. The rig identity is optional on the wire: a backend older
    /// than this agent does not send it, and a fleet part-way through a deploy must
    /// not have rigs accusing themselves (<see cref="RigIdentity"/>).
    /// </summary>
    public async Task<AssignmentPoll> GetAssignmentAsync(CancellationToken ct)
    {
        using var res = await _http.GetAsync("api/agent/assignment", ct);
        EnsureIdentityAccepted(res);
        res.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        return new AssignmentPoll(ReadAssignment(json?["assignment"]), ReadRig(json?["rig"]));
    }

    private static Assignment? ReadAssignment(JsonNode? a)
    {
        if (a is null || a is JsonValue) return null;
        return new Assignment(
            a["id"]!.GetValue<string>(),
            a["driver"]!["id"]!.GetValue<string>(),
            a["driver"]!["displayName"]!.GetValue<string>(),
            DateTimeOffset.Parse(a["startedAt"]!.GetValue<string>()));
    }

    /// <summary>Reads the rig the backend says this token is, tolerating every way
    /// it can be absent or unusable. A malformed answer is not evidence that this
    /// machine is the wrong rig, so it reads as "not said" rather than raising -
    /// the only thing that stops a rig scoring here is two numbers that disagree.</summary>
    private static BackendRigIdentity? ReadRig(JsonNode? rig)
    {
        if (rig is null || rig is JsonValue) return null;
        try
        {
            var number = rig["number"]?.GetValue<int>() ?? 0;
            if (number <= 0) return null;
            var name = rig["displayName"]?.GetValue<string>();
            return new BackendRigIdentity(number, string.IsNullOrWhiteSpace(name) ? $"Rig {number:D2}" : name);
        }
        catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
        {
            return null;
        }
    }

    /// <summary>End the rig's current assignment (the "switch driver" button).</summary>
    public Task<bool> CheckoutAsync(CancellationToken ct) => CheckoutAsync(null, null, ct);

    /// <summary>
    /// End a rig assignment.
    /// </summary>
    /// <param name="assignmentId">The assignment to end, or null for "whoever is
    /// checked in" - which is what the rig's own sign-out button means, because the
    /// person pressing it is standing at the machine. An automatic sign-out names the
    /// assignment it judged instead: a walk-in can scan the QR code between the
    /// decision and this request, and the backend must close the session that went
    /// idle or nothing at all.</param>
    /// <param name="reason">Why, as the backend spells it (<c>idle_timeout</c>); null
    /// leaves the backend's default, which is the driver switching at the rig.</param>
    public async Task<bool> CheckoutAsync(string? assignmentId, string? reason, CancellationToken ct)
    {
        HttpContent? content = null;
        if (assignmentId is not null || reason is not null)
        {
            var body = new JsonObject();
            if (assignmentId is not null) body["assignmentId"] = assignmentId;
            if (reason is not null) body["reason"] = reason;
            content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        using var res = await _http.PostAsync("api/agent/checkout", content, ct);
        EnsureIdentityAccepted(res);
        res.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
        return json?["ended"]?.GetValue<bool>() ?? false;
    }

    /// <summary>Raises the one failure that is not "try again later".
    ///
    /// Called on every response this client reads, because the rig has to say the
    /// same thing whichever call happened to run first - and the heartbeat, the
    /// driver poll, the lap flush and the sign-out all run on their own timers.
    /// The typed failure still fails the call, so a rig with a refused token keeps
    /// every lap in its outbox exactly as an offline one does.</summary>
    private static void EnsureIdentityAccepted(HttpResponseMessage res)
    {
        if (BackendReach.IsIdentityRefusal(res.StatusCode))
            throw new BackendRejectedException(res.StatusCode);
    }

    private Task<HttpResponseMessage> PostJsonAsync(string path, JsonNode body, CancellationToken ct)
    {
        var content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return _http.PostAsync(path, content, ct);
    }
}

/// <summary>What a submission did to the batch: the events the queue may drop
/// (stored, deduplicated, or permanently refused after being judged), the events
/// the backend would not parse at all, which must be set aside instead of
/// resubmitted, and how many the backend is holding because a second computer is
/// using this rig's token.</summary>
public sealed record LapSubmission(
    IReadOnlyList<string> Settled,
    IReadOnlyList<RejectedEvent> Rejected,
    int HeldForRigConflict = 0)
{
    public static readonly LapSubmission Empty =
        new(Array.Empty<string>(), Array.Empty<RejectedEvent>());

    public LapSubmission Concat(LapSubmission other) => new(
        Settled.Concat(other.Settled).ToList(),
        Rejected.Concat(other.Rejected).ToList(),
        HeldForRigConflict + other.HeldForRigConflict);
}

/// <summary>An event the backend refused to parse, with what it said about it.</summary>
public sealed record RejectedEvent(string EventId, string Reason);

/// <summary>What one assignment poll learned: who is checked in on this rig, and
/// which rig the backend authenticated this computer's token as. Either may be
/// null - nobody is checked in, and a backend older than this agent does not say
/// which rig it thinks is asking.</summary>
public sealed record AssignmentPoll(Assignment? Assignment, BackendRigIdentity? Rig);
