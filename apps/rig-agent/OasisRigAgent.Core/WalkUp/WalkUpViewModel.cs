namespace OasisRigAgent.Core.WalkUp;

/// <summary>Which of the window's screens is up.</summary>
public enum WalkUpStage
{
    /// <summary>The sign-in prompts, at <see cref="WalkUpView.Step"/>.</summary>
    SignIn,
    /// <summary>Waiting on the backend: starting up, signing in, logging out.
    /// <see cref="WalkUpView.BusyText"/> says which.</summary>
    Busy,
    /// <summary>A driver is seated: <see cref="WalkUpView.Driver"/>.</summary>
    Driving,
}

/// <summary>Everything the window draws, as one immutable snapshot.</summary>
public sealed record WalkUpView(
    int RigNumber,
    WalkUpStage Stage,
    SignInStep Step,
    bool Returning,
    string Name,
    string? Notice,
    string? BusyText,
    DriverCheckIn? Driver,
    IReadOnlyList<LapRow> Laps,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<string> Recent);

/// <summary>
/// The walk-up screens as state the window renders, with no window in it: the
/// sign-in flow (<see cref="SignInFlow"/>), the seated driver and their laps
/// (<see cref="LapBoard"/>), the warnings standing right now
/// (<see cref="WalkUpRules.Warnings"/>) and the last few lines the console would
/// have printed. Commands come from the UI thread; the agent's events arrive on
/// its own loops; every change raises <see cref="Changed"/> on whichever thread
/// made it, and the view reads <see cref="Snapshot"/> under its own
/// marshalling. Nothing here waits on the UI, so the agent's loops are never
/// slowed by it.
///
/// Sign-in and sign-out are the console's exact moves: a check-in through
/// <see cref="SignInAttempt"/> then <see cref="AgentService.SeatCheckedInDriver"/>,
/// a log-out through <see cref="AgentService.SwitchDriverAsync"/>, the seat
/// emptied on start by <see cref="WalkUpRules.EmptySeatAsync"/>, and the
/// close-time sign-out through <see cref="SignOutOnExitAsync"/>, which the
/// host calls from every way the window can close.
/// </summary>
public sealed class WalkUpViewModel : IDisposable
{
    private const int KeptRecentLines = 8;

    private readonly AgentService _agent;
    private readonly DriverCheckInClient _checkIn;
    private readonly int _rigNumber;
    private readonly object _lock = new();
    private readonly LapBoard _laps = new();
    private readonly List<string> _standing = new();
    private readonly List<string> _recent = new();
    private SignInFlow _flow = new(front: SignInFront.Window);
    private DriverCheckIn? _driver;
    private string? _busyText = "Connecting to Oasis Race Control...";
    private CancellationToken _quit;
    // The sign-in attempt in flight, so closing can wait for it; and the token
    // that aborts it once closing has waited long enough.
    private Task? _inFlight;
    private CancellationTokenSource _attempts = new();
    private bool _closing;

    public WalkUpViewModel(AgentService agent, DriverCheckInClient checkIn, int rigNumber)
    {
        _agent = agent;
        _checkIn = checkIn;
        _rigNumber = rigNumber;
        _agent.StatusChanged += OnStatus;
        _agent.LapQueued += OnLapQueued;
        _agent.LapsPosted += OnLapsPosted;
        _agent.Notice += Log;
    }

    /// <summary>Something to draw changed. Raised on the thread that changed
    /// it, which is rarely the UI's.</summary>
    public event Action? Changed;

    /// <summary>Empty the seat, then show the first sign-in prompt.</summary>
    public async Task StartAsync(CancellationToken quit)
    {
        _quit = quit;
        _attempts = CancellationTokenSource.CreateLinkedTokenSource(quit);
        var notice = await WalkUpRules.EmptySeatAsync(_agent, quit).ConfigureAwait(false);
        lock (_lock)
        {
            _flow = new SignInFlow(notice, SignInFront.Window);
            _busyText = _closing ? ClosingText : null;
        }
        RaiseChanged();
    }

    /// <summary>The returning (y) or new (n) answer from the two buttons.</summary>
    public Task ChooseReturningAsync(bool returning) => SubmitAsync(returning ? "y" : "n");

    /// <summary>Empty input: back one step.</summary>
    public Task BackAsync() => SubmitAsync("");

    /// <summary>What the driver typed at the current prompt. When it completes
    /// the sign-in's input, the backend is asked and the driver seated; the
    /// task ends once the flow is waiting on the driver again (or seated).
    /// Ignored while a call is in flight or a driver is seated.</summary>
    public async Task SubmitAsync(string typed)
    {
        SignInRequest? request;
        var attempt = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_lock)
        {
            if (_busyText is not null || _driver is not null || _closing) return;
            _flow.Submit(typed);
            request = _flow.Pending;
            if (request is not null)
            {
                _busyText = request.Returning ? $"Signing in {request.Name}..." : $"Signing up {request.Name}...";
                _inFlight = attempt.Task;
            }
        }
        RaiseChanged();
        if (request is null) return;

        try
        {
            var token = _attempts.Token;
            var result = await Task.Run(() => SignInAttempt.PerformAsync(_agent, _checkIn, request, token)).ConfigureAwait(false);
            DriverCheckIn? seated = null;
            lock (_lock)
            {
                _flow.Apply(result);
                _busyText = _closing ? ClosingText : null;
                if (_flow.Step == SignInStep.SignedIn) seated = _driver = _flow.Driver;
            }
            // Seated even while closing: the exit sign-out below is what ends
            // it, by its id, and it must find the stint to do so.
            if (seated is not null) _agent.SeatCheckedInDriver(seated);
        }
        finally
        {
            lock (_lock)
            {
                if (_inFlight == attempt.Task) _inFlight = null;
            }
            attempt.SetResult();
        }
        RaiseChanged();
    }

    private const string ClosingText = "Signing out...";

    /// <summary>The program is closing: sign the seated driver out, durably,
    /// within <paramref name="limit"/>. A sign-in still in flight is waited
    /// for first, out of the same bound, because its check-in may already have
    /// opened a stint on the backend that only its answer names; when the
    /// answer arrives in time the driver is seated and that stint is ended by
    /// id through the same durable checkout the Log out button uses. When it
    /// does not, nothing here can name the stint, so a durable
    /// <see cref="AgentService.UnknownStint"/> checkout is recorded for the
    /// next start to settle and the attempt is abandoned. From the first call
    /// the window shows "Signing out..." and takes no more input.</summary>
    public async Task SignOutOnExitAsync(TimeSpan limit)
    {
        Task? inFlight;
        lock (_lock)
        {
            _closing = true;
            _busyText = ClosingText;
            inFlight = _inFlight;
        }
        RaiseChanged();

        var started = System.Diagnostics.Stopwatch.StartNew();
        if (inFlight is not null)
        {
            var finished = await Task.WhenAny(inFlight, Task.Delay(limit)).ConfigureAwait(false) == inFlight;
            if (!finished)
            {
                // Transport-ambiguous: the request may have been committed and
                // its answer lost. Record first, abort second, so a crash
                // between the two still leaves the record.
                _agent.RecordAbandonedSignIn();
                _attempts.Cancel();
                return;
            }
        }
        await WalkUpRules.SignOutOnExitAsync(_agent, limit - started.Elapsed).ConfigureAwait(false);
    }

    /// <summary>The Log out button: end the stint here at once, tell the
    /// backend (now or when it can be reached), and go back to sign-in with a
    /// thank-you naming what the backend has been told.</summary>
    public async Task LogOutAsync()
    {
        DriverCheckIn driver;
        lock (_lock)
        {
            if (_driver is null || _busyText is not null || _closing) return;
            driver = _driver;
            _busyText = $"Logging out {driver.DisplayName}...";
        }
        RaiseChanged();
        var result = await _agent.SwitchDriverAsync().ConfigureAwait(false);
        lock (_lock)
        {
            _driver = null;
            _busyText = _closing ? ClosingText : null;
            _flow = new SignInFlow(WalkUpRules.LoggedOut(driver.DisplayName, result), SignInFront.Window);
        }
        RaiseChanged();
    }

    /// <summary>A problem that stands until the program is restarted - lap
    /// reading stopped, an iRacing build missing what laps are read from - shown
    /// with the warnings from now on.</summary>
    public void Standing(string warning)
    {
        lock (_lock)
        {
            if (_standing.Contains(warning)) return;
            _standing.Add(warning);
        }
        RaiseChanged();
    }

    /// <summary>A line the console would have printed: shown as the most recent
    /// few, timestamped.</summary>
    public void Log(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {message}";
        lock (_lock)
        {
            _recent.Add(line);
            if (_recent.Count > KeptRecentLines) _recent.RemoveAt(0);
        }
        RaiseChanged();
    }

    public WalkUpView Snapshot()
    {
        var status = _agent.CurrentStatus();
        lock (_lock)
        {
            return new WalkUpView(
                _rigNumber,
                _busyText is not null ? WalkUpStage.Busy : _driver is not null ? WalkUpStage.Driving : WalkUpStage.SignIn,
                _flow.Step,
                _flow.Returning,
                _flow.Name,
                _flow.Notice,
                _busyText,
                _driver,
                _driver is null ? Array.Empty<LapRow>() : _laps.RowsFor(_driver.AssignmentId),
                _standing.Concat(WalkUpRules.Warnings(status)).ToList(),
                _recent.ToList());
        }
    }

    public void Dispose()
    {
        _agent.StatusChanged -= OnStatus;
        _agent.LapQueued -= OnLapQueued;
        _agent.LapsPosted -= OnLapsPosted;
        _agent.Notice -= Log;
        _attempts.Dispose();
    }

    private void OnStatus(AgentStatus _) => RaiseChanged();

    private void OnLapQueued(LapCompleted lap, string? stamp) => Log(_laps.Queued(lap, stamp).Describe());

    private void OnLapsPosted(IReadOnlyList<string> eventIds)
    {
        foreach (var row in _laps.Posted(eventIds)) Log(row.Describe());
    }

    private void RaiseChanged() => Changed?.Invoke();
}
