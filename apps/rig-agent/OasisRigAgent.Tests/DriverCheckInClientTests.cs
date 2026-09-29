using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using static OasisRigAgent.Tests.TestPins;
using OasisRigAgent.Core;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rig-side check-in against a scripted backend that answers the way the
/// deployed routes do (`api/auth/login`, `api/auth/register` and `api/checkin`
/// at 695e080 and on main): a name and PIN log a returning driver back in or
/// register a new one, the cookie that sets must come back on the check-in,
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

        var result = await client.CheckInAsync("mike", "1234",
            _ => throw new InvalidOperationException("a returning driver is asked for the PIN once"), CancellationToken.None);

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
    public async Task ANameAndPinThatMatchNobodyRegisterANewDriverOnceThePinIsTypedTwice()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path switch
        {
            "/api/auth/login" => (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null),
            "/api/auth/register" => (HttpStatusCode.OK, """{"driverId":"d-2","displayName":"Mike"}""", Session),
            "/api/checkin" => (HttpStatusCode.OK, CheckedIn, null),
            _ => (HttpStatusCode.NotFound, "{}", null),
        };

        var askedAfter = -1;
        var result = await client.CheckInAsync("Mike", "1234", _ =>
        {
            askedAfter = backend.Requests.Count;
            return Task.FromResult<string?>("1234");
        }, CancellationToken.None);

        // The PIN is asked for again after the login matched nobody and before
        // anything is registered.
        Assert.Equal(1, askedAfter);
        Assert.Equal(new DriverCheckIn("Mike", false, "d-2", "a-1"), result);
        Assert.Equal(new[] { "/api/auth/login", "/api/auth/register", "/api/checkin" }, Paths(backend));
        Assert.Equal("1234", backend.Requests[1].Body?["pin"]?.GetValue<string>());
        Assert.Equal("oasis_driver=jwt-abc", backend.Requests[2].Cookie);
    }

    [Theory]
    [InlineData("1243")]
    [InlineData("")]
    public async Task ANewPinNotTypedTheSameTwiceRegistersNothing(string second)
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == "/api/auth/login"
            ? (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null)
            : (HttpStatusCode.OK, """{"driverId":"d-2","displayName":"Chuy"}""", Session);
        var asked = 0;

        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Chuy", "1234", _ =>
        {
            asked++;
            return Task.FromResult<string?>(second);
        }, CancellationToken.None));

        Assert.Equal(1, asked);
        Assert.True(ex.RetryPin);
        Assert.Contains("nothing was signed up", ex.Message);
        Assert.Equal(new[] { "/api/auth/login" }, Paths(backend));
    }

    [Fact]
    public async Task ClosingTheProgramAtTheSecondPinRegistersNothing()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == "/api/auth/login"
            ? (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null)
            : (HttpStatusCode.OK, """{"driverId":"d-2","displayName":"Chuy"}""", Session);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => client.CheckInAsync("Chuy", "1234", _ => Task.FromResult<string?>(null), CancellationToken.None));

        Assert.Equal(new[] { "/api/auth/login" }, Paths(backend));
    }

    [Fact]
    public async Task AnExistingNameWithTheWrongPinSaysSoPlainlyAndKeepsTheName()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path switch
        {
            "/api/auth/login" => (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null),
            "/api/auth/register" => (HttpStatusCode.Conflict, """{"error":"name_taken"}""", null),
            _ => (HttpStatusCode.OK, CheckedIn, null),
        };

        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("chuy", "9999", SamePinAgain("9999"), CancellationToken.None));

        // The 2026-09-28 event: a returning driver whose PIN did not match was
        // told to "use a different name". The name is theirs; the PIN is what
        // to try again, and staff are who to ask.
        Assert.True(ex.RetryPin);
        Assert.Contains("\"chuy\" is already registered and that PIN does not match it", ex.Message);
        Assert.Contains("type your PIN again, or ask staff", ex.Message);
        Assert.Contains("Five wrong PINs in a row lock the name for 15 minutes", ex.Message);
        Assert.DoesNotContain("different name", ex.Message);
        Assert.Equal(new[] { "/api/auth/login", "/api/auth/register" }, Paths(backend));
    }

    [Fact]
    public async Task ANameLockedAfterFiveWrongPinsSaysSoAndDoesNotRegister()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) =>
            (HttpStatusCode.TooManyRequests, """{"error":"locked","lockedUntil":"2026-09-27T18:15:00.000Z"}""", null);

        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Mike", "1234", SamePinAgain("1234"), CancellationToken.None));

        Assert.Contains("locked after five wrong PINs", ex.Message);
        Assert.Contains(DateTimeOffset.Parse("2026-09-27T18:15:00Z").ToLocalTime().ToString("HH:mm"), ex.Message);
        Assert.Equal(new[] { "/api/auth/login" }, Paths(backend));
    }

    [Fact]
    public async Task ARateLimitedRegistrationIsWordedAsTheSharedSignInLimit()
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == "/api/auth/login"
            ? (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null)
            : (HttpStatusCode.TooManyRequests, """{"error":"rate_limited"}""", null);

        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Mike", "1234", SamePinAgain("1234"), CancellationToken.None));

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
        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Mike", pin, SamePinAgain(pin), CancellationToken.None));

        Assert.Contains("4 digits", ex.Message);
        Assert.Empty(backend.Requests);
    }

    [Theory]
    [InlineData("/api/auth/login", 400, "not allowed")]
    [InlineData("/api/auth/login", 500, "HTTP 500")]
    [InlineData("/api/auth/register", 400, "not allowed")]
    [InlineData("/api/auth/register", 500, "HTTP 500")]
    [InlineData("/api/checkin", 404, "QR token")]
    [InlineData("/api/checkin", 401, "did not keep the sign-in")]
    [InlineData("/api/checkin", 403, "not allowed to check in")]
    [InlineData("/api/checkin", 409, "same moment")]
    [InlineData("/api/checkin", 429, "too many check-ins")]
    [InlineData("/api/checkin", 500, "HTTP 500")]
    public async Task RefusalsBecomeSentencesForThePersonAtTheRig(string failingPath, int status, string expected)
    {
        var (client, backend) = Build();
        backend.Answer = (path, _) => path == failingPath
            ? ((HttpStatusCode)status, """{"error":"whatever"}""", null)
            : path == "/api/auth/login"
                ? (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}""", null)
                : path == "/api/auth/register"
                    ? (HttpStatusCode.OK, """{"driverId":"d","displayName":"X"}""", "oasis_driver=j; Path=/")
                    : (HttpStatusCode.OK, CheckedIn, null);
        var ex = await Assert.ThrowsAsync<CheckInRefusedException>(() => client.CheckInAsync("Some Name", "1234", SamePinAgain("1234"), CancellationToken.None));
        Assert.Contains(expected, ex.Message);
    }

    [Fact]
    public async Task ABackendThatCannotBeReachedPropagatesSoTheCallerCanSayOffline()
    {
        var (client, backend) = Build();
        backend.Answer = (_, _) => throw new HttpRequestException("connection refused");
        await Assert.ThrowsAsync<HttpRequestException>(() => client.CheckInAsync("Mike", "1234", SamePinAgain("1234"), CancellationToken.None));
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
        await client.CheckInAsync("First", "1111", SamePinAgain("1111"), CancellationToken.None);
        await client.CheckInAsync("Second", "2222", SamePinAgain("2222"), CancellationToken.None);
        // The second sign-in carries no cookie from the first person.
        Assert.Null(backend.Requests[2].Cookie);
    }
}
