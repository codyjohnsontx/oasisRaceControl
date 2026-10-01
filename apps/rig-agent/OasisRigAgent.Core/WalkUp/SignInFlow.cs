namespace OasisRigAgent.Core.WalkUp;

/// <summary>
/// Where signing the next driver in has got to. The rig asks whether the
/// driver has raced here before instead of guessing it from a failed login, so
/// a wrong PIN is never offered as a new sign-up and a new driver is never told
/// their PIN is wrong. An empty answer at any prompt goes back one step.
/// <list type="bullet">
/// <item><see cref="AskRacedBefore"/>: y goes to the returning path, n to the
/// new one.</item>
/// <item><see cref="AskName"/>: the name, then <see cref="AskPin"/> (returning)
/// or <see cref="AskNewPin"/> (new).</item>
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
/// <item><see cref="Register"/>: a new driver is signed in. A taken name (409)
/// goes back to the name, saying to answer y if it is theirs. Never logs in; a
/// check-in that fails after the sign-up goes back to the name on the
/// returning path, since the name is theirs now.</item>
/// <item><see cref="SignedIn"/>: done; <see cref="SignInFlow.Driver"/> is the
/// driver to seat.</item>
/// </list>
/// <see cref="LogIn"/> and <see cref="Register"/> are the two steps that wait
/// on the backend (<see cref="SignInFlow.Pending"/> says what to send) rather
/// than on the driver.
/// </summary>
public enum SignInStep { AskRacedBefore, AskName, AskPin, LogIn, PinRefused, AskNewPin, AskNewPinAgain, Register, SignedIn }

/// <summary>The one backend call a sign-in is waiting on: a returning driver's
/// login or a new driver's registration, each followed by the check-in.</summary>
public sealed record SignInRequest(bool Returning, string Name, string Pin);

/// <summary>What a <see cref="SignInRequest"/> came to, mapped from
/// <see cref="DriverCheckInClient"/>'s answers by <see cref="SignInAttempt"/>.</summary>
public enum SignInOutcome
{
    SignedIn,
    /// <summary>A returning driver's name and PIN matched nobody (401), or a
    /// new driver's name is already taken (409). Which it was is known from the
    /// request.</summary>
    NoMatch,
    /// <summary>The backend refused the sign-in for a reason it named
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
    private string _pin = "";

    public SignInFlow(string? notice = null) => Notice = notice;

    public SignInStep Step { get; private set; } = SignInStep.AskRacedBefore;

    /// <summary>Which path the driver chose at <see cref="SignInStep.AskRacedBefore"/>.</summary>
    public bool Returning { get; private set; }

    /// <summary>The name typed at <see cref="SignInStep.AskName"/>; shown on
    /// every later prompt (<see cref="ShowsName"/>).</summary>
    public string Name { get; private set; } = "";

    /// <summary>What to tell the driver on the current prompt, or null. A
    /// refusal, a mistyped PIN, the previous driver's log-out.</summary>
    public string? Notice { get; private set; }

    /// <summary>The call the flow is waiting on, when <see cref="Step"/> is
    /// <see cref="SignInStep.LogIn"/> or <see cref="SignInStep.Register"/>.</summary>
    public SignInRequest? Pending => Step is SignInStep.LogIn or SignInStep.Register
        ? new SignInRequest(Step == SignInStep.LogIn, Name, _pin)
        : null;

    /// <summary>Set once <see cref="Step"/> is <see cref="SignInStep.SignedIn"/>.</summary>
    public DriverCheckIn? Driver { get; private set; }

    /// <summary>Whether the current prompt is about a name already given.</summary>
    public bool ShowsName => Step is SignInStep.AskPin or SignInStep.PinRefused or SignInStep.AskNewPin or SignInStep.AskNewPinAgain;

    /// <summary>Whether the flow is waiting on the driver rather than the backend.</summary>
    public bool AwaitsDriver => Step is not (SignInStep.LogIn or SignInStep.Register or SignInStep.SignedIn);

    /// <summary>The returning (y) or new (n) answer, as the window's two buttons give it.</summary>
    public void ChooseReturning(bool returning) => Submit(returning ? "y" : "n");

    /// <summary>What the driver typed or chose at the current prompt. Empty
    /// goes back one step. Ignored while the flow waits on the backend.</summary>
    public void Submit(string typed)
    {
        typed = typed.Trim();
        switch (Step)
        {
            case SignInStep.AskRacedBefore:
                Notice = null;
                switch (typed.ToLowerInvariant())
                {
                    case "y" or "yes":
                        Returning = true;
                        Step = SignInStep.AskName;
                        break;
                    case "n" or "no":
                        Returning = false;
                        Step = SignInStep.AskName;
                        break;
                    case "":
                        break;
                    default:
                        Notice = "Type y if you have raced here before, or n if you are new.";
                        break;
                }
                break;

            case SignInStep.AskName:
                Notice = null;
                if (typed.Length == 0)
                {
                    Step = SignInStep.AskRacedBefore;
                    break;
                }
                Name = typed;
                Step = !Returning ? SignInStep.AskNewPin
                    : _misses.GetValueOrDefault(Name) >= LoginsPerName ? SignInStep.PinRefused
                    : SignInStep.AskPin;
                break;

            case SignInStep.AskPin:
                Notice = null;
                if (typed.Length == 0) Step = SignInStep.AskName;
                else if (!DriverCheckInClient.IsPin(typed)) Notice = "The PIN is exactly 4 digits.";
                else
                {
                    _pin = typed;
                    Step = SignInStep.LogIn;
                }
                break;

            case SignInStep.PinRefused:
                Notice = null;
                Step = SignInStep.AskName;
                break;

            case SignInStep.AskNewPin:
                Notice = null;
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
                if (typed.Length == 0) Step = SignInStep.AskNewPin;
                else if (typed == _pin) Step = SignInStep.Register;
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
        if (Pending is not { } request) return;
        switch (result.Outcome)
        {
            case SignInOutcome.SignedIn:
                Driver = result.Driver ?? throw new ArgumentException("a signed-in result names the driver", nameof(result));
                Notice = null;
                Step = SignInStep.SignedIn;
                break;
            case SignInOutcome.NoMatch when !request.Returning:
                Notice = $"The name \"{Name}\" is already registered. If it is yours, press Enter and answer y to \"Raced here before?\"; otherwise type a different name.";
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
    /// <summary>Deliver any sign-out still owed first, so the same driver
    /// signing straight back in gets a fresh stint, then log in or register and
    /// check in.</summary>
    public static async Task<SignInResult> PerformAsync(
        AgentService agent, DriverCheckInClient checkIn, SignInRequest request, CancellationToken quit)
    {
        DriverCheckIn? driver;
        try
        {
            if (!await agent.SettlePendingCheckoutAsync().ConfigureAwait(false))
                return new SignInResult(SignInOutcome.CheckoutUnsettled);
            driver = request.Returning
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
