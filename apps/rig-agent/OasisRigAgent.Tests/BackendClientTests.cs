using System.Globalization;
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

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            LastBody = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
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
        ["rigAssignmentId"] = "a-1",
        ["trackName"] = "Spa-Francorchamps",
        ["carName"] = "Porsche 911 GT3 R",
        ["lapTimeMs"] = 138_000,
        ["completedAt"] = DateTimeOffset.UtcNow.ToString("o"),
    });

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

        var poll = await client.GetAssignmentAsync(CancellationToken.None);

        Assert.NotNull(poll.Assignment);
        Assert.Equal("a1", poll.Assignment!.Id);
        Assert.Equal("Cody J.", poll.Assignment.DriverDisplayName);
    }

    /// <summary>Pins the invariant that reading startedAt does not depend on the
    /// machine's culture - it is one side of the comparison that decides who owns
    /// a deferred lap, and rigs are ordinary Windows boxes with whatever locale
    /// someone set.
    ///
    /// Honest about its own strength: this currently passes with OR without the
    /// InvariantCulture argument, including with a ThaiBuddhistCalendar forced,
    /// because .NET parses ISO 8601 with a Z offset through a culture-invariant
    /// path. It is a guard against a future move to a culture-sensitive format,
    /// not a reproduction of a live defect - do not cite it as one.</summary>
    [Theory]
    [InlineData("th-TH", true)]
    [InlineData("ar-SA", false)]
    [InlineData("en-US", false)]
    public async Task Parses_startedAt_the_same_under_any_machine_culture(
        string culture, bool forceNonGregorianCalendar)
    {
        var original = CultureInfo.CurrentCulture;
        var machine = (CultureInfo)new CultureInfo(culture).Clone();
        // The calendar is forced rather than taken from the platform: ICU on
        // macOS hands th-TH a Gregorian calendar, so relying on the default
        // would make this test pass on the dev machine and prove nothing about
        // the Windows rigs it is written for.
        if (forceNonGregorianCalendar)
            machine.DateTimeFormat.Calendar = new ThaiBuddhistCalendar();
        CultureInfo.CurrentCulture = machine;
        try
        {
            var handler = new StubHandler(_ => (HttpStatusCode.OK, """
                {"assignment":{"id":"a1","startedAt":"2026-08-22T09:12:00.000Z",
                 "driver":{"id":"d1","displayName":"Cody J."}}}
                """));
            var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

            var poll = await client.GetAssignmentAsync(CancellationToken.None);

            Assert.Equal(
                DateTimeOffset.Parse("2026-08-22T09:12:00.000Z", CultureInfo.InvariantCulture),
                poll.Assignment!.StartedAt);
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [Fact]
    public async Task Null_assignment_returns_null()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"assignment":null}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        Assert.Null((await client.GetAssignmentAsync(CancellationToken.None)).Assignment);
    }

    [Fact]
    public async Task SendLaps_settles_every_status_that_means_the_lap_is_stored()
    {
        // Attributed, attributed-but-invalid, stored-with-no-owner, and already
        // present. All four are safely gone from the outbox.
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[
              {"type":"LAP_COMPLETED","eventId":"evt-1","status":"accepted"},
              {"type":"LAP_COMPLETED","eventId":"evt-2","status":"accepted_invalid"},
              {"type":"LAP_COMPLETED","eventId":"evt-3","status":"accepted_unattributed"},
              {"type":"LAP_COMPLETED","eventId":"evt-4","status":"duplicate"}
            ]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = (await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-3"), Queued("evt-4") },
            CancellationToken.None)).Settled;

        Assert.Equal(new[] { "evt-1", "evt-2", "evt-3", "evt-4" }, settled);
    }

    /// <summary>A rig nobody checks into still drains: its laps are stored
    /// unattributed, so the outbox cannot grow without bound.</summary>
    [Fact]
    public async Task SendLaps_settles_a_lap_stored_with_no_owner()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-1","status":"accepted_unattributed"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = (await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None)).Settled;

        Assert.Equal(new[] { "evt-1" }, settled);
    }

    [Fact]
    public async Task SendLaps_settles_duplicates()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-1","status":"duplicate"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = (await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None)).Settled;

        Assert.Equal(new[] { "evt-1" }, settled);
    }

    [Fact]
    public async Task SendLaps_does_not_settle_a_lap_the_backend_did_not_store()
    {
        // "error" is transient and must be retried; an unrecognised status comes
        // from a backend newer than this agent and must not be guessed at.
        // Either way the outbox keeps the only durable copy.
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[
              {"type":"LAP_COMPLETED","eventId":"evt-1","status":"error"},
              {"type":"LAP_COMPLETED","eventId":"evt-2","status":"something_invented_later"}
            ]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = (await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2") }, CancellationToken.None)).Settled;

        Assert.Empty(settled);
    }

    /// <summary>Settling is keyed on the idempotency key the backend echoes, not
    /// on position, so a reordered or partial response cannot delete the wrong
    /// lap from the outbox.</summary>
    [Fact]
    public async Task SendLaps_settles_by_event_id_not_by_position()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[
              {"type":"LAP_COMPLETED","eventId":"evt-2","status":"accepted"},
              {"type":"LAP_COMPLETED","eventId":"evt-1","status":"error"}
            ]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = (await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2") }, CancellationToken.None)).Settled;

        Assert.Equal(new[] { "evt-2" }, settled);
    }

    [Fact]
    public async Task SendLaps_ignores_a_result_for_an_event_it_did_not_send()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-someone-else","status":"accepted"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = (await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None)).Settled;

        Assert.Empty(settled);
    }

    [Fact]
    public async Task SendLaps_sends_the_queued_payload_including_its_assignment_stamp()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"results":[]}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

        Assert.Contains("\"rigAssignmentId\":\"a-1\"", handler.LastBody!);
    }

    /// <summary>The response `POST /api/agent/events` really sends when a lap
    /// fails validation, copied from a live run of the route against the venue
    /// schema rather than invented here: `detail` is zod's issue list and each
    /// issue names its lap by POSITION in the batch.</summary>
    private static string InvalidInput(params (int Index, string Field, string Message)[] issues)
        => """{"error":"invalid_input","detail":["""
           + string.Join(",", issues.Select(i =>
               $$"""{"code":"too_big","path":["events",{{i.Index}},"{{i.Field}}"],"message":"{{i.Message}}"}"""))
           + "]}";

    /// <summary>The wedge, at the client. A batch is validated whole, so one lap
    /// the backend will not accept fails all of them; this used to throw, which
    /// the agent could not tell from the venue's network being down, so it
    /// re-sent the identical batch every five seconds forever.
    ///
    /// Now the refusal comes back as an answer naming the lap that caused it.
    /// Nothing settles - none of these laps was stored - but the caller learns
    /// which one to stop sending.</summary>
    [Fact]
    public async Task SendLaps_reports_the_rejected_lap_instead_of_throwing()
    {
        var handler = new StubHandler(_ => (
            HttpStatusCode.BadRequest,
            InvalidInput((1, "lapTimeMs", "Too big: expected number to be <=1800000"))));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var outcome = await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-3") }, CancellationToken.None);

        Assert.Empty(outcome.Settled);
        var rejected = Assert.Single(outcome.Rejected);
        Assert.Equal("evt-2", rejected.EventId);
        // The reason names the field, so the console line is worth reading.
        Assert.Equal("lapTimeMs: Too big: expected number to be <=1800000", rejected.Reason);
    }

    /// <summary>zod reports every issue in one response, so a batch with two bad
    /// laps names both and the queue clears in one flush rather than one per
    /// round trip.</summary>
    [Fact]
    public async Task SendLaps_reports_every_rejected_lap_in_one_response()
    {
        var handler = new StubHandler(_ => (
            HttpStatusCode.BadRequest,
            InvalidInput(
                (0, "lapTimeMs", "Too big: expected number to be <=1800000"),
                (2, "eventId", "Too small: expected string to have >=8 characters"))));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var outcome = await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-3") }, CancellationToken.None);

        Assert.Equal(new[] { "evt-1", "evt-3" }, outcome.Rejected.Select(r => r.EventId));
    }

    /// <summary>A 4xx that names no lap must NOT quarantine anything. A rotated
    /// rig token answers 401 on every batch in the venue; parking laps on it
    /// would quietly retire a whole night's driving over a config change. It
    /// throws, so the agent keeps the laps and keeps retrying, which is right.</summary>
    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, """{"error":"unauthorized"}""")]
    [InlineData(HttpStatusCode.TooManyRequests, """{"error":"rate_limited"}""")]
    // The body-level failure: real, but it names no lap to blame.
    [InlineData(HttpStatusCode.BadRequest,
        """{"error":"invalid_input","detail":[{"code":"invalid_type","path":["events"]}]}""")]
    // Not this backend at all - a proxy or captive portal in the way.
    [InlineData(HttpStatusCode.Forbidden, "<html><body>Forbidden</body></html>")]
    public async Task SendLaps_still_throws_on_a_4xx_that_names_no_lap(
        HttpStatusCode status, string body)
    {
        var handler = new StubHandler(_ => (status, body));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None));
    }

    /// <summary>An index outside the batch cannot name one of these laps, so it
    /// is skipped - and with nothing left to quarantine the response falls back
    /// to the throwing path rather than parking a lap on a guess.</summary>
    [Fact]
    public async Task SendLaps_ignores_an_issue_naming_a_lap_it_did_not_send()
    {
        var handler = new StubHandler(_ => (
            HttpStatusCode.BadRequest, InvalidInput((7, "lapTimeMs", "Too big"))));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None));
    }

    /// <summary>Several issues can land on one lap. It is quarantined once, and
    /// the reason is the first one - a line staff can act on beats a
    /// concatenation of every rule it broke.</summary>
    [Fact]
    public async Task SendLaps_quarantines_a_lap_once_however_many_issues_name_it()
    {
        var handler = new StubHandler(_ => (
            HttpStatusCode.BadRequest,
            InvalidInput(
                (0, "lapTimeMs", "Too big: expected number to be <=1800000"),
                (0, "carName", "Invalid input: expected string, received undefined"))));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var outcome = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

        var rejected = Assert.Single(outcome.Rejected);
        Assert.Equal("lapTimeMs: Too big: expected number to be <=1800000", rejected.Reason);
    }

    /// <summary>The discriminator case: zod's path stops at `type` and there is
    /// no field beyond it, so the reason is still readable rather than a bare
    /// colon.</summary>
    [Fact]
    public async Task SendLaps_describes_a_rejection_that_names_no_field_below_the_lap()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.BadRequest, """
            {"error":"invalid_input","detail":[
              {"code":"invalid_union","path":["events",0],
               "message":"Invalid discriminator value. Expected 'RIG_HEARTBEAT' | 'LAP_COMPLETED'"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var outcome = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

        Assert.Equal(
            "Invalid discriminator value. Expected 'RIG_HEARTBEAT' | 'LAP_COMPLETED'",
            Assert.Single(outcome.Rejected).Reason);
    }

    /// <summary>A 5xx is the backend's own failure, not a verdict on any lap.
    /// It keeps throwing so the batch is retried whole.</summary>
    [Fact]
    public async Task SendLaps_still_throws_on_a_server_error()
    {
        var handler = new StubHandler(_ => (
            HttpStatusCode.InternalServerError, """{"error":"server_error"}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None));
    }

    [Fact]
    public async Task Checkout_reads_ended_flag()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"ended":true}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        Assert.True(await client.CheckoutAsync("a-1", CancellationToken.None));
    }

    /// <summary>A checkout says which stint it is ending. Without that on the
    /// wire, a checkout re-sent after an outage means "close whatever is open
    /// on this rig", which by then may be the next driver's stint.</summary>
    [Fact]
    public async Task Checkout_names_the_assignment_it_is_ending()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"ended":true}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await client.CheckoutAsync("a-1", CancellationToken.None);

        Assert.Contains("\"assignmentId\":\"a-1\"", handler.LastBody!);
    }

    /// <summary>An agent that has never completed a poll cannot name the stint,
    /// and its button still has to work. It sends the unqualified form - no
    /// assignmentId key at all - which the backend reads as "end whatever is
    /// open on this rig".</summary>
    [Fact]
    public async Task Checkout_without_a_known_assignment_names_none()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"ended":true}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        await client.CheckoutAsync(null, CancellationToken.None);

        Assert.DoesNotContain("assignmentId", handler.LastBody!);
    }
}
