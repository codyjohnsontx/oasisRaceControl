using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using OasisRigAgent.Core;
using Xunit;
using static OasisRigAgent.Tests.TestSignIn;

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

        /// <summary>Runs once, when input first runs out - whatever happens
        /// while the program is closing, before the prompt loop resumes.</summary>
        public Func<Task>? OnInputEnded { get; init; }
        private int _inputEnded;

        public RecordingConsole(params string[] typed) => _typed = new Queue<string>(typed);

        public List<string> Transcript { get { lock (_transcript) return _transcript.ToList(); } }

        public async Task<string?> ReadLineAsync(CancellationToken quit)
        {
            if (!_typed.TryDequeue(out var line))
            {
                if (OnInputEnded is { } ended && Interlocked.Exchange(ref _inputEnded, 1) == 0) await ended();
                return null;
            }
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
    /// any other PIN fails login and then finds the name taken; "Guest" is
    /// taken but no PIN logs it in, as a guest's or a banned driver's name;
    /// any other name is new and registers. A check-in
    /// while Mike's stint is still open answers with that same stint, as
    /// check_in_driver does; otherwise it opens a new one.</summary>
    private sealed class Backend : HttpMessageHandler
    {
        public readonly List<string?> Checkouts = new();
        public readonly List<string> Calls = new();
        public readonly List<string> RegisteredPins = new();
        public volatile bool CheckoutUnreachable;
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
            if (path == "/api/auth/register") lock (RegisteredPins) RegisteredPins.Add(body?["pin"]?.GetValue<string>() ?? "");
            var (status, answer) = path switch
            {
                "/api/auth/login" when body?["displayName"]?.GetValue<string>() == "Mike" && body?["pin"]?.GetValue<string>() == "4321" =>
                    (HttpStatusCode.OK, """{"driverId":"d-mike","displayName":"Mike"}"""),
                "/api/auth/login" => (HttpStatusCode.Unauthorized, """{"error":"invalid_credentials"}"""),
                "/api/auth/register" when body?["displayName"]?.GetValue<string>() is "Mike" or "Guest" =>
                    (HttpStatusCode.Conflict, """{"error":"name_taken"}"""),
                "/api/auth/register" => (HttpStatusCode.OK, """{"driverId":"d-new","displayName":""" + $"\"{body?["displayName"]}\"" + "}"),
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
        var screen = new RecordingConsole("Mike", "12", "1234", "1234", "4321", "");

        await DriverPrompt.RunAsync(agent, checkIn, 2, new WalkUpScreen(screen, agent), CancellationToken.None);

        var t = screen.Transcript;

        // A PIN that is not four digits is cleared and asked for again, the name kept.
        var shortPin = t.IndexOf("typed:12");
        Assert.Equal("<clear>", t[shortPin + 1]);
        var again = t.IndexOf("Name: Mike", shortPin);
        Assert.Contains("The PIN is exactly 4 digits.", screen.ScreenBefore(again));

        // Every full PIN leaves the screen as soon as Enter is pressed, before
        // the backend is even asked - the second one too.
        Assert.Equal("<clear>", t[t.IndexOf("typed:1234") + 1]);
        Assert.Equal("<clear>", t[t.LastIndexOf("typed:1234") + 1]);
        Assert.Equal("<clear>", t[t.IndexOf("typed:4321") + 1]);

        // A name and PIN that match nobody are asked for the PIN again before
        // anything is registered.
        var confirmScreen = screen.ScreenBefore(t.LastIndexOf("typed:1234"));
        Assert.Contains("No driver is signed up as \"Mike\" with that PIN.", confirmScreen);
        Assert.Contains("Name: Mike", confirmScreen);
        Assert.Contains(confirmScreen, l => l.StartsWith("New here? Type the same PIN again to sign up"));

        // The name is already registered, so that was a wrong PIN: the screen
        // says so plainly and asks for the PIN again, the name kept.
        var refusedScreen = screen.ScreenBefore(t.IndexOf("typed:4321"));
        Assert.Contains("  OASIS RACE CONTROL - RIG 02 - SIGN IN", refusedScreen);
        Assert.Contains(refusedScreen, l => l.StartsWith("Could not sign in:") && l.Contains("is already registered and that PIN does not match."));
        Assert.Contains("Name: Mike", refusedScreen);
        Assert.Contains(refusedScreen, l => l.StartsWith("Type your 4-digit PIN"));

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


    private const string NameScreen = "Type your name and press Enter:";
    private const string MikeTaken = "Could not sign in: the name \"Mike\" is already registered and that PIN does not match. If this is your name, type your PIN again or ask staff. If \"Mike\" is not you, press Enter to pick a different name.";
    private const string MikeTwice = "The PIN for \"Mike\" did not match twice. If \"Mike\" is your name, ask staff to reset your PIN; if not, pick a different name.";

    /// <summary>Every sign-in sequence, typed line by line: how many logins and
    /// registrations it cost, how many times it offered a sign-up, where it
    /// stood when the typing stopped and what that screen said, and whether
    /// anyone was told to ask staff.</summary>
    public static IEnumerable<object[]> SignInSequences => new[]
    {
        new object[] { "new name, first try", new[] { "Alex", "1234", "1234" }, 1, 1, 1, "driving", "  RIG 01 - DRIVING: Alex", false },
        new object[] { "new name, confirm mismatch then match", new[] { "Alex", "1234", "1243", "1234" }, 1, 1, 2, "driving", "  RIG 01 - DRIVING: Alex", false },
        new object[] { "new name, two confirm mismatches", new[] { "Alex", "1234", "1243", "1244" }, 1, 0, 2, "name", "The two PINs did not match, so nothing was signed up; type your name to start again.", false },
        new object[] { "returning driver, right PIN", new[] { "Mike", "4321" }, 1, 0, 0, "driving", "  RIG 01 - DRIVING: Mike", false },
        new object[] { "returning driver, wrong then right (2026-09-28)", new[] { "Mike", "1234", "1234", "4321" }, 2, 1, 1, "driving", "  RIG 01 - DRIVING: Mike", true },
        new object[] { "returning driver, wrong once", new[] { "Mike", "1234", "1234" }, 1, 1, 1, "pin", MikeTaken, true },
        new object[] { "stranger typing a registered name", new[] { "Mike", "1234", "1234", "5678" }, 2, 1, 1, "name", MikeTwice, true },
        new object[] { "stranger declining the sign-up twice", new[] { "Mike", "1234", "", "5678", "" }, 2, 0, 2, "name", "No driver signed in as \"Mike\" with either PIN, and nothing was signed up. Type your name to start again.", false },
        new object[] { "declined once, then the name turns out taken", new[] { "Mike", "1234", "", "5678", "5678" }, 2, 1, 2, "name", MikeTwice, true },
        new object[] { "guest or banned name, no PIN logs in", new[] { "Guest", "4321", "4321", "4321" }, 2, 1, 1, "name", "The PIN for \"Guest\" did not match twice. If \"Guest\" is your name, ask staff to reset your PIN; if not, pick a different name.", true },
        new object[] { "Enter at the name", new[] { "" }, 0, 0, 0, "name", NameScreen, false },
        new object[] { "Enter at the first PIN", new[] { "Alex", "" }, 0, 0, 0, "pin", "The PIN is exactly 4 digits.", false },
        new object[] { "Enter at the sign-up offer", new[] { "Alex", "1234", "" }, 1, 0, 1, "pin", "Nothing was signed up - type your PIN again.", false },
        new object[] { "Enter at the re-asked confirm", new[] { "Alex", "1234", "1243", "" }, 1, 0, 2, "pin", "Nothing was signed up - type your PIN again.", false },
        new object[] { "Enter at the re-asked PIN", new[] { "Mike", "1234", "1234", "" }, 1, 1, 1, "name", NameScreen, true },
        new object[] { "Enter while driving", new[] { "Mike", "4321", "" }, 1, 0, 0, "name", "Thanks Mike, you are logged out.", false },
    };

    [Theory]
    [MemberData(nameof(SignInSequences))]
    public async Task EverySignInSequenceEndsWhereTheRulesSay(
        string sequence, string[] typed, int logins, int registers, int offers, string endsAt, string shown, bool staffMentioned)
    {
        var backend = new Backend();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);
        var screen = new RecordingConsole(typed);

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        var t = screen.Transcript;
        lock (backend.Calls)
        {
            Assert.True(logins == backend.Calls.Count(c => c.StartsWith("/api/auth/login ")), $"{sequence}: logins");
            Assert.True(registers == backend.Calls.Count(c => c.StartsWith("/api/auth/register ")), $"{sequence}: registrations");
        }
        Assert.True(offers == t.Count(l => l.StartsWith("New here?")), $"{sequence}: sign-up offers");
        Assert.True(staffMentioned == t.Any(l => l.Contains("ask staff")), $"{sequence}: ask staff");

        // Where the typing stopped. A driver is signed out as the input ends,
        // so their DRIVING screen is somewhere before the last one.
        var last = screen.ScreenBefore(t.Count);
        switch (endsAt)
        {
            case "driving":
                Assert.Contains(shown, t);
                break;
            case "name":
                Assert.Contains(shown, last);
                Assert.Contains(NameScreen, last);
                break;
            case "pin":
                Assert.Contains(shown, last);
                Assert.Contains(last, l => l.StartsWith("Type your 4-digit PIN"));
                break;
            default:
                throw new ArgumentException(endsAt);
        }
    }

    [Fact]
    public async Task OnlyTheConfirmedPinIsRegistered()
    {
        var backend = new Backend();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);
        var screen = new RecordingConsole("Chuy", "1234", "1243", "1234", "");

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        // The mismatch was asked again on the rig, and every full PIN left the
        // screen the moment Enter was pressed.
        var t = screen.Transcript;
        var reasked = screen.ScreenBefore(t.LastIndexOf("typed:1234"));
        Assert.Contains("The two PINs did not match. Type the PIN you picked once more.", reasked);
        Assert.Contains("Name: Chuy", reasked);
        Assert.Equal("<clear>", t[t.IndexOf("typed:1243") + 1]);
        Assert.Equal("<clear>", t[t.LastIndexOf("typed:1234") + 1]);
        Assert.Contains(t, l => l.StartsWith("You are signed up."));
        lock (backend.Calls) Assert.Single(backend.Calls, c => c.StartsWith("/api/auth/register ") && c.Contains("d-new"));
        lock (backend.RegisteredPins) Assert.Equal("1234", backend.RegisteredPins.Single());
    }

    /// <summary>Telemetry whose sim state the test flips, as iRacing does when
    /// a session loads or the driver exits to the menu.</summary>
    private sealed class SwitchableTelemetry : ITelemetrySource
    {
        public volatile bool Running;
        public bool SimRunning => Running;
        public event Action<LapCompleted>? LapCompleted;
        public void Start() { }
        public void Stop() { _ = LapCompleted; }
    }

    /// <summary>The first real rig showed "iRacing is not running" above laps
    /// that were being read and posted: the warning was drawn once, when the
    /// screen was, and nothing took it down. The screen now follows the agent's
    /// status - the warning goes the moment iRacing connects and comes back
    /// only when it actually disconnects - without losing a skipped lap's line
    /// or a lasting fault.</summary>
    [Fact]
    public async Task TheNotRunningWarningLeavesWhenIracingConnectsAndReturnsWhenItDisconnects()
    {
        const string noSim = "WARNING: iRacing is not running or not in a session - no laps are being read.";
        var backend = new Backend();
        var telemetry = new SwitchableTelemetry();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, telemetry);
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);

        const string fault = "ERROR: lap reading stopped: the map closed - tell staff to restart the program.";
        RecordingConsole screen = null!;
        WalkUpScreen walkUp = null!;
        List<string> LatestScreen() => screen.ScreenBefore(screen.Transcript.Count);
        async Task WaitForScreen(Func<List<string>, bool> ready, string what)
        {
            for (var i = 0; i < 100; i++)
            {
                if (ready(LatestScreen())) return;
                await Task.Delay(50);
            }
            Assert.Fail($"the screen never showed: {what}\n" + string.Join("\n", LatestScreen()));
        }

        var drivingWithWarning = new List<string>();
        var drivingConnected = new List<string>();
        var drivingDisconnected = new List<string>();
        screen = new RecordingConsole("Mike", "4321", "")
        {
            BeforeTyping = async line =>
            {
                if (line != "") return;
                // Signed in with the sim not running: the driving screen warns.
                await WaitForScreen(l => l.Contains("  RIG 01 - DRIVING: Mike"), "the driving screen");
                drivingWithWarning = LatestScreen();
                walkUp.Log("Lap 3 not counted: pit lane");
                walkUp.Standing(fault);

                // iRacing connects: the warning must leave without a key press,
                // and the driving screen stays.
                telemetry.Running = true;
                await WaitForScreen(l => l.Contains("  RIG 01 - DRIVING: Mike") && !l.Contains(noSim), "the driving screen without the warning");
                drivingConnected = LatestScreen();

                // iRacing exits to the menu: the warning returns.
                telemetry.Running = false;
                await WaitForScreen(l => l.Contains("  RIG 01 - DRIVING: Mike") && l.Contains(noSim), "the warning back");
                drivingDisconnected = LatestScreen();
            },
        };

        walkUp = new WalkUpScreen(screen, agent);
        await DriverPrompt.RunAsync(agent, checkIn, 1, walkUp, CancellationToken.None);

        Assert.Contains(noSim, drivingWithWarning);
        Assert.DoesNotContain(noSim, drivingConnected);
        Assert.Contains("Press Enter to log out.", drivingConnected);
        Assert.Contains(fault, drivingConnected);
        Assert.Contains(drivingConnected, l => l.EndsWith("Lap 3 not counted: pit lane"));
        Assert.Contains(fault, drivingDisconnected);
        Assert.Contains(drivingDisconnected, l => l.EndsWith("Lap 3 not counted: pit lane"));
        Assert.Contains(noSim, drivingDisconnected);
        Assert.Contains("Press Enter to log out.", drivingDisconnected);
    }

    /// <summary>A half-typed name must stay in view: the console still holds
    /// what was typed, so clearing the sign-in screen under it made the driver
    /// retype and sign in as "MiMike". A warning that starts applying while the
    /// sign-in screen is up is printed below the prompt instead.</summary>
    [Fact]
    public async Task ASignInScreenIsNotClearedUnderAHalfTypedName()
    {
        const string noSim = "WARNING: iRacing is not running or not in a session - no laps are being read.";
        var backend = new Backend();
        var telemetry = new SwitchableTelemetry { Running = true };
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, telemetry);
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);

        RecordingConsole screen = null!;
        screen = new RecordingConsole("Mike")
        {
            BeforeTyping = async _ =>
            {
                // iRacing leaves its session while the name is being typed.
                telemetry.Running = false;
                var deadline = DateTime.UtcNow.AddSeconds(10);
                while (!screen.Transcript.Contains(noSim))
                {
                    if (DateTime.UtcNow > deadline) throw new TimeoutException("the warning was never shown");
                    await Task.Delay(50);
                }
            },
        };

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        var t = screen.Transcript;
        var prompt = t.IndexOf("Type your name and press Enter:");
        var typed = t.IndexOf("typed:Mike");
        var whileTyping = t.GetRange(prompt + 1, typed - prompt - 1);
        Assert.DoesNotContain("<clear>", whileTyping);
        Assert.Contains(noSim, whileTyping);
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

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        var t = screen.Transcript;
        Assert.Contains(t, l => l.EndsWith("Lap 1  2:17.217  incidents 0 - lap not counted - sign in first"));
        Assert.DoesNotContain(t, l => l.Contains("Lap 1") && (l.EndsWith("- queued") || l.EndsWith("- posted")));
        var queuedAt = t.FindIndex(l => l.EndsWith("Lap 2  2:17.217  incidents 0 - queued"));
        var postedAt = t.FindIndex(l => l.EndsWith("Lap 2  2:17.217  incidents 0 - posted"));
        Assert.True(queuedAt >= 0 && postedAt > queuedAt, string.Join(" | ", t));
        Assert.DoesNotContain(t, l => l.StartsWith("WARNING: iRacing"));
    }

    /// <summary>A lap the backend refuses brings up a warning, which redraws
    /// the driving screen; the line saying which lap and why is still on it
    /// afterwards, not erased by that redraw.</summary>
    [Fact]
    public async Task ARefusedLapsNoticeSurvivesTheRedrawItsWarningCauses()
    {
        const string refused = "WARNING: 1 lap(s) were refused by the backend - tell staff.";
        var backend = new Backend { RefuseLaps = true };
        var telemetry = new HandTelemetry();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, telemetry);
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);

        RecordingConsole screen = null!;
        var driving = new List<string>();
        screen = new RecordingConsole("Mike", "4321", "")
        {
            BeforeTyping = async line =>
            {
                if (line != "") return;
                telemetry.Emit("evt-refused", lapNumber: 4);
                var deadline = DateTime.UtcNow.AddSeconds(20);
                while (!(driving = screen.ScreenBefore(screen.Transcript.Count)).Contains(refused))
                {
                    if (DateTime.UtcNow > deadline) throw new TimeoutException("the refusal was never shown");
                    await Task.Delay(50);
                }
            },
        };
        var walkUp = new WalkUpScreen(screen, agent);
        agent.Notice += walkUp.Log;

        await DriverPrompt.RunAsync(agent, checkIn, 1, walkUp, CancellationToken.None);

        Assert.Contains("  RIG 01 - DRIVING: Mike", driving);
        Assert.Contains(driving, l => l.Contains("the backend will not accept lap evt-refused"));
    }

    /// <summary>Mike logs out while the backend cannot be told, then signs
    /// straight back in once it can, before any poll has delivered that
    /// sign-out. The sign-out lands first, so he gets a fresh stint and keeps
    /// it: the next poll does not end it under him and his laps still count.</summary>
    [Fact]
    public async Task SigningBackInWhileALogOutIsOwedGetsAFreshStintThatThePollKeeps()
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
        var presses = 0;
        string? seatedAfterPoll = null;
        screen = new RecordingConsole("Mike", "4321", "", "Mike", "4321", "")
        {
            BeforeTyping = async line =>
            {
                if (line == "Mike" && presses == 1) backend.CheckoutUnreachable = false;
                if (line != "") return;
                if (++presses == 1)
                {
                    backend.CheckoutUnreachable = true;
                    return;
                }
                var polls = Volatile.Read(ref backend.AssignmentPolls);
                var deadline = DateTime.UtcNow.AddSeconds(20);
                while (Volatile.Read(ref backend.AssignmentPolls) == polls)
                {
                    if (DateTime.UtcNow > deadline) throw new TimeoutException("no assignment poll");
                    await Task.Delay(50);
                }
                await Task.Delay(300);
                seatedAfterPoll = agent.CurrentStatus().Assignment?.Id;
                telemetry.Emit("evt-mike-again", lapNumber: 5);
                while (!screen.Transcript.Any(l => l.Contains("Lap 5")))
                {
                    if (DateTime.UtcNow > deadline) throw new TimeoutException("lap 5 was never shown");
                    await Task.Delay(50);
                }
            },
        };

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        var t = screen.Transcript;
        Assert.Contains("Thanks Mike, logged out here; the backend will be told when the connection returns.", t);

        List<string> calls;
        lock (backend.Calls) calls = backend.Calls.ToList();
        var checkIns = calls.Where(c => c.StartsWith("/api/checkin ")).ToList();
        Assert.Equal(2, checkIns.Count);
        Assert.Contains("\"checked_in\"", checkIns[1]);
        var owedDelivered = calls.IndexOf($"/api/agent/checkout {{\"ended\":true}}");
        Assert.True(owedDelivered >= 0 && owedDelivered < calls.IndexOf(checkIns[1]), string.Join(" | ", calls));

        Assert.NotNull(seatedAfterPoll);
        Assert.NotEqual(MikeAssignmentId, seatedAfterPoll);
        Assert.Contains(t, l => l.EndsWith("Lap 5  2:17.217  incidents 0 - queued"));
        Assert.DoesNotContain(t, l => l.Contains("Lap 5") && l.Contains("not counted"));
    }

    [Fact]
    public async Task ClosingTheProgramSignsOutOnlyADriverStillSeated()
    {
        var backend = new Backend();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 2, RigQrToken = "qr-rig-2" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-2", () => backend);

        // Mike logs out, then the window is closed from the sign-in screen. A
        // stint opened on the rig since (staff, a phone) must survive the close.
        await DriverPrompt.RunAsync(agent, checkIn, 2, new WalkUpScreen(new RecordingConsole("Mike", "4321", ""), agent), CancellationToken.None);
        await CheckInAsync(checkIn, "Mike", "4321");
        await DriverPrompt.SignOutOnExitAsync(agent);
        lock (backend.Checkouts) Assert.Equal(new string?[] { null, MikeAssignmentId }, backend.Checkouts);

        // Closed while driving: the seated driver's own stint is ended, by name.
        var seated = await CheckInAsync(checkIn, "Mike", "4321");
        agent.SeatCheckedInDriver(seated);
        await DriverPrompt.SignOutOnExitAsync(agent);
        lock (backend.Checkouts) Assert.Equal(new string?[] { null, MikeAssignmentId, seated.AssignmentId }, backend.Checkouts);
    }

    [Fact]
    public async Task ASignalSignOutThenTheCancelledPromptNeverClosesANewerStint()
    {
        // Window closed while Mike drives: the signal handler signs him out and
        // cancels the prompt, and before the prompt loop resumes, staff or a
        // phone opens a new stint on the rig. The loop's own sign-out must not
        // send the unnamed checkout that would close it.
        var backend = new Backend();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 2, RigQrToken = "qr-rig-2" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-2", () => backend);
        string? newer = null;
        var screen = new RecordingConsole("Mike", "4321")
        {
            OnInputEnded = async () =>
            {
                await DriverPrompt.SignOutOnExitAsync(agent);
                newer = (await CheckInAsync(checkIn, "Mike", "4321")).AssignmentId;
            },
        };

        await DriverPrompt.RunAsync(agent, checkIn, 2, new WalkUpScreen(screen, agent), CancellationToken.None);

        Assert.NotNull(newer);
        Assert.NotEqual(MikeAssignmentId, newer);
        lock (backend.Checkouts) Assert.Equal(new string?[] { null, MikeAssignmentId }, backend.Checkouts);
        // The newer stint is still the one open: checking in again rejoins it.
        Assert.Equal(newer, (await CheckInAsync(checkIn, "Mike", "4321")).AssignmentId);
    }

    public void Dispose()
    {
        foreach (var file in Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(_dbPath) + "*"))
            File.Delete(file);
    }
}
