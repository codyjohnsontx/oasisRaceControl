using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace OasisRigAgent.Tests;

/// <summary>The deployed routes this flow reaches: Mike's PIN is 4321, so
/// any other PIN fails login and then finds the name taken; "Guest" is
/// taken but no PIN logs it in, as a guest's or a banned driver's name;
/// any other name is new and registers. A check-in
/// while Mike's stint is still open answers with that same stint, as
/// check_in_driver does; otherwise it opens a new one.</summary>
internal sealed class WalkUpBackend : HttpMessageHandler
{
    public const string MikeAssignmentId = "3f1b0c8e-3a1c-4f6d-9c2f-1a2b3c4d5e6f";

    public readonly List<string?> Checkouts = new();
    public readonly List<string> Calls = new();
    public readonly List<string> RegisteredPins = new();
    public volatile bool CheckoutUnreachable;
    public volatile bool FailNextCheckIn;
    private readonly Dictionary<string, string> _pins = new() { ["Mike"] = "4321" };
    public volatile bool RefuseLaps;
    public int AssignmentPolls;
    private volatile string? _open;
    private int _stints;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var path = request.RequestUri!.AbsolutePath;
        if (path == "/api/agent/checkout" && CheckoutUnreachable) throw new HttpRequestException("venue wifi is down");
        if (path == "/api/agent/assignment") Interlocked.Increment(ref AssignmentPolls);
        var text = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        var name = body?["displayName"]?.GetValue<string>() ?? "";
        var pin = body?["pin"]?.GetValue<string>() ?? "";
        if (path == "/api/auth/register") lock (RegisteredPins) RegisteredPins.Add(pin);
        var identity = """{"driverId":""" + $"\"{(name == "Mike" ? "d-mike" : "d-new")}\",\"displayName\":\"{name}\"" + "}";
        var (status, answer) = path switch
        {
            "/api/auth/login" when Knows(name, pin) => (HttpStatusCode.OK, identity),
            "/api/auth/login" => (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}"""),
            "/api/auth/register" when !SignUp(name, pin) => (HttpStatusCode.Conflict, """{"error":"name_taken"}"""),
            "/api/auth/register" => (HttpStatusCode.OK, identity),
            "/api/checkin" when FailNextCheckIn => FailCheckIn(),
            "/api/checkin" => CheckIn(),
            "/api/agent/checkout" => Checkout(body?["assignmentId"]?.GetValue<string>()),
            "/api/agent/events" when RefuseLaps && body?["events"]?.AsArray().Any(e => e?["type"]?.GetValue<string>() == "LAP_COMPLETED") == true =>
                (HttpStatusCode.BadRequest, """{"error":"invalid_input","detail":[{"code":"too_big","path":["events",0,"lapTimeMs"],"message":"Too big"}]}"""),
            "/api/agent/assignment" => (HttpStatusCode.OK, _open is null
                ? """{"assignment":null}"""
                : """{"assignment":{"id":""" + $"\"{_open}\"" + ""","startedAt":"2026-09-27T17:00:00.000Z","driver":{"id":"d-mike","displayName":"Mike"}}}"""),
            _ => (HttpStatusCode.OK, Accept(body)),
        };
        lock (Calls) Calls.Add($"{path} {answer}");
        return new HttpResponseMessage(status) { Content = new StringContent(answer, Encoding.UTF8, "application/json") };
    }

    /// <summary>api/agent/events: every lap is stored.</summary>
    private static string Accept(JsonNode? body)
    {
        var results = new JsonArray();
        foreach (var e in body?["events"]?.AsArray() ?? new JsonArray())
        {
            if (e?["type"]?.GetValue<string>() != "LAP_COMPLETED") continue;
            results.Add(new JsonObject
            {
                ["type"] = "LAP_COMPLETED",
                ["eventId"] = e["eventId"]!.GetValue<string>(),
                ["status"] = "accepted",
            });
        }
        return new JsonObject { ["results"] = results }.ToJsonString();
    }

    private bool Knows(string name, string pin)
    {
        lock (_pins) return _pins.TryGetValue(name, out var known) && known == pin;
    }

    /// <summary>"Guest" is taken but has no PIN, as a guest's or a banned
    /// driver's name.</summary>
    private bool SignUp(string name, string pin)
    {
        lock (_pins) return name != "Guest" && _pins.TryAdd(name, pin);
    }

    private (HttpStatusCode, string) FailCheckIn()
    {
        FailNextCheckIn = false;
        return (HttpStatusCode.Conflict, """{"error":"conflict"}""");
    }

    private (HttpStatusCode, string) CheckIn()
    {
        if (_open is { } open)
            return (HttpStatusCode.OK, $$"""{"status":"already_checked_in","assignmentId":"{{open}}"}""");
        _open = Interlocked.Increment(ref _stints) == 1 ? MikeAssignmentId : Guid.NewGuid().ToString();
        return (HttpStatusCode.OK, $$"""{"status":"checked_in","assignmentId":"{{_open}}"}""");
    }

    private (HttpStatusCode, string) Checkout(string? assignmentId)
    {
        lock (Checkouts) Checkouts.Add(assignmentId);
        var ends = _open is not null && (assignmentId is null || assignmentId == _open);
        if (ends) _open = null;
        return (HttpStatusCode.OK, ends ? """{"ended":true}""" : """{"ended":false}""");
    }
}
