using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace OasisRigAgent.Core;

/// <summary>What signing a name and PIN in on this rig came to.</summary>
public sealed record DriverCheckIn(
    /// <summary>The name as the backend stores it.</summary>
    string DisplayName,
    /// <summary>True when the name and PIN logged an existing driver back in;
    /// false when they created a new one.</summary>
    bool Returning,
    string DriverId,
    string AssignmentId);

/// <summary>A check-in the backend refused, in words the person at the rig can act on.</summary>
public sealed class CheckInRefusedException : Exception
{
    public CheckInRefusedException(string message) : base(message) { }
}

/// <summary>
/// Signs a walk-up driver in on this rig from the rig PC itself, using the
/// backend's existing name + PIN routes as an HTTP client: `POST
/// /api/auth/login` with the typed name and PIN, `POST /api/auth/register` to
/// create a driver (either sets the driver session cookie), then `POST
/// /api/checkin` with the rig's QR token, confirming the takeover of whoever
/// was checked in before. Nothing on the server changes - the request shapes
/// are the ones the deployed sign-in and check-in pages send (served at
/// 695e080 and on main alike).
///
/// The steps are separate so the rig's prompt decides between them (when a
/// sign-up is offered, when a PIN has been confirmed, when to stop): see
/// SignInState in DriverPrompt.cs.
///
/// A name and PIN are the driver's across both event days, so a returning
/// driver's laps accumulate on one leaderboard row. Logging in is repeatable,
/// so a check-in that fails after the sign-in is retried by typing the same
/// name and PIN again.
///
/// Every sign-in gets a fresh cookie jar, so one person's session never
/// leaks into the next: the rig is the shared phone here.
/// </summary>
public sealed class DriverCheckInClient
{
    private readonly Func<HttpMessageHandler> _handlerFactory;
    private readonly Uri _baseUri;
    private readonly string _qrToken;

    public DriverCheckInClient(string baseUrl, string qrToken, Func<HttpMessageHandler>? handlerFactory = null)
    {
        _baseUri = new Uri(baseUrl.TrimEnd('/') + "/");
        _qrToken = qrToken;
        _handlerFactory = handlerFactory ?? (() => new HttpClientHandler { UseCookies = true, CookieContainer = new CookieContainer() });
    }

    /// <summary>The backend's PIN rule: exactly four digits.</summary>
    public static bool IsPin(string pin) => pin.Length == 4 && pin.All(char.IsAsciiDigit);

    /// <summary>One person's sign-in, with its own cookie jar.</summary>
    public DriverSignIn StartSignIn() => new(new HttpClient(_handlerFactory(), disposeHandler: true)
    {
        BaseAddress = _baseUri,
        Timeout = TimeSpan.FromSeconds(15),
    }, _qrToken);
}

/// <summary>
/// The backend steps of one sign-in. <see cref="LogInAsync"/> or
/// <see cref="RegisterAsync"/> answering true leaves the session cookie in
/// this sign-in's jar, and <see cref="CheckInAsync"/> then seats that driver.
/// Every answer that is neither a sign-in nor the one expected "no" throws
/// <see cref="CheckInRefusedException"/>; transport failures propagate.
/// </summary>
public sealed class DriverSignIn : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _qrToken;
    private (string DriverId, string DisplayName, bool Returning)? _driver;

    internal DriverSignIn(HttpClient http, string qrToken)
    {
        _http = http;
        _qrToken = qrToken;
    }

    /// <summary>True when the name and PIN logged a driver in; false when they
    /// matched nobody (401). That is the same answer, by design, for an unknown
    /// name, a wrong PIN, and a name no PIN can sign in (a guest's, a banned
    /// driver's): registering is what tells a taken name apart.</summary>
    public async Task<bool> LogInAsync(string name, string pin, CancellationToken ct)
    {
        RequirePin(pin);
        using var login = await _http.PostAsJsonAsync("api/auth/login", new { displayName = name, pin }, ct);
        var body = await ReadJson(login, ct);
        if (login.IsSuccessStatusCode)
        {
            _driver = Identify(body, returning: true);
            return true;
        }
        if (login.StatusCode == HttpStatusCode.Unauthorized) return false;
        if ((int)login.StatusCode == 429)
            throw new CheckInRefusedException($"the name \"{name}\" is locked after five wrong PINs - try again {LockedUntil(body)}");
        if (login.StatusCode == HttpStatusCode.BadRequest)
            throw NameNotAllowed();
        throw new CheckInRefusedException($"the backend could not sign you in (HTTP {(int)login.StatusCode}) - try again");
    }

    /// <summary>True when a new driver was created with the name and PIN; false
    /// when the name is already taken (409). The backend does not say how many
    /// tries a taken name has left, only when it locks (MAX_FAILS in
    /// driver-auth.ts).</summary>
    public async Task<bool> RegisterAsync(string name, string pin, CancellationToken ct)
    {
        RequirePin(pin);
        using var register = await _http.PostAsJsonAsync("api/auth/register", new { displayName = name, pin }, ct);
        var body = await ReadJson(register, ct);
        if (register.IsSuccessStatusCode)
        {
            _driver = Identify(body, returning: false);
            return true;
        }
        if (register.StatusCode == HttpStatusCode.Conflict) return false;
        if ((int)register.StatusCode == 429)
            throw new CheckInRefusedException("too many sign-in attempts from this network in the last minute, across both rigs - wait a minute and try again");
        if (register.StatusCode == HttpStatusCode.BadRequest)
            throw NameNotAllowed();
        throw new CheckInRefusedException($"the backend could not sign you up (HTTP {(int)register.StatusCode}) - try again");
    }

    /// <summary>Put the driver this sign-in logged in or registered in this rig's seat.</summary>
    public async Task<DriverCheckIn> CheckInAsync(CancellationToken ct)
    {
        var (driverId, displayName, returning) = _driver
            ?? throw new InvalidOperationException("check-in needs a driver logged in or registered first");
        using var res = await _http.PostAsJsonAsync("api/checkin", new
        {
            qrToken = _qrToken,
            confirmMove = true,
            confirmTakeover = true,
        }, ct);
        var body = await ReadJson(res, ct);
        if (res.StatusCode == HttpStatusCode.NotFound)
            throw new CheckInRefusedException("this rig's QR token is not registered on the backend - check rigQrToken in agent.config.json");
        if (res.StatusCode == HttpStatusCode.Unauthorized)
            throw new CheckInRefusedException("the backend did not keep the sign-in session (is backendBaseUrl https?)");
        if (res.StatusCode == HttpStatusCode.Forbidden)
            throw new CheckInRefusedException("this driver is not allowed to check in - ask staff");
        if (res.StatusCode == HttpStatusCode.Conflict)
            throw new CheckInRefusedException("someone else checked in at the same moment - type your name and PIN again");
        if ((int)res.StatusCode == 429)
            throw new CheckInRefusedException("too many check-ins from this network in the last minute - wait a moment and try again");
        if (!res.IsSuccessStatusCode)
            throw new CheckInRefusedException($"the backend could not check you in (HTTP {(int)res.StatusCode}) - try again");

        var status = body?["status"]?.GetValue<string>();
        var assignmentId = body?["assignmentId"]?.GetValue<string>();
        if (status is not ("checked_in" or "already_checked_in") || assignmentId is null)
            throw new CheckInRefusedException($"check-in did not complete (backend said {status ?? "nothing"})");
        return new DriverCheckIn(displayName, returning, driverId, assignmentId);
    }

    public void Dispose() => _http.Dispose();

    private static void RequirePin(string pin)
    {
        if (!DriverCheckInClient.IsPin(pin)) throw new CheckInRefusedException("the PIN must be exactly 4 digits");
    }

    private static (string DriverId, string DisplayName, bool Returning) Identify(JsonNode? body, bool returning)
    {
        var driverId = body?["driverId"]?.GetValue<string>();
        var displayName = body?["displayName"]?.GetValue<string>();
        if (driverId is null || displayName is null)
            throw new CheckInRefusedException("the backend signed the name in but did not say who it is");
        return (driverId, displayName, returning);
    }

    private static CheckInRefusedException NameNotAllowed() =>
        new("that name is not allowed: 2 to 24 letters, numbers, spaces or . _ ' -");

    private static string LockedUntil(JsonNode? body) =>
        DateTimeOffset.TryParse(body?["lockedUntil"]?.GetValue<string>(), CultureInfo.InvariantCulture, DateTimeStyles.None, out var until)
            ? $"after {until.ToLocalTime():HH:mm}"
            : "in 15 minutes";

    private static async Task<JsonNode?> ReadJson(HttpResponseMessage res, CancellationToken ct)
    {
        var text = await res.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { return JsonNode.Parse(text); }
        catch (System.Text.Json.JsonException) { return null; }
    }
}
