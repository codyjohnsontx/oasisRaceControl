using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using OasisRigAgent.Core;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rig-side check-in against a scripted backend that answers the way the
/// deployed routes do (`api/auth/login`, `api/auth/register` and `api/checkin`
/// at 695e080 and on main): a returning driver only ever logs in and a new one
/// only ever registers, the cookie that sets must come back on the check-in,
/// and every refusal becomes a sentence for the person at the rig.
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

    private const string Session = "oasis_driver=jwt-abc; Path=/; HttpOnly; SameSite=lax";
    private const string CheckedIn = """{"status":"checked_in","assignmentId":"a-1","rig":{"rig_number":1}}""";

    private static IEnumerable<string> Paths(ScriptedBackend backend) => backend.Requests.Select(r => r.Path);

    [Fact]
    public async Task AReturningNameAndPinLogInThenCheckInWithTheSessionCookie()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path switch
        {
            "/api/auth/login" => (HttpStatusCode.OK, """{"driverId":"d-1","displayName":"Mike"}""", Session),
            "/api/checkin" => (HttpStatusCode.OK, CheckedIn, null),
            _ => (HttpStatusCode.NotFound, "{}", null),
        };

        var result = await client.CheckInReturningAsync("mike", "1234", CancellationToken.None);

        Assert.Equal(new DriverCheckIn("Mike", true, "d-1", "a-1"), result);
        Assert.Equal(new[] { "/api/auth/login", "/api/checkin" }, Paths(backend));
        Assert.Equal("mike", backend.Requests[0].Body?["displayName"]?.GetValue<string>());
        Assert.Equal("1234", backend.Requests[0].Body?["pin"]?.GetValue<string>());
        Assert.Null(backend.Requests[0].Cookie);
        var checkin = backend.Requests[1];
        Assert.Equal("oasis_driver=jwt-abc", checkin.Cookie);
        Assert.Equal("qr-rig-1", checkin.Body?["qrToken"]?.GetValue<string>());
        Assert.True(checkin.Body?["confirmTakeover"]?.GetValue<bool>());
        Assert.True(checkin.Body?["confirmMove"]?.GetValue<bool>());
    }

    [Fact]
    public async Task ANewNameRegistersThenChecksInWithoutEverLoggingIn()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path switch
        {
            "/api/auth/register" => (HttpStatusCode.OK, """{"driverId":"d-2","displayName":"Mike"}""", Session),
            "/api/checkin" => (HttpStatusCode.OK, CheckedIn, null),
            _ => (HttpStatusCode.NotFound, "{}", null),
        };

        var result = await client.CheckInNewAsync("Mike", "1234", CancellationToken.None);

        Assert.Equal(new DriverCheckIn("Mike", false, "d-2", "a-1"), result);
        Assert.Equal(new[] { "/api/auth/register", "/api/checkin" }, Paths(backend));
        Assert.Equal("1234", backend.Requests[0].Body?["pin"]?.GetValue<string>());
        Assert.Equal("oasis_driver=jwt-abc", backend.Requests[1].Cookie);
    }

    [Fact]
    public async Task AReturningNameWithTheWrongPinSeatsNobodyAndNeverRegisters()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == "/api/auth/login"
            ? (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null)
            : (HttpStatusCode.OK, CheckedIn, null);

        Assert.Null(await client.CheckInReturningAsync("chuy", "9999", CancellationToken.None));
        Assert.Equal(new[] { "/api/auth/login" }, Paths(backend));
    }

    [Fact]
    public async Task ANewNameThatIsTakenSeatsNobodyAndNeverLogsIn()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == "/api/auth/register"
            ? (HttpStatusCode.Conflict, """{"error":"name_taken"}""", null)
            : (HttpStatusCode.OK, CheckedIn, null);

        Assert.Null(await client.CheckInNewAsync("chuy", "9999", CancellationToken.None));
        Assert.Equal(new[] { "/api/auth/register" }, Paths(backend));
    }

    [Fact]
    public async Task ANameLockedAfterFiveWrongPinsSaysSo()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) =>
            (HttpStatusCode.TooManyRequests, """{"error":"locked","lockedUntil":"2026-09-27T18:15:00.000Z"}""", null);

        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInReturningAsync("Mike", "1234", CancellationToken.None));

        Assert.Contains("locked after five wrong PINs", ex.Message);
        Assert.Contains(DateTimeOffset.Parse("2026-09-27T18:15:00Z").ToLocalTime().ToString("HH:mm"), ex.Message);
        Assert.Equal(new[] { "/api/auth/login" }, Paths(backend));
    }

    [Fact]
    public async Task ARateLimitedRegistrationIsWordedAsTheSharedSignInLimit()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) => (HttpStatusCode.TooManyRequests, """{"error":"rate_limited"}""", null);

        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInNewAsync("Mike", "1234", CancellationToken.None));

        Assert.Contains("too many sign-in attempts from this network", ex.Message);
        Assert.Contains("wait a minute", ex.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData("123")]
    [InlineData("12345")]
    [InlineData("12a4")]
    [InlineData("١٢٣٤")]
    public async Task APinThatIsNotFourDigitsIsNeverSent(string pin)
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) => (HttpStatusCode.OK, CheckedIn, null);

        Assert.False(DriverCheckInClient.IsPin(pin));
        var returning = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInReturningAsync("Mike", pin, CancellationToken.None));
        var created = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInNewAsync("Mike", pin, CancellationToken.None));

        Assert.Contains("4 digits", returning.Message);
        Assert.Contains("4 digits", created.Message);
        Assert.Empty(backend.Requests);
    }

    [Theory]
    [InlineData(true, "/api/auth/login", 400, "not allowed")]
    [InlineData(true, "/api/auth/login", 500, "HTTP 500")]
    [InlineData(false, "/api/auth/register", 400, "not allowed")]
    [InlineData(false, "/api/auth/register", 500, "HTTP 500")]
    [InlineData(true, "/api/checkin", 404, "QR token")]
    [InlineData(false, "/api/checkin", 401, "did not keep the sign-in")]
    [InlineData(true, "/api/checkin", 403, "not allowed to check in")]
    [InlineData(false, "/api/checkin", 409, "same moment")]
    [InlineData(true, "/api/checkin", 429, "too many check-ins")]
    [InlineData(false, "/api/checkin", 500, "HTTP 500")]
    public async Task RefusalsBecomeSentencesForThePersonAtTheRig(bool returning, string failingPath, int status, string expected)
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == failingPath
            ? ((HttpStatusCode)status, """{"error":"whatever"}""", null)
            : path is "/api/auth/login" or "/api/auth/register"
                ? (HttpStatusCode.OK, """{"driverId":"d","displayName":"X"}""", "oasis_driver=j; Path=/")
                : (HttpStatusCode.OK, CheckedIn, null);
        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => returning
            ? client.CheckInReturningAsync("Some Name", "1234", CancellationToken.None)
            : client.CheckInNewAsync("Some Name", "1234", CancellationToken.None));
        Assert.Contains(expected, ex.Message);
    }

    [Fact]
    public async Task ABackendThatCannotBeReachedPropagatesSoTheCallerCanSayOffline()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) => throw new HttpRequestException("connection refused");
        await Assert.ThrowsAsync<HttpRequestException>(() => client.CheckInReturningAsync("Mike", "1234", CancellationToken.None));
        await Assert.ThrowsAsync<HttpRequestException>(() => client.CheckInNewAsync("Mike", "1234", CancellationToken.None));
    }

    [Fact]
    public async Task EachCheckInStartsWithAnEmptyCookieJar()
    {
        var backend = new ScriptedBackend();
        var client = new DriverCheckInClient("https://rig.test", "qr-rig-1",
            () => new CookieForwardingHandler(backend, new CookieContainer()));
        backend.Answer = (path, _) => path == "/api/auth/login"
            ? (HttpStatusCode.OK, """{"driverId":"d","displayName":"X"}""", "oasis_driver=first; Path=/")
            : (HttpStatusCode.OK, CheckedIn, null);
        await client.CheckInReturningAsync("First", "1111", CancellationToken.None);
        await client.CheckInReturningAsync("Second", "2222", CancellationToken.None);
        // The second sign-in carries no cookie from the first person.
        Assert.Null(backend.Requests[2].Cookie);
    }
}
