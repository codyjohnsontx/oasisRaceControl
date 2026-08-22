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

        var assignment = await client.GetAssignmentAsync(CancellationToken.None);

        Assert.NotNull(assignment);
        Assert.Equal("a1", assignment!.Id);
        Assert.Equal("Cody J.", assignment.DriverDisplayName);
    }

    [Fact]
    public async Task Null_assignment_returns_null()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"assignment":null}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        Assert.Null(await client.GetAssignmentAsync(CancellationToken.None));
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

        var settled = await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2"), Queued("evt-3"), Queued("evt-4") },
            CancellationToken.None);

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

        var settled = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

        Assert.Equal(new[] { "evt-1" }, settled);
    }

    [Fact]
    public async Task SendLaps_settles_duplicates()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-1","status":"duplicate"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

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

        var settled = await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2") }, CancellationToken.None);

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

        var settled = await client.SendLapsAsync(
            new[] { Queued("evt-1"), Queued("evt-2") }, CancellationToken.None);

        Assert.Equal(new[] { "evt-2" }, settled);
    }

    [Fact]
    public async Task SendLaps_ignores_a_result_for_an_event_it_did_not_send()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """
            {"results":[{"type":"LAP_COMPLETED","eventId":"evt-someone-else","status":"accepted"}]}
            """));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        var settled = await client.SendLapsAsync(new[] { Queued("evt-1") }, CancellationToken.None);

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

    [Fact]
    public async Task Checkout_reads_ended_flag()
    {
        var handler = new StubHandler(_ => (HttpStatusCode.OK, """{"ended":true}"""));
        var client = new BackendClient(new HttpClient(handler), "https://x.test", "t");

        Assert.True(await client.CheckoutAsync(CancellationToken.None));
    }
}
