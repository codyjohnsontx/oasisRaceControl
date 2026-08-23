using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

public sealed class BackendClientTests
{
    /// <summary>Captures the request and returns a canned response.</summary>
    private sealed class StubHandler(Func<HttpRequestMessage, (HttpStatusCode, string)> respond)
        : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
        public string? LastBody { get; private set; }

        /// <summary>Every request body in order — a batch the backend refuses is
        /// split and resent, so what matters is which events ended up where.</summary>
        public List<string> Bodies { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            if (LastBody is not null) Bodies.Add(LastBody);
            var (status, body) = respond(request);
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        }
    }



    private static QueuedEvent Queued(string id) => new(id, new JsonObject
    {
        ["type"] = "LAP_COMPLETED",
        ["eventId"] = id,
        ["trackName"] = "Spa-Francorchamps",
        ["carName"] = "Porsche 911 GT3 R",
        ["lapTimeMs"] = 138_000,
        ["completedAt"] = DateTimeOffset.UtcNow.ToString("o"),
    });

    [Theory]
    [InlineData(true, null, "scoring")]
    [InlineData(false, null, "no_sim")]
    [InlineData(false, "the simulator does not publish LapCompleted", "unreadable")]
    // A source that cannot judge a lap also reports the sim as not running, so
    // the reason has to win. Reading the flag first would file the fleet's
    // quietest failure as an idle rig.
    [InlineData(true, "the simulator does not publish OnPitRoad", "unreadable")]
    public void Reads_simulator_health_from_what_the_source_reports(
        bool simRunning, string? reason, string expected)
    {
        Assert.Equal(expected, SimHealthReading.Of(simRunning, reason).WireName());
    }

    [Fact]
    public async Task Heartbeat_carries_what_this_rig_can_do_with_its_simulator()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await client.HeartbeatAsync(
            "1.2.3",
            SimHealth.Unreadable,
            "the simulator does not publish LapCompleted, OnPitRoad",
            null,
            CancellationToken.None);

        var heartbeat = JsonNode.Parse(handler.LastBody!)!["events"]![0]!;
        Assert.Equal("RIG_HEARTBEAT", (string?)heartbeat["type"]);
        Assert.Equal("1.2.3", (string?)heartbeat["agentVersion"]);
        Assert.Equal("unreadable", (string?)heartbeat["simHealth"]);
        Assert.Equal(
            "the simulator does not publish LapCompleted, OnPitRoad",
            (string?)heartbeat["simHealthDetail"]);
    }

    [Fact]
    public async Task Heartbeat_explains_nothing_when_there_is_nothing_wrong()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        // A stale reason paired with a healthy verdict would leave "does not
        // publish LapCompleted" sitting beside a rig that is scoring fine.
        await client.HeartbeatAsync("1.2.3", SimHealth.Scoring, "left over", null, CancellationToken.None);

        var heartbeat = JsonNode.Parse(handler.LastBody!)!["events"]![0]!;
        Assert.Equal("scoring", (string?)heartbeat["simHealth"]);
        Assert.Null(heartbeat["simHealthDetail"]);
    }

    [Fact]
    public async Task Heartbeat_truncates_an_explanation_the_contract_would_refuse()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        // Every validity channel missing at once names enough channels to run
        // long. Losing the whole heartbeat to a 400 would take the rig off the
        // dashboard entirely, which is worse than a clipped explanation.
        await client.HeartbeatAsync(
            "1.2.3", SimHealth.Unreadable, new string('x', 900), null, CancellationToken.None);

        var detail = (string?)JsonNode.Parse(handler.LastBody!)!["events"]![0]!["simHealthDetail"];
        Assert.Equal(300, detail!.Length);
    }

    [Fact]
    public async Task Sends_bearer_token_on_requests()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"assignment":null}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "dev-rig-1-secret");

        await client.GetAssignmentAsync(CancellationToken.None);

        Assert.Equal("Bearer", handler.LastRequest!.Headers.Authorization!.Scheme);
        Assert.Equal("dev-rig-1-secret", handler.LastRequest.Headers.Authorization.Parameter);
    }

    [Fact]
    public async Task Parses_an_active_assignment()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"assignment":{"id":"a1","startedAt":"2026-07-12T00:00:00.000Z",
             "driver":{"id":"d1","displayName":"Cody J."}}}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var assignment = (await client.GetAssignmentAsync(CancellationToken.None)).Assignment;

        Assert.NotNull(assignment);
        Assert.Equal("a1", assignment!.Id);
        Assert.Equal("Cody J.", assignment.DriverDisplayName);
    }

    [Fact]
    public async Task Null_assignment_returns_null()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"assignment":null}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        Assert.Null((await client.GetAssignmentAsync(CancellationToken.None)).Assignment);
    }

    [Fact]
    public async Task SendLaps_settles_permanently_refused_laps()
    {
        // The backend will not own a lap outside an assignment's window, and no
        // later check-in can change that. Keeping those queued would retry them
        // every five seconds all night and hold the laps behind them hostage.
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[
              {"type":"LAP_COMPLETED","eventId":"evt-1","status":"accepted"},
              {"type":"LAP_COMPLETED","eventId":"evt-2","status":"no_active_assignment"},
              {"type":"LAP_COMPLETED","eventId":"evt-3","status":"assignment_mismatch"}
            ]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-3") }, CancellationToken.None);

        Assert.Equal(new[] { "evt-1", "evt-2", "evt-3" }, settled.Settled);
        Assert.Empty(settled.Rejected);
    }

    [Fact]
    public async Task SendLaps_keeps_a_lap_the_server_failed_to_store()
    {
        // "error" is the backend's own insert failing, not a verdict on the
        // lap — the rig must keep it and try again.
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[
              {"type":"LAP_COMPLETED","eventId":"evt-1","status":"accepted"},
              {"type":"LAP_COMPLETED","eventId":"evt-2","status":"error"}
            ]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = await client.SendLapsAsync(new[] { Queued("evt-1"), Queued("evt-2") }, CancellationToken.None);

        Assert.Equal(new[] { "evt-1" }, settled.Settled);
    }

    [Fact]
    public async Task SendLaps_settles_duplicates()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-1","status":"duplicate"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

        Assert.Equal(new[] { "evt-1" }, settled.Settled);
    }

    /// <summary>Stands in for the backend's whole-document validation: a batch
    /// containing the poison event is refused outright with a 400 and none of
    /// the laps in it are looked at. Any other batch is accepted in full.</summary>
    private static StubHandler RefusesBatchesContaining(string poison)
    {
        StubHandler? handler = null;
        handler = new StubHandler(_ =>
        {
            var body = handler!.LastBody ?? "";
            if (body.Contains(poison, StringComparison.Ordinal))
            {
                return (HttpStatusCode.BadRequest,
                    """{"error":"invalid_input","detail":[{"path":["events",0,"lapTimeMs"],"message":"expected int"}]}""");
            }

            var results = new JsonArray();
            foreach (var id in EventIdsIn(body))
                results.Add(new JsonObject { ["type"] = "LAP_COMPLETED", ["eventId"] = id, ["status"] = "accepted" });
            return (HttpStatusCode.OK, new JsonObject { ["results"] = results }.ToJsonString());
        });
        return handler;
    }

    private static List<string> EventIdsIn(string body) =>
        (JsonNode.Parse(body)!["events"]!.AsArray())
            .Select(e => e!["eventId"]!.GetValue<string>())
            .ToList();

    [Fact]
    public async Task SendLaps_gets_the_good_laps_through_a_batch_the_backend_refuses()
    {
        // The backend parses the request as one document, so one event it
        // cannot read fails all fifty. Retrying that batch is the difference
        // between a rig that misses one lap and a rig that stops scoring for
        // the rest of the day.
        var handler = RefusesBatchesContaining("evt-poison");
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");
        var batch = new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-poison"), Queued("evt-4") };

        var submission = await client.SendLapsAsync(batch, CancellationToken.None);

        Assert.Equal(new[] { "evt-1", "evt-2", "evt-4" }, submission.Settled.Order());
        Assert.Equal("evt-poison", Assert.Single(submission.Rejected).EventId);
    }

    [Fact]
    public async Task SendLaps_names_the_one_lap_the_backend_would_not_read()
    {
        // Splitting is only useful if it ends with a single event named. A
        // refusal that still covered a range would leave the rig guessing which
        // lap to set aside, and setting the wrong ones aside loses good laps.
        var handler = RefusesBatchesContaining("evt-poison");
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");
        var batch = Enumerable.Range(1, 32)
            .Select(i => Queued(i == 19 ? "evt-poison" : $"evt-{i:D4}"))
            .ToList();

        var submission = await client.SendLapsAsync(batch, CancellationToken.None);

        Assert.Equal(31, submission.Settled.Count);
        Assert.Equal("evt-poison", Assert.Single(submission.Rejected).EventId);
        // Halving 32 events reaches the single bad one in log2 steps, not 32.
        Assert.InRange(handler.Bodies.Count, 1, 16);
    }

    [Fact]
    public async Task SendLaps_carries_the_backends_own_words_about_the_refusal()
    {
        // Whoever reads the rig's log has to be able to tell a contract change
        // from a proxy in front of the backend answering 400 for its own
        // reasons, so the response body is kept rather than summarised away.
        var handler = RefusesBatchesContaining("evt-poison");
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var submission = await client.SendLapsAsync(new[] { Queued("evt-poison") }, CancellationToken.None);

        Assert.Contains("invalid_input", Assert.Single(submission.Rejected).Reason);
        Assert.Contains("lapTimeMs", submission.Rejected[0].Reason);
    }

    [Fact]
    public async Task SendLaps_reports_a_400_with_no_body_rather_than_an_empty_reason()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.BadRequest, ""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var submission = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

        Assert.NotEmpty(Assert.Single(submission.Rejected).Reason);
    }

    [Fact]
    public async Task SendLaps_keeps_every_lap_when_the_server_itself_fails()
    {
        // A 500 is the backend having a bad moment, and a 401 is a token to fix
        // at the desk. Neither is a verdict on a lap, so nothing may be set
        // aside and the whole batch has to still be there for the next flush.
        foreach (var status in new[] { HttpStatusCode.InternalServerError, HttpStatusCode.Unauthorized })
        {
            var handler = new StubHandler(_ => (status, """{"error":"nope"}"""));
            var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

            await Assert.ThrowsAnyAsync<HttpRequestException>(() =>
                client.SendLapsAsync(new[] { Queued("evt-1"), Queued("evt-2") }, CancellationToken.None));

            // One attempt, not a split: the batch is not what the server
            // objected to, so halving it would just multiply the failed calls.
            Assert.Single(handler.Bodies);
        }
    }

    [Fact]
    public async Task SendLaps_sets_aside_every_lap_when_the_whole_batch_is_refused()
    {
        // The realistic way this happens is a contract change the venue's rigs
        // have not been updated for, which spoils every queued lap at once
        // rather than one. The rig must still end up with an empty queue.
        var handler = new StubHandler(_ => (HttpStatusCode.BadRequest, """{"error":"invalid_input"}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");
        var batch = new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-3") };

        var submission = await client.SendLapsAsync(batch, CancellationToken.None);

        Assert.Empty(submission.Settled);
        Assert.Equal(new[] { "evt-1", "evt-2", "evt-3" }, submission.Rejected.Select(r => r.EventId).Order());
    }

    [Fact]
    public async Task SendLaps_sends_nothing_for_an_empty_batch()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var submission = await client.SendLapsAsync(Array.Empty<QueuedEvent>(), CancellationToken.None);

        Assert.Empty(submission.Settled);
        Assert.Empty(submission.Rejected);
        Assert.Empty(handler.Bodies);
    }

    [Fact]
    public async Task Checkout_reads_ended_flag()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"ended":true}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        Assert.True(await client.CheckoutAsync(CancellationToken.None));
    }

    [Fact]
    public async Task Heartbeat_says_which_computer_it_came_from()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");
        var installation = new InstallationIdentity("aaaaaaaabbbbbbbbccccccccdddddddd", "RIG-03");

        await client.HeartbeatAsync("1.4.0", SimHealth.Scoring, null, installation, CancellationToken.None);

        var heartbeat = JsonNode.Parse(handler.LastBody!)!["events"]![0]!;
        Assert.Equal("aaaaaaaabbbbbbbbccccccccdddddddd", (string?)heartbeat["installationId"]);
        Assert.Equal("RIG-03", (string?)heartbeat["machineName"]);
    }

    [Fact]
    public async Task Heartbeat_claims_nothing_when_the_agent_cannot_say_which_computer_it_is()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await client.HeartbeatAsync("1.4.0", SimHealth.Scoring, null, null, CancellationToken.None);

        // Absent, not blank: the backend leaves the rig's recorded machine alone
        // for a heartbeat that names none, and an empty string would be refused
        // by the contract and cost the whole heartbeat.
        var heartbeat = JsonNode.Parse(handler.LastBody!)!["events"]![0]!;
        Assert.Null(heartbeat["installationId"]);
        Assert.Null(heartbeat["machineName"]);
    }

    [Fact]
    public async Task A_lap_held_because_two_computers_share_the_token_keeps_its_place_in_the_queue()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[
              {"type":"LAP_COMPLETED","eventId":"evt-0001","status":"rig_conflict"},
              {"type":"LAP_COMPLETED","eventId":"evt-0002","status":"rig_conflict"}
            ]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var submission = await client.SendLapsAsync(
            new[] { Queued("evt-0001"), Queued("evt-0002") }, CancellationToken.None);

        // Not settled and not quarantined: this refusal reverses itself the
        // moment somebody gives the second machine its own token, so dropping
        // the laps would throw away times that are still deliverable.
        Assert.Empty(submission.Settled);
        Assert.Empty(submission.Rejected);
        Assert.Equal(2, submission.HeldForRigConflict);
    }

    [Fact]
    public async Task A_status_the_agent_has_never_heard_of_keeps_its_lap_too()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-0001","status":"invented_later"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var submission = await client.SendLapsAsync(new[] { Queued("evt-0001") }, CancellationToken.None);

        // The fleet is updated one rig at a time, so a backend answer newer than
        // the agent is normal. Keeping the lap is the safe reading of a word the
        // agent does not know - it is the only one that cannot lose a customer's
        // time, and it is what makes a new refusal deployable at all.
        Assert.Empty(submission.Settled);
        Assert.Equal(0, submission.HeldForRigConflict);
    }

}
