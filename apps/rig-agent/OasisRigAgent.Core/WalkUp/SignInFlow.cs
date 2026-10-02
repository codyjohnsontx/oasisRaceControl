namespace OasisRigAgent.Core.WalkUp;

/// <summary>
/// Where signing the next driver in has got to. The driver types a name and
/// nothing else is asked until the backend has said whether that name is
/// already somebody's: a taken name is asked for its PIN, a free one has its
/// owner pick a PIN. So a wrong PIN is never offered as a new sign-up, a new
/// driver is never told their PIN is wrong, and nobody is asked "Raced here
/// before?" (the first window asked it; the owner had it dropped). An empty
/// answer at any prompt after the name goes back to the name - the window's
/// "Not you? Pick a different name" button, for the newcomer who typed a name
/// that turned out to be taken.
/// <list type="bullet">
/// <item><see cref="AskName"/>: the name, then <see cref="LookUpName"/>. A name
/// that has already used its logins (below) goes straight to
/// <see cref="PinRefused"/> without a lookup.</item>
/// <item><see cref="LookUpName"/>: waits on the backend's name lookup. Taken
/// goes to <see cref="AskPin"/>, free to <see cref="AskNewPin"/>; a lookup that
/// fails goes back to the name with the reason.</item>
/// <item><see cref="AskPin"/> then <see cref="LogIn"/>: a match signs the
/// driver in. A miss asks for the PIN once more; the second miss goes to
/// <see cref="PinRefused"/>. The misses are counted per name for the whole
/// sign-in, however often the name is typed again, and a name that has used
/// them goes straight to <see cref="PinRefused"/> without a login - so one
/// sign-in makes at most <see cref="SignInFlow.LoginsPerName"/> failed logins
/// for a name, and a stranger cannot run a real name into the backend's lockout
/// (five). Names compare without case, as the backend's do. Never registers
/// anything.</item>
/// <item><see cref="PinRefused"/>: says to ask staff for a PIN reset; any
/// answer goes back to the name.</item>
/// <item><see cref="AskNewPin"/> then <see cref="AskNewPinAgain"/>: two PINs
/// that differ ask for both again, on the rig, with no backend call; the same
/// PIN twice goes to <see cref="Register"/>.</item>
/// <item><see cref="Register"/>: a new driver is signed in. A name taken
/// between the lookup and the sign-up (409) goes back to the name, saying to
/// type it again and sign in with the PIN if it is theirs. Never logs in; a
/// check-in that fails after the sign-up goes back to the name, since the name
/// is theirs now and the lookup will ask for its PIN.</item>
/// <item><see cref="SignedIn"/>: done; <see cref="SignInFlow.Driver"/> is the
/// driver to seat.</item>
/// </list>
/// <see cref="LookUpName"/>, <see cref="LogIn"/> and <see cref="Register"/> are
/// the steps that wait on the backend (<see cref="SignInFlow.Pending"/> says
/// what to send) rather than on the driver.
/// </summary>
public enum SignInStep { AskName, LookUpName, AskPin, LogIn, PinRefused, AskNewPin, AskNewPinAgain, Register, SignedIn }

/// <summary>Which backend call a <see cref="SignInRequest"/> is.</summary>
public enum SignInCall
{
    /// <summary>Is this name somebody's? No PIN.</summary>
    LookUpName,
    /// <summary>A returning driver's login, then the check-in.</summary>
    LogIn,
    /// <summary>A new driver's registration, then the check-in.</summary>
    Register,
}

/// <summary>The one backend call a sign-in is waiting on. For a login or a
/// registration it is the only place a PIN lives once the driver has typed it,
/// and for as long as the call takes; its string form leaves the PIN out so a
/// log line or a debugger cannot pick it up by accident.</summary>
public sealed record SignInRequest(SignInCall Call, string Name, string Pin = "")
{
    public override string ToString() => $"SignInRequest {{ Call = {Call}, Name = {Name} }}";
}

/// <summary>What a <see cref="SignInRequest"/> came to, mapped from
/// <see cref="DriverCheckInClient"/>'s answers by <see cref="SignInAttempt"/>.</summary>
public enum SignInOutcome
{
    SignedIn,
    /// <summary>The looked-up name is already a driver's.</summary>
    NameTaken,
    /// <summary>The looked-up name is nobody's yet.</summary>
    NameFree,
    /// <summary>A returning driver's name and PIN matched nobody (401), or a
    /// new driver's name was taken after all (409). Which it was is known from
    /// the request.</summary>
    NoMatch,
    /// <summary>The backend refused the call for a reason it named
    /// (<see cref="CheckInRefusedException"/>).</summary>
    Refused,
    /// <summary>A new driver was registered and the check-in after it was
    /// refused; the name is theirs now, so the retry is a returning sign-in.</summary>
    SignedUpButRefusedCheckIn,
    /// <summary>A new driver was registered and the backend could not be
    /// reached to check them in.</summary>
    SignedUpButUnreachable,
    /// <summary>The call itself failed.</summary>
    Unreachable,
    /// <summary>The previous driver's queued sign-out could not be delivered
    /// first, so nothing was sent.</summary>
    CheckoutUnsettled,
    /// <summary>The program is closing.</summary>
    Cancelled,
}

public sealed record SignInResult(SignInOutcome Outcome, DriverCheckIn? Driver = null, string? Message = null);

/// <summary>
/// The sign-in rules as one pure state machine, shared by the console loop and
/// the window so the rig has one set of them (<see cref="SignInStep"/> is the
/// contract). Drive it with <see cref="Submit"/> for what the driver typed or
/// chose - the console hands over each line, the window the same answers from
/// its buttons and fields - and <see cref="Apply"/> for what the backend
/// answered when <see cref="Pending"/> is set. One instance is one driver's
/// sign-in: the per-name login count resets when someone signs in.
/// </summary>
public sealed class SignInFlow
{
    public const int LoginsPerName = 2;

    private readonly Dictionary<string, int> _misses = new(StringComparer.OrdinalIgnoreCase);
    // The PIN is held only between the prompt that takes it and the request
    // built from it (a new driver's, until the second typing confirms it);
    // every way out of those steps clears it, and the request is the one copy
    // from then on, released when the answer is applied.
    private string _pin = "";
    private SignInRequest? _pending;

    public SignInFlow(string? notice = null)
    {
        Notice = notice;
    }

    public SignInStep Step { get; private set; } = SignInStep.AskName;

    /// <summary>Whether the name turned out to be a driver's already (the
    /// returning path) - known once the lookup has answered.</summary>
    public bool Returning { get; private set; }

    /// <summary>The name typed at <see cref="SignInStep.AskName"/>; shown on
    /// every later prompt (<see cref="ShowsName"/>).</summary>
    public string Name { get; private set; } = "";

    /// <summary>What to tell the driver on the current prompt, or null. A
    /// refusal, a mistyped PIN, the previous driver's log-out.</summary>
    public string? Notice { get; private set; }

    /// <summary>The call the flow is waiting on, when <see cref="Step"/> is
    /// <see cref="SignInStep.LookUpName"/>, <see cref="SignInStep.LogIn"/> or
    /// <see cref="SignInStep.Register"/>.</summary>
    public SignInRequest? Pending => _pending;

    /// <summary>Whether a typed PIN is still held outside a pending request.</summary>
    internal bool HoldsPin => _pin.Length > 0;

    /// <summary>Set once <see cref="Step"/> is <see cref="SignInStep.SignedIn"/>.</summary>
    public DriverCheckIn? Driver { get; private set; }

    /// <summary>Whether the current prompt is about a name already given.</summary>
    public bool ShowsName => Step is SignInStep.AskPin or SignInStep.PinRefused or SignInStep.AskNewPin or SignInStep.AskNewPinAgain;

    /// <summary>Whether the flow is waiting on the driver rather than the backend.</summary>
    public bool AwaitsDriver => Step is not (SignInStep.LookUpName or SignInStep.LogIn or SignInStep.Register or SignInStep.SignedIn);

    /// <summary>What the driver typed or chose at the current prompt. Empty
    /// goes back to the name (and at the name does nothing). Ignored while the
    /// flow waits on the backend.</summary>
    public void Submit(string typed)
    {
        typed = typed.Trim();
        switch (Step)
        {
            case SignInStep.AskName:
                if (typed.Length == 0) break;
                Notice = null;
                Name = typed;
                if (_misses.GetValueOrDefault(Name) >= LoginsPerName)
                {
                    Returning = true;
                    Step = SignInStep.PinRefused;
                    break;
                }
                _pending = new SignInRequest(SignInCall.LookUpName, Name);
                Step = SignInStep.LookUpName;
                break;

            case SignInStep.AskPin:
                Notice = null;
                _pin = "";
                if (typed.Length == 0) Step = SignInStep.AskName;
                else if (!DriverCheckInClient.IsPin(typed)) Notice = "The PIN is exactly 4 digits.";
                else
                {
                    _pending = new SignInRequest(SignInCall.LogIn, Name, typed);
                    Step = SignInStep.LogIn;
                }
                break;

            case SignInStep.PinRefused:
                Notice = null;
                Step = SignInStep.AskName;
                break;

            case SignInStep.AskNewPin:
                Notice = null;
                _pin = "";
                if (typed.Length == 0) Step = SignInStep.AskName;
                else if (!DriverCheckInClient.IsPin(typed)) Notice = "The PIN is exactly 4 digits.";
                else
                {
                    _pin = typed;
                    Step = SignInStep.AskNewPinAgain;
                }
                break;

            case SignInStep.AskNewPinAgain:
                Notice = null;
                var first = _pin;
                _pin = "";
                if (typed.Length == 0) Step = SignInStep.AskNewPin;
                else if (typed == first)
                {
                    _pending = new SignInRequest(SignInCall.Register, Name, typed);
                    Step = SignInStep.Register;
                }
                else
                {
                    Notice = "The two PINs did not match, so nothing was signed up. Pick a PIN and type it twice.";
                    Step = SignInStep.AskNewPin;
                }
                break;
        }
    }

    /// <summary>What the backend answered to <see cref="Pending"/>. Ignored
    /// unless the flow is waiting on it.</summary>
    public void Apply(SignInResult result)
    {
        if (_pending is not { } request) return;
        // The answer is in, whatever it says: the request, and the PIN in it,
        // are not needed again. A retry is typed afresh.
        _pending = null;
        switch (result.Outcome)
        {
            case SignInOutcome.SignedIn:
                Driver = result.Driver ?? throw new ArgumentException("a signed-in result names the driver", nameof(result));
                Notice = null;
                Step = SignInStep.SignedIn;
                break;
            case SignInOutcome.NameTaken:
                Returning = true;
                Notice = null;
                Step = SignInStep.AskPin;
                break;
            case SignInOutcome.NameFree:
                Returning = false;
                Notice = null;
                Step = SignInStep.AskNewPin;
                break;
            case SignInOutcome.NoMatch when request.Call == SignInCall.Register:
                Notice = $"The name \"{Name}\" was taken just now. If it is yours, type it again and sign in with your PIN; otherwise type a different name.";
                Step = SignInStep.AskName;
                break;
            case SignInOutcome.NoMatch when (_misses[Name] = _misses.GetValueOrDefault(Name) + 1) < LoginsPerName:
                Notice = $"That PIN does not match \"{Name}\". Type it again.";
                Step = SignInStep.AskPin;
                break;
            case SignInOutcome.NoMatch:
                Notice = null;
                Step = SignInStep.PinRefused;
                break;
            case SignInOutcome.Refused:
                Notice = $"Could not sign in: {result.Message}";
                Step = SignInStep.AskName;
                break;
            case SignInOutcome.SignedUpButRefusedCheckIn:
                Returning = true;
                Notice = $"You are signed up as \"{Name}\", but could not be checked in: {result.Message}. Type your name and PIN to check in.";
                Step = SignInStep.AskName;
                break;
            case SignInOutcome.SignedUpButUnreachable:
                Returning = true;
                Notice = $"You are signed up as \"{Name}\", but the backend could not be reached to check you in ({result.Message}). Type your name and PIN to check in.";
                Step = SignInStep.AskName;
                break;
            case SignInOutcome.Unreachable:
                Notice = $"Could not reach the backend ({result.Message}). Check the network and try again.";
                Step = SignInStep.AskName;
                break;
            case SignInOutcome.CheckoutUnsettled:
                Notice = "Could not reach the backend to finish the last log-out. Check the network and try again.";
                Step = SignInStep.AskName;
                break;
            case SignInOutcome.Cancelled:
                // The program is closing; whoever drives the flow stops here.
                Step = SignInStep.AskName;
                break;
        }
    }
}

/// <summary>Sends a <see cref="SignInRequest"/> and names what came of it, so
/// the console and the window map the client's answers one way.</summary>
public static class SignInAttempt
{
    /// <summary>A name lookup asks the backend and nothing else. A login or a
    /// registration delivers any sign-out still owed first, so the same driver
    /// signing straight back in gets a fresh stint, then logs in or registers
    /// and checks in.</summary>
    public static async Task<SignInResult> PerformAsync(
        AgentService agent, DriverCheckInClient checkIn, SignInRequest request, CancellationToken quit)
    {
        DriverCheckIn? driver;
        try
        {
            if (request.Call == SignInCall.LookUpName)
            {
                return new SignInResult(await checkIn.NameTakenAsync(request.Name, quit).ConfigureAwait(false)
                    ? SignInOutcome.NameTaken
                    : SignInOutcome.NameFree);
            }
            if (!await agent.SettlePendingCheckoutAsync().ConfigureAwait(false))
                return new SignInResult(SignInOutcome.CheckoutUnsettled);
            driver = request.Call == SignInCall.LogIn
                ? await checkIn.CheckInReturningAsync(request.Name, request.Pin, quit).ConfigureAwait(false)
                : await checkIn.CheckInNewAsync(request.Name, request.Pin, quit).ConfigureAwait(false);
        }
        catch (SignedUpButNotCheckedInException ex)
        {
            return new SignInResult(ex.InnerException is CheckInRefusedException
                ? SignInOutcome.SignedUpButRefusedCheckIn
                : SignInOutcome.SignedUpButUnreachable, Message: ex.Message);
        }
        catch (CheckInRefusedException ex)
        {
            return new SignInResult(SignInOutcome.Refused, Message: ex.Message);
        }
        catch (OperationCanceledException) when (quit.IsCancellationRequested)
        {
            return new SignInResult(SignInOutcome.Cancelled);
        }
        catch (Exception ex)
        {
            return new SignInResult(SignInOutcome.Unreachable, Message: ex.Message);
        }
        return driver is null
            ? new SignInResult(SignInOutcome.NoMatch)
            : new SignInResult(SignInOutcome.SignedIn, driver);
    }
}
