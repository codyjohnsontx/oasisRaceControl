using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace OasisRigAgent.Core;

/// <summary>What signing a typed name in on this rig came to.</summary>
public sealed record DriverCheckIn(
    /// <summary>The name the backend gave the driver - the typed one, or the
    /// rename it offered when that name was taken ("Mike 47").</summary>
    string DisplayName,
    /// <summary>True when the typed name was taken and the backend's suggestion was used.</summary>
    bool Renamed,
    string DriverId,
    string AssignmentId);

/// <summary>A check-in the backend refused, in words the person at the rig can act on.</summary>
public sealed class CheckInRefusedException : Exception
{
    public CheckInRefusedException(string message) : base(message) { }
}

/// <summary>
/// Signs a walk-up driver in on this rig from the rig PC itself, using the
/// backend's existing phone flow as an HTTP client: `POST /api/auth/guest`
/// with the typed name (which sets the driver session cookie), then
/// `POST /api/checkin` with the rig's QR token, confirming the takeover of
/// whoever was checked in before. Nothing on the server changes - the request
/// shapes are the ones the deployed check-in page sends
/// (`apps/web/src/components/check-in-flow.tsx`, served at 695e080 and on
/// main alike).
///
/// Every check-in gets a fresh cookie jar, so one person's session never
/// leaks into the next: the rig is the shared phone here, and "Not you?
/// Switch driver" is the name prompt.
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

    /// <summary>Guest-sign the name in and put that driver in this rig's seat.
    /// A taken name is retried once with the backend's own suggestion; the
    /// result says which name stuck. Throws <see cref="CheckInRefusedException"/>
    /// for answers a person can act on, and lets transport failures propagate.</summary>
    public async Task<DriverCheckIn> CheckInAsync(string typedName, CancellationToken ct)
    {
        using var http = new HttpClient(_handlerFactory(), disposeHandler: true)
        {
            BaseAddress = _baseUri,
            Timeout = TimeSpan.FromSeconds(15),
        };

        var (driverId, displayName, renamed) = await SignInAsGuest(http, typedName, ct);

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
        if ((int)res.StatusCode == 429)
            throw new CheckInRefusedException("too many check-ins from this network in the last minute - wait a moment and try again");
        res.EnsureSuccessStatusCode();

        var status = body?["status"]?.GetValue<string>();
        var assignmentId = body?["assignmentId"]?.GetValue<string>();
        if (status is not ("checked_in" or "already_checked_in") || assignmentId is null)
            throw new CheckInRefusedException($"check-in did not complete (backend said {status ?? "nothing"})");

        return new DriverCheckIn(displayName, renamed, driverId, assignmentId);
    }

    private static async Task<(string DriverId, string DisplayName, bool Renamed)> SignInAsGuest(
        HttpClient http, string typedName, CancellationToken ct)
    {
        var renamed = false;
        var name = typedName;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var res = await http.PostAsJsonAsync("api/auth/guest", new { displayName = name }, ct);
            var body = await ReadJson(res, ct);
            if (res.IsSuccessStatusCode)
            {
                var driverId = body?["driverId"]?.GetValue<string>();
                var displayName = body?["displayName"]?.GetValue<string>();
                if (driverId is null || displayName is null)
                    throw new CheckInRefusedException("the backend signed the name in but did not say who it is");
                return (driverId, displayName, renamed);
            }

            var error = body?["error"]?.GetValue<string>();
            if (res.StatusCode == HttpStatusCode.Conflict && error == "name_taken")
            {
                // Somebody already has that name tonight. Take the rename the
                // backend offers ("Mike 47"), once; a second collision is not
                // something to keep guessing at.
                var suggestion = body?["suggestion"]?.GetValue<string>();
                if (attempt == 0 && !string.IsNullOrWhiteSpace(suggestion))
                {
                    name = suggestion;
                    renamed = true;
                    continue;
                }
                throw new CheckInRefusedException($"the name \"{name}\" is already taken - try another");
            }
            if ((int)res.StatusCode == 429)
                throw new CheckInRefusedException("too many sign-ins from this network in the last minute - wait a moment and try again");
            if (res.StatusCode == HttpStatusCode.BadRequest)
                throw new CheckInRefusedException("that name is not allowed: 2 to 24 letters, numbers, spaces or . _ ' -");
            res.EnsureSuccessStatusCode();
        }
        throw new CheckInRefusedException($"the name \"{name}\" is already taken - try another");
    }

    private static async Task<JsonNode?> ReadJson(HttpResponseMessage res, CancellationToken ct)
    {
        var text = await res.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { return JsonNode.Parse(text); }
        catch (System.Text.Json.JsonException) { return null; }
    }
}
