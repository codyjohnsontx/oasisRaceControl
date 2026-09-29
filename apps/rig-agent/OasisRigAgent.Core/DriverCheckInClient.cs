using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
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

/// <summary>A new driver was registered but the check-in after it failed
/// (<see cref="Exception.InnerException"/> says how). The name and PIN now
/// belong to them, so the retry is a returning driver's sign-in.</summary>
public sealed class SignedUpButNotCheckedInException : Exception
{
    public SignedUpButNotCheckedInException(Exception inner) : base(inner.Message, inner) { }
}

/// <summary>
/// Signs a walk-up driver in on this rig from the rig PC itself, using the
/// backend's existing name + PIN routes as an HTTP client. A returning driver
/// is `POST /api/auth/login`; a new one is `POST /api/auth/register`, sent only
/// once the rig has had the PIN typed twice. Either sets the driver session
/// cookie, and is followed by `POST /api/checkin` with the rig's QR token,
/// confirming the takeover of whoever was checked in before. Nothing on the
/// server changes - the request shapes are the ones the deployed sign-in and
/// check-in pages send (served at 695e080 and on main alike).
///
/// The rig asks which the driver is ("Raced here before?") rather than
/// guessing from a failed login, so a wrong PIN is never mistaken for a new
/// name; see SignInState in DriverPrompt.cs.
///
/// A name and PIN are the driver's across both event days, so a returning
/// driver's laps accumulate on one leaderboard row. Logging in is repeatable,
/// so a check-in that fails after the sign-in is retried by typing the same
/// name and PIN again - as a returning driver, even after a sign-up.
///
/// Every check-in gets a fresh cookie jar, so one person's session never
/// leaks into the next: the rig is the shared phone here. Every answer that is
/// neither a check-in nor the one expected "no" throws
/// <see cref="CheckInRefusedException"/>; transport failures propagate.
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

    /// <summary>
    /// The key a typed name is counted under for the rig's own login budget.
    /// Two names the backend would treat as one driver always get the same
    /// key, so no spelling of a name buys a fresh set of tries.
    /// <para>The backend trims a name (JavaScript's trim, which also takes
    /// U+FEFF) and matches it as <c>citext</c>: equal after the database's
    /// <c>lower()</c>, which follows its locale and so cannot be copied here.
    /// So this key is deliberately coarser rather than a copy: each character
    /// becomes <c>lower(upper(lower(c)))</c>, which depends only on the
    /// character's lowercase, so anything a locale lowers to the same letter
    /// shares a key (Kelvin sign and k, ẞ and ß, Σ and ς). .NET's invariant
    /// casing leaves out the dotted and dotless i, which Postgres lowers
    /// (İ to i, and I to ı in a Turkish locale), so both are folded to i by
    /// hand, and the combining dot above that an ICU locale lowers İ to
    /// (i then U+0307) is dropped. .NET 8's Unicode tables are older than the
    /// database's, so a letter .NET does not know becomes one placeholder, and
    /// the two newer capitals whose lowercase it does know (U+A7CB, U+A7DC)
    /// are folded by hand. A key coarser than the backend's identity can only
    /// cost a look-alike name its tries on this rig; one finer than it is what
    /// let Mike, Mİke, MiKe and MİKe run one driver into the lockout.</para>
    /// </summary>
    public static string NameKey(string name)
    {
        var key = new StringBuilder(name.Length);
        foreach (var c in name.Replace("\uFEFF", "").Trim().EnumerateRunes())
        {
            if (c.Value == 0x307) continue;
            var folded = c.Value switch
            {
                0x130 or 0x131 => new Rune('i'),
                0xA7CB => new Rune(0x264),
                0xA7DC => new Rune(0x19B),
                _ when Rune.GetUnicodeCategory(c) == UnicodeCategory.OtherNotAssigned => Rune.ReplacementChar,
                _ => Rune.ToLowerInvariant(Rune.ToUpperInvariant(Rune.ToLowerInvariant(c))),
            };
            key.Append(folded.ToString());
        }
        return key.ToString();
    }

    /// <summary>Log a returning driver in and seat them. Null when the name and
    /// PIN match nobody (401) - the same answer, by design, for a wrong PIN, an
    /// unknown name, and a name no PIN signs in (a guest's, a banned
    /// driver's).</summary>
    public async Task<DriverCheckIn?> CheckInReturningAsync(string name, string pin, CancellationToken ct)
    {
        RequirePin(pin);
        using var http = NewHttpClient();
        using var login = await http.PostAsJsonAsync("api/auth/login", new { displayName = name, pin }, ct);
        var body = await ReadJson(login, ct);
        if (login.StatusCode == HttpStatusCode.Unauthorized) return null;
        if ((int)login.StatusCode == 429)
            throw new CheckInRefusedException($"the name \"{name}\" is locked after five wrong PINs - try again {LockedUntil(body)}");
        if (login.StatusCode == HttpStatusCode.BadRequest)
            throw NameNotAllowed();
        if (!login.IsSuccessStatusCode)
            throw new CheckInRefusedException($"the backend could not sign you in (HTTP {(int)login.StatusCode}) - try again");
        return await CheckIn(http, Identify(body, returning: true), ct);
    }

    /// <summary>Register a new driver and seat them. Null when the name is
    /// already taken (409). A check-in that fails once the driver is registered
    /// throws <see cref="SignedUpButNotCheckedInException"/>. The backend does not say how many tries a taken
    /// name has left, only when it locks (MAX_FAILS in driver-auth.ts).</summary>
    public async Task<DriverCheckIn?> CheckInNewAsync(string name, string pin, CancellationToken ct)
    {
        RequirePin(pin);
        using var http = NewHttpClient();
        using var register = await http.PostAsJsonAsync("api/auth/register", new { displayName = name, pin }, ct);
        var body = await ReadJson(register, ct);
        if (register.StatusCode == HttpStatusCode.Conflict) return null;
        if ((int)register.StatusCode == 429)
            throw new CheckInRefusedException("too many sign-in attempts from this network in the last minute, across both rigs - wait a minute and try again");
        if (register.StatusCode == HttpStatusCode.BadRequest)
            throw NameNotAllowed();
        if (!register.IsSuccessStatusCode)
            throw new CheckInRefusedException($"the backend could not sign you up (HTTP {(int)register.StatusCode}) - try again");
        try
        {
            return await CheckIn(http, Identify(body, returning: false), ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            throw new SignedUpButNotCheckedInException(ex);
        }
    }

    private HttpClient NewHttpClient() => new(_handlerFactory(), disposeHandler: true)
    {
        BaseAddress = _baseUri,
        Timeout = TimeSpan.FromSeconds(15),
    };

    private async Task<DriverCheckIn> CheckIn(
        HttpClient http, (string DriverId, string DisplayName, bool Returning) driver, CancellationToken ct)
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
        return new DriverCheckIn(driver.DisplayName, driver.Returning, driver.DriverId, assignmentId);
    }

    private static void RequirePin(string pin)
    {
        if (!IsPin(pin)) throw new CheckInRefusedException("the PIN must be exactly 4 digits");
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
