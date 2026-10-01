using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The window's model against the real agent and the same fake backend the
/// console tests use: the seat is emptied on start, a sign-in seats the driver
/// and the next lap is theirs, a log-out ends the stint and thanks them, and
/// every screen carries the warnings standing at that moment. The window itself
/// only draws <see cref="WalkUpViewModel.Snapshot"/>, so this is the sign-in
/// window's behaviour as far as a Mac can run it.
/// </summary>
public sealed class WalkUpViewModelTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-vm-{Guid.NewGuid():N}.db");

    private sealed class HandTelemetry : ITelemetrySource
    {
        public volatile bool Running;
        public bool SimRunning => Running;
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

    private sealed class Rig : IAsyncDisposable
    {
        public readonly WalkUpBackend Backend = new();
        public readonly HandTelemetry Telemetry = new();
        public readonly EventQueue Queue;
        public readonly HttpClient Http;
        public readonly AgentService Agent;
        public readonly WalkUpViewModel Model;
        public int Changes;

        public Rig(string dbPath)
        {
            Queue = new EventQueue(dbPath);
            Http = new HttpClient(Backend);
            var config = new AgentConfig { BackendBaseUrl = "https://rig.test", RigToken = "t", RigNumber = 2, RigQrToken = "qr-rig-2" };
            Agent = new AgentService(config, new BackendClient(Http, config.BackendBaseUrl, "t"), Queue, Telemetry);
            Model = new WalkUpViewModel(Agent, new DriverCheckInClient(config.BackendBaseUrl, "qr-rig-2", () => Backend), 2);
            Model.Changed += () => Interlocked.Increment(ref Changes);
            Agent.Start();
        }

        public async Task<WalkUpView> SignInMikeAsync()
        {
            await Model.StartAsync(CancellationToken.None);
            await Model.ChooseReturningAsync(true);
            await Model.SubmitAsync("Mike");
            await Model.SubmitAsync("4321");
            return Model.Snapshot();
        }

        public async ValueTask DisposeAsync()
        {
            Model.Dispose();
            await Agent.DisposeAsync();
            Http.Dispose();
            Queue.Dispose();
        }
    }

    private static async Task WaitUntil(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException(what);
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task StartsBusyThenEmptiesTheSeatAndAsksRacedHereBefore()
    {
        await using var rig = new Rig(_dbPath);
        var before = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.Busy, before.Stage);
        Assert.Equal("Connecting to Oasis Race Control...", before.BusyText);
        Assert.Equal(2, before.RigNumber);

        await rig.Model.StartAsync(CancellationToken.None);

        var view = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.SignIn, view.Stage);
        Assert.Equal(SignInStep.AskRacedBefore, view.Step);
        Assert.Null(view.Notice);
        lock (rig.Backend.Checkouts) Assert.Equal(new string?[] { null }, rig.Backend.Checkouts);
        Assert.Contains("WARNING: iRacing is not running or not in a session - no laps are being read.", view.Warnings);
        Assert.True(rig.Changes > 0);
    }

    [Fact]
    public async Task AReturningDriverSignsInAndTheirLapsQueueThenPostUnderTheirName()
    {
        await using var rig = new Rig(_dbPath);
        rig.Telemetry.Running = true;
        await rig.Model.StartAsync(CancellationToken.None);
        // A lap before anyone signs in is nobody's and says so.
        rig.Telemetry.Emit("evt-nobody", 1);
        await WaitUntil(() => rig.Model.Snapshot().Recent.Any(l => l.Contains("Lap 1")), "the unclaimed lap is logged");

        await rig.Model.ChooseReturningAsync(true);
        Assert.Equal((WalkUpStage.SignIn, SignInStep.AskName, true), Pick(rig.Model.Snapshot()));
        await rig.Model.SubmitAsync("Mike");
        Assert.Equal((WalkUpStage.SignIn, SignInStep.AskPin, true), Pick(rig.Model.Snapshot()));
        Assert.Equal("Mike", rig.Model.Snapshot().Name);
        await rig.Model.SubmitAsync("4321");

        var driving = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.Driving, driving.Stage);
        Assert.Equal("Mike", driving.Driver?.DisplayName);
        Assert.True(driving.Driver?.Returning);
        Assert.Empty(driving.Laps);
        Assert.DoesNotContain(driving.Warnings, w => w.Contains("iRacing is not running"));
        Assert.Equal("Mike", rig.Agent.CurrentStatus().Assignment?.DriverDisplayName);

        rig.Telemetry.Emit("evt-mike", 2);
        await WaitUntil(() => rig.Model.Snapshot().Laps.Any(l => l.State == LapRowState.Posted), "Mike's lap posts");
        var lap = Assert.Single(rig.Model.Snapshot().Laps);
        Assert.Equal((2, 137_217, WalkUpBackend.MikeAssignmentId), (lap.LapNumber, lap.LapTimeMs, lap.Stamp));
        var recent = rig.Model.Snapshot().Recent;
        Assert.Contains(recent, l => l.EndsWith("Lap 1  2:17.217  incidents 0 - lap not counted - sign in first"));
        Assert.Contains(recent, l => l.EndsWith("Lap 2  2:17.217  incidents 0 - queued"));
        Assert.Contains(recent, l => l.EndsWith("Lap 2  2:17.217  incidents 0 - posted"));

        static (WalkUpStage, SignInStep, bool) Pick(WalkUpView v) => (v.Stage, v.Step, v.Returning);
    }

    [Fact]
    public async Task AWrongPinStaysOnSignInWithTheReasonAndTheNameKept()
    {
        await using var rig = new Rig(_dbPath);
        await rig.Model.StartAsync(CancellationToken.None);
        await rig.Model.ChooseReturningAsync(true);
        await rig.Model.SubmitAsync("Mike");
        await rig.Model.SubmitAsync("1234");

        var view = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.SignIn, view.Stage);
        Assert.Equal(SignInStep.AskPin, view.Step);
        Assert.Equal("Mike", view.Name);
        Assert.Equal("That PIN does not match \"Mike\". Type it again.", view.Notice);
        Assert.Null(view.Driver);
        Assert.Null(rig.Agent.CurrentStatus().Assignment);
    }

    [Fact]
    public async Task ANewDriverTypesThePinTwiceAndOnlyTheConfirmedOneIsRegistered()
    {
        await using var rig = new Rig(_dbPath);
        await rig.Model.StartAsync(CancellationToken.None);
        await rig.Model.ChooseReturningAsync(false);
        await rig.Model.SubmitAsync("Alex");
        await rig.Model.SubmitAsync("1234");
        Assert.Equal(SignInStep.AskNewPinAgain, rig.Model.Snapshot().Step);
        await rig.Model.SubmitAsync("1243");
        Assert.Equal(SignInStep.AskNewPin, rig.Model.Snapshot().Step);
        Assert.Equal("The two PINs did not match, so nothing was signed up. Pick a PIN and type it twice.", rig.Model.Snapshot().Notice);
        await rig.Model.SubmitAsync("5678");
        await rig.Model.SubmitAsync("5678");

        var view = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.Driving, view.Stage);
        Assert.Equal("Alex", view.Driver?.DisplayName);
        Assert.False(view.Driver?.Returning);
        lock (rig.Backend.RegisteredPins) Assert.Equal(["5678"], rig.Backend.RegisteredPins);
    }

    [Fact]
    public async Task ATakenNameIsExplainedInTheWindowsOwnButtons()
    {
        await using var rig = new Rig(_dbPath);
        await rig.Model.StartAsync(CancellationToken.None);
        await rig.Model.ChooseReturningAsync(false);
        await rig.Model.SubmitAsync("Mike");
        await rig.Model.SubmitAsync("1234");
        await rig.Model.SubmitAsync("1234");

        var view = rig.Model.Snapshot();
        Assert.Equal(SignInStep.AskName, view.Step);
        Assert.Equal("The name \"Mike\" is already registered. If it is yours, press Back and choose \"Yes, I have raced here\"; otherwise type a different name.", view.Notice);

        await rig.Model.BackAsync();
        await rig.Model.ChooseReturningAsync(true);
        await rig.Model.SubmitAsync("Mike");
        await rig.Model.SubmitAsync("4321");
        Assert.Equal("Mike", rig.Model.Snapshot().Driver?.DisplayName);
    }

    [Fact]
    public async Task LogOutEndsTheStintAndReturnsToSignInWithThanks()
    {
        await using var rig = new Rig(_dbPath);
        await rig.SignInMikeAsync();

        await rig.Model.LogOutAsync();

        var view = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.SignIn, view.Stage);
        Assert.Equal(SignInStep.AskRacedBefore, view.Step);
        Assert.Equal("Thanks Mike, you are logged out.", view.Notice);
        Assert.Null(view.Driver);
        Assert.Empty(view.Laps);
        lock (rig.Backend.Checkouts) Assert.Equal(new string?[] { null, WalkUpBackend.MikeAssignmentId }, rig.Backend.Checkouts);
        Assert.Null(rig.Agent.CurrentStatus().Assignment);
    }

    [Fact]
    public async Task LogOutWithTheBackendDownStillEndsTheStintHereAndSaysWhatIsOwed()
    {
        await using var rig = new Rig(_dbPath);
        await rig.SignInMikeAsync();
        rig.Backend.CheckoutUnreachable = true;

        await rig.Model.LogOutAsync();

        var view = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.SignIn, view.Stage);
        Assert.Equal("Thanks Mike, logged out here; the backend will be told when the connection returns.", view.Notice);
        Assert.Null(rig.Agent.CurrentStatus().Assignment);
    }

    [Fact]
    public async Task InputIsIgnoredWhileDrivingAndLogOutWhileSigningIn()
    {
        await using var rig = new Rig(_dbPath);
        await rig.Model.StartAsync(CancellationToken.None);
        await rig.Model.LogOutAsync();
        Assert.Equal(WalkUpStage.SignIn, rig.Model.Snapshot().Stage);

        await rig.SignInMikeAsync();
        await rig.Model.SubmitAsync("");
        await rig.Model.ChooseReturningAsync(false);
        var view = rig.Model.Snapshot();
        Assert.Equal(WalkUpStage.Driving, view.Stage);
        Assert.Equal("Mike", view.Driver?.DisplayName);
    }

    [Fact]
    public async Task StandingWarningsStayOnEveryScreenAndNoticesAreLogged()
    {
        await using var rig = new Rig(_dbPath);
        await rig.Model.StartAsync(CancellationToken.None);
        rig.Model.Standing("ERROR: lap reading stopped: boom - tell staff to restart the program.");
        rig.Model.Standing("ERROR: lap reading stopped: boom - tell staff to restart the program.");
        rig.Model.Log("iRacing connected.");

        var signIn = rig.Model.Snapshot();
        Assert.Single(signIn.Warnings, w => w.StartsWith("ERROR: lap reading stopped"));
        Assert.Contains(signIn.Recent, l => l.EndsWith("] iRacing connected."));

        await rig.SignInMikeAsync();
        Assert.Contains(rig.Model.Snapshot().Warnings, w => w.StartsWith("ERROR: lap reading stopped"));
    }

    public void Dispose()
    {
        foreach (var file in Directory.GetFiles(Path.GetDirectoryName(_dbPath)!, Path.GetFileName(_dbPath) + "*"))
            File.Delete(file);
    }
}
