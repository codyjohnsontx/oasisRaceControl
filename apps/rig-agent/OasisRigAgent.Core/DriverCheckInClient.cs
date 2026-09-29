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
    public CheckInRefusedException(string message, bool retryPin = false) : base(message) => RetryPin = retryPin;

    /// <summary>True when the name stands and only the PIN needs typing again:
    /// the name is registered to a different PIN, or a new PIN was not
    /// confirmed. Every such refusal follows a login the backend refused.</summary>
    public bool RetryPin { get; }
}

/// <summary>
/// Signs a walk-up driver in on this rig from the rig PC itself, using the
/// backend's existing name + PIN routes as an HTTP client: `POST
/// /api/auth/login` with the typed name and PIN, and when that name and PIN
/// match nobody, `POST /api/auth/register` to create the driver (either sets
/// the driver session cookie) - but only once the PIN has been typed a second
/// time and matches, because a PIN mistyped at sign-up is one its owner can
/// never sign back in with; then `POST /api/checkin` with the rig's QR
/// token, confirming the takeover of whoever was checked in before. Nothing
/// on the server changes - the request shapes are the ones the deployed
/// sign-in and check-in pages send (served at 695e080 and on main alike).
///
/// A name and PIN are the driver's across both event days, so a returning
/// driver's laps accumulate on one leaderboard row. Logging in is repeatable,
/// so a check-in that fails after the sign-in is retried by typing the same
/// name and PIN again.
///
/// Every check-in gets a fresh cookie jar, so one person's session never
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

    /// <summary>Log the name in with its PIN (or register it when that name and
    /// PIN match nobody) and put that driver in this rig's seat. Throws
    /// <see cref="CheckInRefusedException"/> for every answer the backend gives
    /// that is not a check-in, and lets transport failures propagate.
    ///
    /// <paramref name="confirmNewPin"/> is asked for the PIN again only when the
    /// login matched nobody, before anything is registered: a returning driver
    /// with the right PIN types it once. Answering null gives up (the program is
    /// closing) and throws <see cref="OperationCanceledException"/>; an empty
    /// answer or a different PIN registers nothing. Pass null for
    /// <paramref name="confirmNewPin"/> when no sign-up is to be offered: a
    /// login that fails is then refused as a wrong PIN, and nothing is
    /// registered.</summary>
    public async Task<DriverCheckIn> CheckInAsync(
        string name, string pin, Func<CancellationToken, Task<string?>>? confirmNewPin, CancellationToken ct)
    {
        if (!IsPin(pin)) throw new CheckInRefusedException("the PIN must be exactly 4 digits");

        using var http = new HttpClient(_handlerFactory(), disposeHandler: true)
        {
            BaseAddress = _baseUri,
            Timeout = TimeSpan.FromSeconds(15),
        };
        var (driverId, displayName, returning) = await SignIn(http, name, pin, confirmNewPin, ct);
        var assignmentId = await CheckIn(http, ct);
        return new DriverCheckIn(displayName, returning, driverId, assignmentId);
    }

    private static async Task<(string DriverId, string DisplayName, bool Returning)> SignIn(
        HttpClient http, string name, string pin, Func<CancellationToken, Task<string?>>? confirmNewPin, CancellationToken ct)
    {
        using (var login = await http.PostAsJsonAsync("api/auth/login", new { displayName = name, pin }, ct))
        {
            var body = await ReadJson(login, ct);
            if (login.IsSuccessStatusCode) return Identify(body, returning: true);
            if ((int)login.StatusCode == 429)
                throw new CheckInRefusedException($"the name \"{name}\" is locked after five wrong PINs - try again {LockedUntil(body)}");
            if (login.StatusCode == HttpStatusCode.BadRequest)
                throw NameNotAllowed();
            // 401 is the same answer for an unknown name and a wrong PIN, by
            // design; registering is what tells the two apart.
            if (login.StatusCode != HttpStatusCode.Unauthorized)
                throw new CheckInRefusedException($"the backend could not sign you in (HTTP {(int)login.StatusCode}) - try again");
        }
        if (confirmNewPin is null) throw WrongPin(name);

        var again = await confirmNewPin(ct) ?? throw new OperationCanceledException(ct);
        if (again.Length == 0)
            throw new CheckInRefusedException("nothing was signed up - type your PIN again", retryPin: true);
        if (again != pin)
            throw new CheckInRefusedException("the two PINs did not match, so nothing was signed up - type your PIN again", retryPin: true);

        using var register = await http.PostAsJsonAsync("api/auth/register", new { displayName = name, pin }, ct);
        var registered = await ReadJson(register, ct);
        if (register.IsSuccessStatusCode) return Identify(registered, returning: false);
        // The login above already said no to this name and PIN, so a taken
        // name means a wrong PIN for it. The backend does not say how many
        // tries are left, only when the name locks (MAX_FAILS in driver-auth.ts).
        if (register.StatusCode == HttpStatusCode.Conflict) throw WrongPin(name);
        if ((int)register.StatusCode == 429)
            throw new CheckInRefusedException("too many sign-in attempts from this network in the last minute, across both rigs - wait a minute and try again");
        if (register.StatusCode == HttpStatusCode.BadRequest)
            throw NameNotAllowed();
        throw new CheckInRefusedException($"the backend could not sign you up (HTTP {(int)register.StatusCode}) - try again");
    }

    private async Task<string> CheckIn(HttpClient http, CancellationToken ct)
    {
        using var res = await http.PostAsJsonAsync("api/checkin", new
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
        return assignmentId;
    }

    private static (string DriverId, string DisplayName, bool Returning) Identify(JsonNode? body, bool returning)
    {
        var driverId = body?["driverId"]?.GetValue<string>();
        var displayName = body?["displayName"]?.GetValue<string>();
        if (driverId is null || displayName is null)
            throw new CheckInRefusedException("the backend signed the name in but did not say who it is");
        return (driverId, displayName, returning);
    }

    private static CheckInRefusedException WrongPin(string name) =>
        new($"the name \"{name}\" is already registered and that PIN does not match. If this is your name, type your PIN again or ask staff. If \"{name}\" is not you, press Enter to pick a different name.",
            retryPin: true);

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
