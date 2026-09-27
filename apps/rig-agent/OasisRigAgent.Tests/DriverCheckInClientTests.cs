using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using OasisRigAgent.Core;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rig-side check-in against a scripted backend that answers the way the
/// deployed routes do (`api/auth/guest` and `api/checkin` at 695e080 and on
/// main): the cookie the guest sign-in sets must come back on the check-in,
/// a taken name is retried once with the backend's suggestion, and every
/// refusal becomes a sentence for the person at the rig.
/// </summary>
public sealed class DriverCheckInClientTests
{
    private sealed class ScriptedBackend : HttpMessageHandler
    {
        public readonly List<(string Path, JsonNode? Body, string? Cookie)> Requests = new();
        public Func<string, JsonNode?, (HttpStatusCode Status, string Body, string? SetCookie)> Answer = null!;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var text = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            var cookie = request.Headers.TryGetValues("Cookie", out var values) ? string.Join("; ", values) : null;
            Requests.Add((request.RequestUri!.AbsolutePath, body, cookie));
            var (status, answer, setCookie) = Answer(request.RequestUri.AbsolutePath, body);
            var response = new HttpResponseMessage(status)
            {
                Content = new StringContent(answer, Encoding.UTF8, "application/json"),
            };
            if (setCookie is not null) response.Headers.Add("Set-Cookie", setCookie);
            return response;
        }
    }

    private static (DriverCheckInClient Client, ScriptedBackend Backend) Build()
    {
        var backend = new ScriptedBackend();
        // One handler instance per client so the cookie jar is per check-in, as in production.
        var cookies = new CookieContainer();
        var client = new DriverCheckInClient("https://rig.test", "qr-rig-1",
            () => new CookieForwardingHandler(backend, cookies));
        return (client, backend);
    }

    /// <summary>Stands in for HttpClientHandler's cookie handling over the scripted backend.</summary>
    private sealed class CookieForwardingHandler : DelegatingHandler
    {
        private readonly CookieContainer _jar;
        public CookieForwardingHandler(HttpMessageHandler inner, CookieContainer jar) : base(inner) => _jar = jar;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var header = _jar.GetCookieHeader(request.RequestUri!);
            if (header.Length > 0) request.Headers.Add("Cookie", header);
            var response = await base.SendAsync(request, ct);
            if (response.Headers.TryGetValues("Set-Cookie", out var set))
                foreach (var c in set) _jar.SetCookies(request.RequestUri!, c);
            return response;
        }
    }

    [Fact]
    public async Task SignsInThenChecksInWithTheSessionCookieAndConfirmsTakeover()
    {
        var (client, backend) = Build();
        backend.Answer = (path, body) => path switch
        {
            "/api/auth/guest" => (HttpStatusCode.OK,
                """{"driverId":"d-1","displayName":"Mike"}""",
                "oasis_driver=jwt-abc; Path=/; HttpOnly; SameSite=lax"),
            "/api/checkin" => (HttpStatusCode.OK, """{"status":"checked_in","assignmentId":"a-1","rig":{"rig_number":1}}""", null),
            _ => (HttpStatusCode.NotFound, "{}", null),
        };

        var result = await client.CheckInAsync("Mike", CancellationToken.None);

        Assert.Equal(new DriverCheckIn("Mike", false, "d-1", "a-1"), result);
        Assert.Equal(2, backend.Requests.Count);
        Assert.Equal("Mike", backend.Requests[0].Body?["displayName"]?.GetValue<string>());
        Assert.Null(backend.Requests[0].Cookie);
        var checkin = backend.Requests[1];
        Assert.Equal("oasis_driver=jwt-abc", checkin.Cookie);
        Assert.Equal("qr-rig-1", checkin.Body?["qrToken"]?.GetValue<string>());
        Assert.True(checkin.Body?["confirmTakeover"]?.GetValue<bool>());
        Assert.True(checkin.Body?["confirmMove"]?.GetValue<bool>());
    }

    [Fact]
    public async Task ATakenNameIsRetriedOnceWithTheBackendsSuggestion()
    {
        var (client, backend) = Build();
        backend.Answer = (path, body) => path switch
        {
            "/api/auth/guest" when body?["displayName"]?.GetValue<string>() == "Mike" =>
                (HttpStatusCode.Conflict, """{"error":"name_taken","suggestion":"Mike 47"}""", null),
            "/api/auth/guest" => (HttpStatusCode.OK, """{"driverId":"d-2","displayName":"Mike 47"}""", "oasis_driver=jwt-2; Path=/"),
            "/api/checkin" => (HttpStatusCode.OK, """{"status":"checked_in","assignmentId":"a-2"}""", null),
            _ => (HttpStatusCode.NotFound, "{}", null),
        };

        var result = await client.CheckInAsync("Mike", CancellationToken.None);

        Assert.Equal("Mike 47", result.DisplayName);
        Assert.True(result.Renamed);
        Assert.Equal(3, backend.Requests.Count);
    }

    [Fact]
    public async Task ASecondCollisionIsRefusedNotGuessedAt()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) => (HttpStatusCode.Conflict, """{"error":"name_taken","suggestion":"Mike 47"}""", null);
        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Mike", CancellationToken.None));
        Assert.Contains("already taken", ex.Message);
        Assert.Equal(2, backend.Requests.Count);
    }

    [Theory]
    [InlineData("/api/auth/guest", 429, "too many sign-ins")]
    [InlineData("/api/auth/guest", 400, "not allowed")]
    [InlineData("/api/checkin", 404, "QR token")]
    [InlineData("/api/checkin", 401, "did not keep the sign-in")]
    [InlineData("/api/checkin", 429, "too many check-ins")]
    public async Task RefusalsBecomeSentencesForThePersonAtTheRig(string failingPath, int status, string expected)
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == failingPath
            ? ((HttpStatusCode)status, """{"error":"whatever"}""", null)
            : path == "/api/auth/guest"
                ? (HttpStatusCode.OK, """{"driverId":"d","displayName":"X"}""", "oasis_driver=j; Path=/")
                : (HttpStatusCode.OK, """{"status":"checked_in","assignmentId":"a"}""", null);
        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Some Name", CancellationToken.None));
        Assert.Contains(expected, ex.Message);
    }

    [Fact]
    public async Task ABackendThatCannotBeReachedPropagatesSoTheCallerCanSayOffline()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) => throw new HttpRequestException("connection refused");
        await Assert.ThrowsAsync<HttpRequestException>(() => client.CheckInAsync("Mike", CancellationToken.None));
    }

    [Fact]
    public async Task EachCheckInStartsWithAnEmptyCookieJar()
    {
        var backend = new ScriptedBackend();
        var client = new DriverCheckInClient("https://rig.test", "qr-rig-1",
            () => new CookieForwardingHandler(backend, new CookieContainer()));
        backend.Answer = (path, _) => path == "/api/auth/guest"
            ? (HttpStatusCode.OK, """{"driverId":"d","displayName":"X"}""", "oasis_driver=first; Path=/")
            : (HttpStatusCode.OK, """{"status":"checked_in","assignmentId":"a"}""", null);
        await client.CheckInAsync("First", CancellationToken.None);
        await client.CheckInAsync("Second", CancellationToken.None);
        // The second sign-in carries no cookie from the first person.
        Assert.Null(backend.Requests[2].Cookie);
    }
}
