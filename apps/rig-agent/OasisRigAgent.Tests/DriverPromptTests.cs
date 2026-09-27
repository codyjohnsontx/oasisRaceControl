using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The walk-up screens as the person at the rig meets them, driven through a
/// console that records what was shown, what was typed and every clear. The
/// PIN is visible while it is typed and gone the moment Enter is pressed;
/// signed in, the screen is the name and how to log out; logging out clears
/// back to the sign-in screen.
/// </summary>
public sealed class DriverPromptTests : IDisposable
{
    private const string MikeAssignmentId = "3f1b0c8e-3a1c-4f6d-9c2f-1a2b3c4d5e6f";
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-prompt-{Guid.NewGuid():N}.db");

    /// <summary>Plays typed lines back in order and records the screen. Input
    /// running out is the console closing.</summary>
    private sealed class RecordingConsole : IPromptConsole
    {
        private readonly Queue<string> _typed;
        private readonly List<string> _transcript = new();

        /// <summary>Runs before a typed line is handed back - what the person
        /// does on the current screen before pressing Enter.</summary>
        public Func<string, Task>? BeforeTyping { get; init; }

        public RecordingConsole(params string[] typed) => _typed = new Queue<string>(typed);

        public List<string> Transcript { get { lock (_transcript) return _transcript.ToList(); } }

        public async Task<string?> ReadLineAsync(CancellationToken quit)
        {
            if (!_typed.TryDequeue(out var line)) return null;
            if (BeforeTyping is { } before) await before(line);
            Add($"typed:{line}");
            return line;
        }

        public void WriteLine(string line = "") => Add(line);
        public void Clear() => Add("<clear>");

        private void Add(string entry) { lock (_transcript) _transcript.Add(entry); }

        /// <summary>What was on screen after the last clear before
        /// <paramref name="end"/>.</summary>
        public List<string> ScreenBefore(int end)
        {
            var transcript = Transcript;
            var start = transcript.LastIndexOf("<clear>", end - 1);
            return transcript.GetRange(start + 1, end - start - 1);
        }
    }

    /// <summary>The deployed routes this flow reaches: Mike's PIN is 4321, so
    /// any other PIN fails login and then finds the name taken.</summary>
    private sealed class Backend : HttpMessageHandler
    {
        public readonly List<string?> Checkouts = new();
        private volatile string? _open;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var text = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            var (status, answer) = request.RequestUri!.AbsolutePath switch
            {
                "/api/auth/login" when body?["pin"]?.GetValue<string>() == "4321" =>
                    (HttpStatusCode.OK, """{"driverId":"d-mike","displayName":"Mike"}"""),
                "/api/auth/login" => (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}"""),
                "/api/auth/register" => (HttpStatusCode.Conflict, """{"error":"name_taken"}"""),
                "/api/checkin" => CheckIn(),
                "/api/agent/checkout" => Checkout(body?["assignmentId"]?.GetValue<string>()),
                "/api/agent/assignment" => (HttpStatusCode.OK, _open is null
                    ? """{"assignment":null}"""
                    : """{"assignment":{"id":""" + $"\"{_open}\"" + ""","startedAt":"2026-09-27T17:00:00.000Z","driver":{"id":"d-mike","displayName":"Mike"}}}"""),
                _ => (HttpStatusCode.OK, Accept(body)),
            };
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

        private (HttpStatusCode, string) CheckIn()
        {
            _open = MikeAssignmentId;
            return (HttpStatusCode.OK, $$"""{"status":"checked_in","assignmentId":"{{MikeAssignmentId}}"}""");
        }

        private (HttpStatusCode, string) Checkout(string? assignmentId)
        {
            lock (Checkouts) Checkouts.Add(assignmentId);
            var ends = _open is not null && (assignmentId is null || assignmentId == _open);
            if (ends) _open = null;
            return (HttpStatusCode.OK, ends ? """{"ended":true}""" : """{"ended":false}""");
        }
    }

    [Fact]
    public async Task ThePinLeavesTheScreenOnEnterAndLogOutReturnsToSignIn()
    {
        var backend = new Backend();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 2, RigQrToken = "qr-rig-2" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-2", () => backend);
        var screen = new RecordingConsole("Mike", "12", "1234", "Mike", "4321", "");

        await DriverPrompt.RunAsync(agent, checkIn, 2, screen, CancellationToken.None);

        var t = screen.Transcript;

        // A PIN that is not four digits is cleared and asked for again, the name kept.
        var shortPin = t.IndexOf("typed:12");
        Assert.Equal("<clear>", t[shortPin + 1]);
        var again = t.IndexOf("Name: Mike", shortPin);
        Assert.Contains("The PIN is exactly 4 digits.", screen.ScreenBefore(again));

        // Every full PIN leaves the screen as soon as Enter is pressed, before
        // the backend is even asked.
        Assert.Equal("<clear>", t[t.IndexOf("typed:1234") + 1]);
        Assert.Equal("<clear>", t[t.IndexOf("typed:4321") + 1]);

        // A refused sign-in says why on a fresh sign-in screen.
        var refusedScreen = screen.ScreenBefore(t.IndexOf("typed:Mike", t.IndexOf("typed:1234")));
        Assert.Contains("  OASIS RACE CONTROL - RIG 02 - SIGN IN", refusedScreen);
        Assert.Contains(refusedScreen, l => l.StartsWith("Could not sign in:") && l.Contains("different PIN"));

        // Signed in: the name and how to log out, and nothing typed at sign-in.
        var driving = screen.ScreenBefore(t.LastIndexOf("typed:"));
        Assert.Contains("  RIG 02 - DRIVING: Mike", driving);
        Assert.Contains("Press Enter to log out.", driving);
        Assert.DoesNotContain(driving, l => l.Contains("4321") || l.StartsWith("typed:"));

        // Logging out clears back to the sign-in screen, which thanks them.
        var afterLogout = t.GetRange(t.LastIndexOf("typed:") + 1, t.Count - t.LastIndexOf("typed:") - 1);
        Assert.Equal("<clear>", afterLogout[0]);
        Assert.Contains("  OASIS RACE CONTROL - RIG 02 - SIGN IN", afterLogout);
        Assert.Contains("Thanks Mike, you are logged out.", afterLogout);

        // No lap can be read on this rig, and every screen says so under its
        // banner, however many times it has been cleared.
        const string noSim = "WARNING: iRacing is not running or not in a session - no laps are being read.";
        Assert.Contains(noSim, refusedScreen);
        Assert.Contains(noSim, driving);
        Assert.Contains(noSim, afterLogout);

        // The seat was emptied on start, and Mike's stint ended at log out.
        lock (backend.Checkouts) Assert.Equal(new string?[] { null, MikeAssignmentId }, backend.Checkouts);
    }

    /// <summary>Telemetry the test drives by hand, with iRacing in a session.</summary>
    private sealed class HandTelemetry : ITelemetrySource
    {
        public bool SimRunning => true;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { }

        public void Emit(string eventId, int lapNumber) => LapCompleted?.Invoke(new LapCompleted
        {
            EventId = eventId,
            TrackName = "Circuit of the Americas",
            TrackConfig = "Grand Prix",
            CarName = "FIA F4",
            LapNumber = lapNumber,
            LapTimeMs = 137_217,
            IncidentDelta = 0,
            CompletedAt = DateTimeOffset.UtcNow,
        });
    }

    /// <summary>A lap driven before anyone signs in says it did not count; a
    /// signed-in driver's lap says queued, and posted only once the backend
    /// has it.</summary>
    [Fact]
    public async Task LapsSayWhetherTheyCountAndPostedOnlyOnceTheBackendHasThem()
    {
        var backend = new Backend();
        var telemetry = new HandTelemetry();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, telemetry);
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);

        RecordingConsole screen = null!;
        screen = new RecordingConsole("Mike", "4321", "")
        {
            BeforeTyping = async line =>
            {
                if (line == "Mike") telemetry.Emit("evt-nobody", lapNumber: 1);
                if (line != "") return;
                telemetry.Emit("evt-mike", lapNumber: 2);
                var deadline = DateTime.UtcNow.AddSeconds(20);
                while (!screen.Transcript.Any(l => l.Contains("Lap 2") && l.EndsWith("- posted")))
                {
                    if (DateTime.UtcNow > deadline) throw new TimeoutException("lap 2 was never posted");
                    await Task.Delay(50);
                }
            },
        };

        await DriverPrompt.RunAsync(agent, checkIn, 1, screen, CancellationToken.None);

        var t = screen.Transcript;
        Assert.Contains(t, l => l.EndsWith("Lap 1  2:17.217  incidents 0 - lap not counted - sign in first"));
        Assert.DoesNotContain(t, l => l.Contains("Lap 1") && (l.EndsWith("- queued") || l.EndsWith("- posted")));
        var queuedAt = t.FindIndex(l => l.EndsWith("Lap 2  2:17.217  incidents 0 - queued"));
        var postedAt = t.FindIndex(l => l.EndsWith("Lap 2  2:17.217  incidents 0 - posted"));
        Assert.True(queuedAt >= 0 && postedAt > queuedAt, string.Join(" | ", t));
        Assert.DoesNotContain(t, l => l.StartsWith("WARNING: iRacing"));
    }

    public void Dispose()
    {
        foreach (var file in Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(_dbPath) + "*"))
            File.Delete(file);
    }
}
