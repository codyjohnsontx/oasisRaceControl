using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The sign-in rules on their own, with the backend's answers scripted: the
/// same sequences DriverPromptTests types into the console, here as the state
/// machine both the console and the window run. Mike's PIN is 4321; "Guest" is
/// taken but no PIN logs it in; "Race" is free at the lookup and taken by the
/// time the sign-up lands; "Offline" cannot be looked up; any other name is
/// free.
/// </summary>
public sealed class SignInFlowTests
{
    private static readonly DriverCheckIn Mike = new("Mike", Returning: true, "d-mike", WalkUpBackend.MikeAssignmentId);

    /// <summary>Answers each pending request the way the deployed routes would
    /// and counts the calls.</summary>
    private sealed class ScriptedBackend
    {
        public int Lookups;
        public int Logins;
        public int Registers;

        private static bool Is(string name, string known) => string.Equals(name, known, StringComparison.OrdinalIgnoreCase);

        public SignInResult Answer(SignInRequest request)
        {
            switch (request.Call)
            {
                case SignInCall.LookUpName:
                    Lookups++;
                    if (Is(request.Name, "Offline")) return new SignInResult(SignInOutcome.Unreachable, Message: "venue wifi is down");
                    return Is(request.Name, "Mike") || Is(request.Name, "Guest")
                        ? new SignInResult(SignInOutcome.NameTaken)
                        : new SignInResult(SignInOutcome.NameFree);
                case SignInCall.LogIn:
                    Logins++;
                    return Is(request.Name, "Mike") && request.Pin == "4321"
                        ? new SignInResult(SignInOutcome.SignedIn, Mike)
                        : new SignInResult(SignInOutcome.NoMatch);
                default:
                    Registers++;
                    return Is(request.Name, "Mike") || Is(request.Name, "Guest") || Is(request.Name, "Race")
                        ? new SignInResult(SignInOutcome.NoMatch)
                        : new SignInResult(SignInOutcome.SignedIn, new DriverCheckIn(request.Name, Returning: false, "d-new", "a-new"));
            }
        }
    }

    private const string PinsDiffer = "The two PINs did not match, so nothing was signed up. Pick a PIN and type it twice.";
    private const string TakenMeanwhile = "The name \"Race\" was taken just now. If it is yours, type it again and sign in with your PIN; otherwise type a different name.";
    private const string LookupFailed = "Could not reach the backend (venue wifi is down). Check the network and try again.";

    /// <summary>Every sequence, typed answer by answer: how many lookups,
    /// logins and registrations it cost, the step it ended at, and the notice
    /// showing there (or the driver signed in).</summary>
    public static IEnumerable<object?[]> Sequences => new[]
    {
        new object?[] { "returning driver, right PIN", new[] { "Mike", "4321" }, 1, 1, 0, SignInStep.SignedIn, null },
        new object?[] { "returning driver, wrong then right (2026-09-28)", new[] { "Mike", "1234", "4321" }, 1, 2, 0, SignInStep.SignedIn, null },
        new object?[] { "returning driver, wrong once", new[] { "Mike", "1234" }, 1, 1, 0, SignInStep.AskPin, "That PIN does not match \"Mike\". Type it again." },
        new object?[] { "returning driver, wrong twice", new[] { "Mike", "1234", "5678" }, 1, 2, 0, SignInStep.PinRefused, null },
        new object?[] { "stranger typing a registered name stops at two logins", new[] { "Mike", "1234", "5678", "9999" }, 1, 2, 0, SignInStep.AskName, null },
        new object?[] { "stranger typing the name again gets no more logins, and no lookup", new[] { "Mike", "1234", "5678", "", "Mike", "1111", "mike", "2222" }, 1, 2, 0, SignInStep.AskName, null },
        new object?[] { "a used-up name leaves another name its own two", new[] { "Mike", "1234", "5678", "", "Guest", "1234", "5678" }, 2, 4, 0, SignInStep.PinRefused, null },
        new object?[] { "guest or banned name, no PIN logs in", new[] { "Guest", "4321", "4321" }, 1, 2, 0, SignInStep.PinRefused, null },
        new object?[] { "not 4 digits, never sent", new[] { "Mike", "12" }, 1, 0, 0, SignInStep.AskPin, "The PIN is exactly 4 digits." },
        new object?[] { "new driver, PIN typed the same twice", new[] { "Alex", "1234", "1234" }, 1, 0, 1, SignInStep.SignedIn, null },
        new object?[] { "new driver, PINs differ then match", new[] { "Alex", "1234", "1243", "5678", "5678" }, 1, 0, 1, SignInStep.SignedIn, null },
        new object?[] { "new driver, PINs differ", new[] { "Alex", "1234", "1243" }, 1, 0, 0, SignInStep.AskNewPin, PinsDiffer },
        new object?[] { "new driver, PINs differ twice", new[] { "Alex", "1234", "1243", "1234", "1244" }, 1, 0, 0, SignInStep.AskNewPin, PinsDiffer },
        new object?[] { "newcomer types a taken name and picks a different one (Not you?)", new[] { "Mike", "", "Alex", "1234", "1234" }, 2, 0, 1, SignInStep.SignedIn, null },
        new object?[] { "name taken between the lookup and the sign-up", new[] { "Race", "1234", "1234" }, 1, 0, 1, SignInStep.AskName, TakenMeanwhile },
        new object?[] { "the lookup cannot reach the backend", new[] { "Offline" }, 1, 0, 0, SignInStep.AskName, LookupFailed },
        new object?[] { "Enter at the name does nothing", new[] { "" }, 0, 0, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the PIN", new[] { "Mike", "" }, 1, 0, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the re-asked PIN", new[] { "Mike", "1234", "" }, 1, 1, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the PIN refusal", new[] { "Mike", "1234", "5678", "" }, 1, 2, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the new PIN", new[] { "Alex", "" }, 1, 0, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the new PIN again", new[] { "Alex", "1234", "" }, 1, 0, 0, SignInStep.AskNewPin, null },
        new object?[] { "answers are trimmed and the name is matched in any case", new[] { "  mike ", " 4321 " }, 1, 1, 0, SignInStep.SignedIn, null },
    };

    [Theory]
    [MemberData(nameof(Sequences))]
    public void EverySignInSequenceEndsWhereTheRulesSay(
        string sequence, string[] typed, int lookups, int logins, int registers, SignInStep endsAt, string? notice)
    {
        var backend = new ScriptedBackend();
        var flow = new SignInFlow();

        foreach (var answer in typed)
        {
            Assert.True(flow.AwaitsDriver, $"{sequence}: typed \"{answer}\" while the flow was not asking");
            flow.Submit(answer);
            if (flow.Pending is { } request) flow.Apply(backend.Answer(request));
        }

        Assert.True(lookups == backend.Lookups, $"{sequence}: lookups {backend.Lookups}");
        Assert.True(logins == backend.Logins, $"{sequence}: logins {backend.Logins}");
        Assert.True(registers == backend.Registers, $"{sequence}: registrations {backend.Registers}");
        Assert.True(endsAt == flow.Step, $"{sequence}: ended at {flow.Step}");
        Assert.True(notice == flow.Notice, $"{sequence}: notice \"{flow.Notice}\"");
        if (endsAt == SignInStep.SignedIn) Assert.NotNull(flow.Driver);
    }

    /// <summary>No PIN prompt of either kind shows until the lookup has said
    /// which the name is: a taken name is asked for its PIN, a free one has
    /// its owner pick one.</summary>
    [Fact]
    public void TheLookupDecidesWhichPinPromptFollowsTheName()
    {
        var returning = new SignInFlow();
        returning.Submit("Mike");
        Assert.Equal(SignInStep.LookUpName, returning.Step);
        Assert.False(returning.AwaitsDriver);
        Assert.Equal(new SignInRequest(SignInCall.LookUpName, "Mike"), returning.Pending);
        returning.Apply(new SignInResult(SignInOutcome.NameTaken));
        Assert.Equal(SignInStep.AskPin, returning.Step);
        Assert.True(returning.Returning);

        var fresh = new SignInFlow();
        fresh.Submit("Alex");
        fresh.Apply(new SignInResult(SignInOutcome.NameFree));
        Assert.Equal(SignInStep.AskNewPin, fresh.Step);
        Assert.False(fresh.Returning);
    }

    [Fact]
    public void TheNameIsShownOnEveryPromptAboutIt()
    {
        var flow = new SignInFlow();
        Assert.False(flow.ShowsName);
        flow.Submit("Alex");
        flow.Apply(new SignInResult(SignInOutcome.NameFree));
        Assert.True(flow.ShowsName);
        Assert.Equal("Alex", flow.Name);
        flow.Submit("1234");
        Assert.Equal(SignInStep.AskNewPinAgain, flow.Step);
        Assert.True(flow.ShowsName);
    }

    [Fact]
    public void TheOpeningNoticeIsShownOnceAndGoneAtTheFirstName()
    {
        var flow = new SignInFlow("Thanks Mike, you are logged out.");
        Assert.Equal("Thanks Mike, you are logged out.", flow.Notice);
        // Enter alone at the name leaves it: there is nothing to go back to.
        flow.Submit("");
        Assert.Equal("Thanks Mike, you are logged out.", flow.Notice);
        flow.Submit("Alex");
        Assert.Null(flow.Notice);
    }

    [Fact]
    public void ThePendingRequestCarriesExactlyWhatWasTyped()
    {
        var flow = new SignInFlow();
        flow.Submit("Mike");
        flow.Apply(new SignInResult(SignInOutcome.NameTaken));
        flow.Submit("4321");
        Assert.Equal(new SignInRequest(SignInCall.LogIn, "Mike", "4321"), flow.Pending);
        Assert.False(flow.AwaitsDriver);
        // Nothing typed while the backend is asked moves the flow.
        flow.Submit("");
        Assert.Equal(SignInStep.LogIn, flow.Step);
    }

    [Fact]
    public void EveryBackendAnswerGoesBackToTheNameWithItsReason()
    {
        var refused = AtLogIn();
        refused.Apply(new SignInResult(SignInOutcome.Refused, Message: "the name \"Mike\" is locked after five wrong PINs - try again after 20:15"));
        Assert.Equal(SignInStep.AskName, refused.Step);
        Assert.Equal("Could not sign in: the name \"Mike\" is locked after five wrong PINs - try again after 20:15", refused.Notice);

        var unreachable = AtLogIn();
        unreachable.Apply(new SignInResult(SignInOutcome.Unreachable, Message: "venue wifi is down"));
        Assert.Equal(SignInStep.AskName, unreachable.Step);
        Assert.Equal("Could not reach the backend (venue wifi is down). Check the network and try again.", unreachable.Notice);

        var owed = AtLogIn();
        owed.Apply(new SignInResult(SignInOutcome.CheckoutUnsettled));
        Assert.Equal(SignInStep.AskName, owed.Step);
        Assert.Equal("Could not reach the backend to finish the last log-out. Check the network and try again.", owed.Notice);

        var cancelled = AtLogIn();
        cancelled.Apply(new SignInResult(SignInOutcome.Cancelled));
        Assert.Equal(SignInStep.AskName, cancelled.Step);
        Assert.Null(cancelled.Notice);

        // A lookup the backend refused by name - a name it could never
        // register, a backend too old to look names up - says so at the name.
        var lookupRefused = new SignInFlow();
        lookupRefused.Submit("Mike<>");
        lookupRefused.Apply(new SignInResult(SignInOutcome.Refused, Message: "that name is not allowed: 2 to 24 letters, numbers, spaces or . _ ' -"));
        Assert.Equal(SignInStep.AskName, lookupRefused.Step);
        Assert.Equal("Could not sign in: that name is not allowed: 2 to 24 letters, numbers, spaces or . _ ' -", lookupRefused.Notice);

        static SignInFlow AtLogIn()
        {
            var flow = new SignInFlow();
            flow.Submit("Mike");
            flow.Apply(new SignInResult(SignInOutcome.NameTaken));
            flow.Submit("1234");
            return flow;
        }
    }

    /// <summary>A new driver whose sign-up landed but whose check-in did not
    /// owns the name now: the retry is the returning path, whichever way the
    /// check-in failed.</summary>
    [Theory]
    [InlineData(SignInOutcome.SignedUpButRefusedCheckIn, "You are signed up as \"Alex\", but could not be checked in: someone else checked in at the same moment - type your name and PIN again. Type your name and PIN to check in.")]
    [InlineData(SignInOutcome.SignedUpButUnreachable, "You are signed up as \"Alex\", but the backend could not be reached to check you in (someone else checked in at the same moment - type your name and PIN again). Type your name and PIN to check in.")]
    public void ASignedUpDriverWhoseCheckInFailedRetriesAsReturning(SignInOutcome outcome, string notice)
    {
        var flow = new SignInFlow();
        flow.Submit("Alex");
        flow.Apply(new SignInResult(SignInOutcome.NameFree));
        flow.Submit("1234");
        flow.Submit("1234");
        Assert.Equal(SignInStep.Register, flow.Step);
        flow.Apply(new SignInResult(outcome, Message: "someone else checked in at the same moment - type your name and PIN again"));
        Assert.Equal(SignInStep.AskName, flow.Step);
        Assert.True(flow.Returning);
        Assert.Equal(notice, flow.Notice);
    }

    /// <summary>A PIN is held only while it is needed: never once the request
    /// is built, never after a back, a mismatch or a refusal, and the request
    /// itself is released when its answer is applied. A lookup request holds
    /// no PIN at all.</summary>
    [Fact]
    public void ThePinIsHeldOnlyWhileItIsNeeded()
    {
        var returning = new SignInFlow();
        returning.Submit("Mike");
        Assert.Equal("", returning.Pending?.Pin);
        returning.Apply(new SignInResult(SignInOutcome.NameTaken));
        returning.Submit("12");
        Assert.False(returning.HoldsPin);
        returning.Submit("4321");
        Assert.False(returning.HoldsPin);
        Assert.Equal("4321", returning.Pending?.Pin);
        Assert.DoesNotContain("4321", returning.Pending!.ToString());
        returning.Apply(new SignInResult(SignInOutcome.NoMatch));
        Assert.Null(returning.Pending);
        Assert.False(returning.HoldsPin);
        returning.Submit("4321");
        returning.Apply(new SignInResult(SignInOutcome.Refused, Message: "locked"));
        Assert.Null(returning.Pending);

        var fresh = new SignInFlow();
        fresh.Submit("Alex");
        fresh.Apply(new SignInResult(SignInOutcome.NameFree));
        fresh.Submit("1234");
        Assert.True(fresh.HoldsPin);
        fresh.Submit("");
        Assert.False(fresh.HoldsPin);
        Assert.Equal(SignInStep.AskNewPin, fresh.Step);
        fresh.Submit("1234");
        fresh.Submit("1243");
        Assert.False(fresh.HoldsPin);
        Assert.Equal(SignInStep.AskNewPin, fresh.Step);
        fresh.Submit("5678");
        fresh.Submit("");
        Assert.False(fresh.HoldsPin);
        fresh.Submit("5678");
        fresh.Submit("5678");
        Assert.False(fresh.HoldsPin);
        Assert.Equal(new SignInRequest(SignInCall.Register, "Alex", "5678"), fresh.Pending);
        fresh.Apply(new SignInResult(SignInOutcome.SignedIn, new DriverCheckIn("Alex", false, "d-new", "a-new")));
        Assert.Null(fresh.Pending);
        Assert.False(fresh.HoldsPin);
        Assert.Equal(SignInStep.SignedIn, fresh.Step);

        var cancelled = new SignInFlow();
        cancelled.Submit("Mike");
        cancelled.Apply(new SignInResult(SignInOutcome.NameTaken));
        cancelled.Submit("4321");
        cancelled.Apply(new SignInResult(SignInOutcome.Cancelled));
        Assert.Null(cancelled.Pending);
        Assert.False(cancelled.HoldsPin);
    }

    [Fact]
    public void AnAnswerWithNoPendingRequestIsIgnored()
    {
        var flow = new SignInFlow();
        flow.Apply(new SignInResult(SignInOutcome.SignedIn, Mike));
        Assert.Equal(SignInStep.AskName, flow.Step);
        Assert.Null(flow.Driver);
    }
}
