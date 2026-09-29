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
        var screen = new RecordingConsole("y", "Mike", "12", "1234", "4321", "");

        await DriverPrompt.RunAsync(agent, checkIn, 2, new WalkUpScreen(screen, agent), CancellationToken.None);

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

        // A wrong PIN says so plainly and asks for it again, the name kept.
        var refusedScreen = screen.ScreenBefore(t.IndexOf("typed:4321"));
        Assert.Contains("  OASIS RACE CONTROL - RIG 02 - SIGN IN", refusedScreen);
        Assert.Contains("That PIN does not match \"Mike\". Type it again.", refusedScreen);
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


    private const string RacedBefore = "Raced here before? Type y or n and press Enter:";
    private const string ReturningName = "Type the name you raced under and press Enter (Enter alone goes back):";
    private const string NewName = "Type a name for the leaderboard and press Enter (Enter alone goes back):";
    private const string AskPin = "Type your 4-digit PIN and press Enter (Enter alone goes back to the name):";
    private const string NewPin = "Pick a 4-digit PIN, remember it, and press Enter (Enter alone goes back to the name):";
    private const string NewPinAgain = "Type the same PIN again and press Enter (Enter alone goes back):";
    private const string PinRefused = "That PIN does not match. Ask staff to reset your PIN, or press Enter to try a different name.";
    private const string PinsDiffer = "The two PINs did not match, so nothing was signed up. Pick a PIN and type it twice.";

    /// <summary>Every sign-in sequence, typed line by line: how many logins and
    /// registrations it cost, where it stood when the typing stopped (a prompt,
    /// or "driving" for a driver signed in), and a line that screen showed.
    /// Mike's PIN is 4321; "Guest" is taken but no PIN logs it in; any other
    /// name is free.</summary>
    public static IEnumerable<object[]> SignInSequences => new[]
    {
        new object[] { "returning driver, right PIN", new[] { "y", "Mike", "4321" }, 1, 0, "driving", "  RIG 01 - DRIVING: Mike" },
        new object[] { "returning driver, wrong then right (2026-09-28)", new[] { "y", "Mike", "1234", "4321" }, 2, 0, "driving", "  RIG 01 - DRIVING: Mike" },
        new object[] { "returning driver, wrong once", new[] { "y", "Mike", "1234" }, 1, 0, AskPin, "That PIN does not match \"Mike\". Type it again." },
        new object[] { "returning driver, wrong twice", new[] { "y", "Mike", "1234", "5678" }, 2, 0, PinRefused, "Name: Mike" },
        new object[] { "stranger typing a registered name stops at two logins", new[] { "y", "Mike", "1234", "5678", "9999" }, 2, 0, ReturningName, ReturningName },
        // Typing the name again, in any case, gets no fresh tries: the PINs
        // after it are answered on the rig and never reach the backend, whose
        // lockout comes at five.
        new object[] { "stranger typing the name again gets no more logins", new[] { "y", "Mike", "1234", "5678", "", "Mike", "1111", "mike", "2222" }, 2, 0, ReturningName, ReturningName },
        // Nor does a spelling the backend's citext reads as the same driver
        // (İ and the Kelvin sign K lower to i and k in a UTF-8 locale).
        new object[] { "stranger typing a look-alike spelling gets no more logins", new[] { "y", "Mike", "1234", "5678", "", "M\u0130ke", "1111", "Mi\u212Ae", "2222", "M\u0130\u212Ae", "3333" }, 2, 0, ReturningName, ReturningName },
        new object[] { "a used-up name leaves another name its own two", new[] { "y", "Mike", "1234", "5678", "", "Guest", "1234", "5678" }, 4, 0, PinRefused, "Name: Guest" },
        new object[] { "guest or banned name, no PIN logs in", new[] { "y", "Guest", "4321", "4321" }, 2, 0, PinRefused, "Name: Guest" },
        new object[] { "not 4 digits, never sent", new[] { "y", "Mike", "12" }, 0, 0, AskPin, "The PIN is exactly 4 digits." },
        new object[] { "new driver, PIN typed the same twice", new[] { "n", "Alex", "1234", "1234" }, 0, 1, "driving", "  RIG 01 - DRIVING: Alex" },
        new object[] { "new driver, PINs differ then match", new[] { "n", "Alex", "1234", "1243", "5678", "5678" }, 0, 1, "driving", "  RIG 01 - DRIVING: Alex" },
        new object[] { "new driver, PINs differ", new[] { "n", "Alex", "1234", "1243" }, 0, 0, NewPin, PinsDiffer },
        new object[] { "new driver, PINs differ twice", new[] { "n", "Alex", "1234", "1243", "1234", "1244" }, 0, 0, NewPin, PinsDiffer },
        new object[] { "new driver, name taken", new[] { "n", "Mike", "1234", "1234" }, 0, 1, NewName, "The name \"Mike\" is already registered. If it is yours, press Enter and answer y to \"Raced here before?\"; otherwise type a different name." },
        new object[] { "new driver, name taken, then returning with the right PIN", new[] { "n", "Mike", "1234", "1234", "", "y", "Mike", "4321" }, 1, 1, "driving", "  RIG 01 - DRIVING: Mike" },
        new object[] { "neither y nor n", new[] { "maybe" }, 0, 0, RacedBefore, "Type y if you have raced here before, or n if you are new." },
        new object[] { "Enter at raced here before", new[] { "" }, 0, 0, RacedBefore, RacedBefore },
        new object[] { "Enter at the returning name", new[] { "y", "" }, 0, 0, RacedBefore, RacedBefore },
        new object[] { "Enter at the new name", new[] { "n", "" }, 0, 0, RacedBefore, RacedBefore },
        new object[] { "Enter at the PIN", new[] { "y", "Mike", "" }, 0, 0, ReturningName, ReturningName },
        new object[] { "Enter at the re-asked PIN", new[] { "y", "Mike", "1234", "" }, 1, 0, ReturningName, ReturningName },
        new object[] { "Enter at the PIN refusal", new[] { "y", "Mike", "1234", "5678", "" }, 2, 0, ReturningName, ReturningName },
        new object[] { "Enter at the new PIN", new[] { "n", "Alex", "" }, 0, 0, NewName, NewName },
        new object[] { "Enter at the new PIN again", new[] { "n", "Alex", "1234", "" }, 0, 0, NewPin, "Name: Alex" },
        new object[] { "Enter while driving", new[] { "y", "Mike", "4321", "" }, 1, 0, RacedBefore, "Thanks Mike, you are logged out." },
    };

    [Theory]
    [MemberData(nameof(SignInSequences))]
    public async Task EverySignInSequenceEndsWhereTheRulesSay(
        string sequence, string[] typed, int logins, int registers, string endsAt, string shown)
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

        // A driver is signed out as the input ends, so their DRIVING screen is
        // somewhere before the last one; otherwise the last screen is the
        // prompt the typing stopped at.
        if (endsAt == "driving")
        {
            Assert.Contains(shown, t);
            return;
        }
        var last = screen.ScreenBefore(t.Count);
        Assert.True(last.Contains(endsAt), $"{sequence}: ends at {endsAt}\n{string.Join("\n", last)}");
        Assert.True(last.Contains(shown), $"{sequence}: shows {shown}\n{string.Join("\n", last)}");
    }

    [Fact]
    public async Task ANewDriverWhoseCheckInFailsAfterSigningUpRetriesAsReturning()
    {
        var backend = new Backend { FailNextCheckIn = true };
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);
        var screen = new RecordingConsole("n", "Alex", "1234", "1234", "Alex", "1234");

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        // The sign-up stood, so the retry is a returning driver's: the name
        // and the PIN once, logged in, never "that name is already registered".
        var t = screen.Transcript;
        var retry = screen.ScreenBefore(t.LastIndexOf("typed:Alex"));
        Assert.Contains(retry, l => l.StartsWith("You are signed up as \"Alex\", but could not be checked in: someone else checked in at the same moment"));
        Assert.Contains(ReturningName, retry);
        Assert.Contains(AskPin, screen.ScreenBefore(t.LastIndexOf("typed:1234")));
        Assert.Contains("  RIG 01 - DRIVING: Alex", t);
        Assert.DoesNotContain(t, l => l.Contains("already registered"));
        lock (backend.Calls)
        {
            Assert.Single(backend.Calls, c => c.StartsWith("/api/auth/register "));
            Assert.Single(backend.Calls, c => c.StartsWith("/api/auth/login "));
        }
    }

    [Fact]
    public async Task ANewDriversPinsAreComparedOnTheRigAndOnlyTheConfirmedOneIsRegistered()
    {
        var backend = new Backend();
        using var queue = new EventQueue(_dbPath);
        using var http = new HttpClient(backend);
        var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 1, RigQrToken = "qr-rig-1" };
        await using var agent = new AgentService(config, new BackendClient(http, config.BackendBaseUrl, "t"), queue, new NullTelemetrySource());
        agent.Start();
        var checkIn = new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-1", () => backend);
        var screen = new RecordingConsole("n", "Chuy", "1234", "1243", "5678", "5678", "");

        await DriverPrompt.RunAsync(agent, checkIn, 1, new WalkUpScreen(screen, agent), CancellationToken.None);

        // Every PIN left the screen the moment Enter was pressed.
        var t = screen.Transcript;
        foreach (var pin in new[] { "1234", "1243", "5678" })
            Assert.Equal("<clear>", t[t.IndexOf($"typed:{pin}") + 1]);
        Assert.Equal("<clear>", t[t.LastIndexOf("typed:5678") + 1]);
        Assert.Contains(t, l => l.StartsWith("You are signed up."));
        lock (backend.RegisteredPins) Assert.Equal(new[] { "5678" }, backend.RegisteredPins);
        lock (backend.Calls) Assert.DoesNotContain(backend.Calls, c => c.StartsWith("/api/auth/login "));
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
        screen = new RecordingConsole("y", "Mike", "4321", "")
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
        screen = new RecordingConsole("y", "Mike")
        {
            BeforeTyping = async line =>
            {
                if (line != "Mike") return;
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
        var prompt = t.IndexOf("Type the name you raced under and press Enter (Enter alone goes back):");
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
        screen = new RecordingConsole("y", "Mike", "4321", "")
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
        screen = new RecordingConsole("y", "Mike", "4321", "")
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
        screen = new RecordingConsole("y", "Mike", "4321", "", "y", "Mike", "4321", "")
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
        await DriverPrompt.RunAsync(agent, checkIn, 2, new WalkUpScreen(new RecordingConsole("y", "Mike", "4321", ""), agent), CancellationToken.None);
        await MikeChecksIn(checkIn);
        await DriverPrompt.SignOutOnExitAsync(agent);
        lock (backend.Checkouts) Assert.Equal(new string?[] { null, MikeAssignmentId }, backend.Checkouts);

        // Closed while driving: the seated driver's own stint is ended, by name.
        var seated = await MikeChecksIn(checkIn);
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
        var screen = new RecordingConsole("y", "Mike", "4321")
        {
            OnInputEnded = async () =>
            {
                await DriverPrompt.SignOutOnExitAsync(agent);
                newer = (await MikeChecksIn(checkIn)).AssignmentId;
            },
        };

        await DriverPrompt.RunAsync(agent, checkIn, 2, new WalkUpScreen(screen, agent), CancellationToken.None);

        Assert.NotNull(newer);
        Assert.NotEqual(MikeAssignmentId, newer);
        lock (backend.Checkouts) Assert.Equal(new string?[] { null, MikeAssignmentId }, backend.Checkouts);
        // The newer stint is still the one open: checking in again rejoins it.
        Assert.Equal(newer, (await MikeChecksIn(checkIn)).AssignmentId);
    }

    /// <summary>Mike checks in on the rig from elsewhere (staff, a phone).</summary>
    private static async Task<DriverCheckIn> MikeChecksIn(DriverCheckInClient checkIn) =>
        await checkIn.CheckInReturningAsync("Mike", "4321", CancellationToken.None)
            ?? throw new InvalidOperationException("Mike's PIN is 4321");

    public void Dispose()
    {
        foreach (var file in Directory.GetFiles(Path.GetTempPath(), Path.GetFileName(_dbPath) + "*"))
            File.Delete(file);
    }
}
