using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The sign-in rules on their own, with the backend's answers scripted: the
/// same sequences DriverPromptTests types into the console, here as the state
/// machine both the console and the window run. Mike's PIN is 4321; "Guest" is
/// taken but no PIN logs it in; any other name is free.
/// </summary>
public sealed class SignInFlowTests
{
    private static readonly DriverCheckIn Mike = new("Mike", Returning: true, "d-mike", WalkUpBackend.MikeAssignmentId);

    /// <summary>Answers each pending request the way the deployed routes would
    /// and counts the calls.</summary>
    private sealed class ScriptedBackend
    {
        public int Logins;
        public int Registers;

        public SignInResult Answer(SignInRequest request)
        {
            if (request.Returning)
            {
                Logins++;
                return request.Name == "Mike" && request.Pin == "4321"
                    ? new SignInResult(SignInOutcome.SignedIn, Mike)
                    : new SignInResult(SignInOutcome.NoMatch);
            }
            Registers++;
            return request.Name is "Mike" or "Guest"
                ? new SignInResult(SignInOutcome.NoMatch)
                : new SignInResult(SignInOutcome.SignedIn, new DriverCheckIn(request.Name, Returning: false, "d-new", "a-new"));
        }
    }

    private const string PinRefused = "That PIN does not match. Ask staff to reset your PIN, or press Enter to try a different name.";
    private const string PinsDiffer = "The two PINs did not match, so nothing was signed up. Pick a PIN and type it twice.";
    private const string NameTaken = "The name \"Mike\" is already registered. If it is yours, press Enter and answer y to \"Raced here before?\"; otherwise type a different name.";

    /// <summary>Every sequence, typed answer by answer: how many logins and
    /// registrations it cost, the step it ended at, and the notice showing there
    /// (or the driver signed in).</summary>
    public static IEnumerable<object?[]> Sequences => new[]
    {
        new object?[] { "returning driver, right PIN", new[] { "y", "Mike", "4321" }, 1, 0, SignInStep.SignedIn, null },
        new object?[] { "returning driver, wrong then right (2026-09-28)", new[] { "y", "Mike", "1234", "4321" }, 2, 0, SignInStep.SignedIn, null },
        new object?[] { "returning driver, wrong once", new[] { "y", "Mike", "1234" }, 1, 0, SignInStep.AskPin, "That PIN does not match \"Mike\". Type it again." },
        new object?[] { "returning driver, wrong twice", new[] { "y", "Mike", "1234", "5678" }, 2, 0, SignInStep.PinRefused, null },
        new object?[] { "stranger typing a registered name stops at two logins", new[] { "y", "Mike", "1234", "5678", "9999" }, 2, 0, SignInStep.AskName, null },
        new object?[] { "stranger typing the name again gets no more logins", new[] { "y", "Mike", "1234", "5678", "", "Mike", "1111", "mike", "2222" }, 2, 0, SignInStep.AskName, null },
        new object?[] { "a used-up name leaves another name its own two", new[] { "y", "Mike", "1234", "5678", "", "Guest", "1234", "5678" }, 4, 0, SignInStep.PinRefused, null },
        new object?[] { "guest or banned name, no PIN logs in", new[] { "y", "Guest", "4321", "4321" }, 2, 0, SignInStep.PinRefused, null },
        new object?[] { "not 4 digits, never sent", new[] { "y", "Mike", "12" }, 0, 0, SignInStep.AskPin, "The PIN is exactly 4 digits." },
        new object?[] { "new driver, PIN typed the same twice", new[] { "n", "Alex", "1234", "1234" }, 0, 1, SignInStep.SignedIn, null },
        new object?[] { "new driver, PINs differ then match", new[] { "n", "Alex", "1234", "1243", "5678", "5678" }, 0, 1, SignInStep.SignedIn, null },
        new object?[] { "new driver, PINs differ", new[] { "n", "Alex", "1234", "1243" }, 0, 0, SignInStep.AskNewPin, PinsDiffer },
        new object?[] { "new driver, PINs differ twice", new[] { "n", "Alex", "1234", "1243", "1234", "1244" }, 0, 0, SignInStep.AskNewPin, PinsDiffer },
        new object?[] { "new driver, name taken", new[] { "n", "Mike", "1234", "1234" }, 0, 1, SignInStep.AskName, NameTaken },
        new object?[] { "new driver, name taken, then returning with the right PIN", new[] { "n", "Mike", "1234", "1234", "", "y", "Mike", "4321" }, 1, 1, SignInStep.SignedIn, null },
        new object?[] { "neither y nor n", new[] { "maybe" }, 0, 0, SignInStep.AskRacedBefore, "Type y if you have raced here before, or n if you are new." },
        new object?[] { "Enter at raced here before", new[] { "" }, 0, 0, SignInStep.AskRacedBefore, null },
        new object?[] { "Enter at the returning name", new[] { "y", "" }, 0, 0, SignInStep.AskRacedBefore, null },
        new object?[] { "Enter at the new name", new[] { "n", "" }, 0, 0, SignInStep.AskRacedBefore, null },
        new object?[] { "Enter at the PIN", new[] { "y", "Mike", "" }, 0, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the re-asked PIN", new[] { "y", "Mike", "1234", "" }, 1, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the PIN refusal", new[] { "y", "Mike", "1234", "5678", "" }, 2, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the new PIN", new[] { "n", "Alex", "" }, 0, 0, SignInStep.AskName, null },
        new object?[] { "Enter at the new PIN again", new[] { "n", "Alex", "1234", "" }, 0, 0, SignInStep.AskNewPin, null },
        new object?[] { "answers are trimmed and y/n take yes/no in any case", new[] { " YES ", "  Mike ", " 4321 " }, 1, 0, SignInStep.SignedIn, null },
    };

    [Theory]
    [MemberData(nameof(Sequences))]
    public void EverySignInSequenceEndsWhereTheRulesSay(
        string sequence, string[] typed, int logins, int registers, SignInStep endsAt, string? notice)
    {
        var backend = new ScriptedBackend();
        var flow = new SignInFlow();

        foreach (var answer in typed)
        {
            Assert.True(flow.AwaitsDriver, $"{sequence}: typed \"{answer}\" while the flow was not asking");
            flow.Submit(answer);
            if (flow.Pending is { } request) flow.Apply(backend.Answer(request));
        }

        Assert.True(logins == backend.Logins, $"{sequence}: logins {backend.Logins}");
        Assert.True(registers == backend.Registers, $"{sequence}: registrations {backend.Registers}");
        Assert.True(endsAt == flow.Step, $"{sequence}: ended at {flow.Step}");
        Assert.True(notice == flow.Notice, $"{sequence}: notice \"{flow.Notice}\"");
        if (endsAt == SignInStep.SignedIn) Assert.NotNull(flow.Driver);
    }

    [Fact]
    public void TheNameIsShownOnEveryPromptAboutIt()
    {
        var flow = new SignInFlow();
        Assert.False(flow.ShowsName);
        flow.Submit("n");
        Assert.False(flow.ShowsName);
        flow.Submit("Alex");
        Assert.True(flow.ShowsName);
        Assert.Equal("Alex", flow.Name);
        flow.Submit("1234");
        Assert.Equal(SignInStep.AskNewPinAgain, flow.Step);
        Assert.True(flow.ShowsName);
    }

    [Fact]
    public void TheOpeningNoticeIsShownOnceAndGoneAtTheFirstAnswer()
    {
        var flow = new SignInFlow("Thanks Mike, you are logged out.");
        Assert.Equal("Thanks Mike, you are logged out.", flow.Notice);
        flow.Submit("y");
        Assert.Null(flow.Notice);
    }

    [Fact]
    public void ThePendingRequestCarriesExactlyWhatWasTyped()
    {
        var flow = new SignInFlow();
        flow.Submit("y");
        flow.Submit("Mike");
        flow.Submit("4321");
        Assert.Equal(new SignInRequest(true, "Mike", "4321"), flow.Pending);
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

        static SignInFlow AtLogIn()
        {
            var flow = new SignInFlow();
            flow.Submit("y");
            flow.Submit("Mike");
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
        flow.Submit("n");
        flow.Submit("Alex");
        flow.Submit("1234");
        flow.Submit("1234");
        Assert.Equal(SignInStep.Register, flow.Step);
        flow.Apply(new SignInResult(outcome, Message: "someone else checked in at the same moment - type your name and PIN again"));
        Assert.Equal(SignInStep.AskName, flow.Step);
        Assert.True(flow.Returning);
        Assert.Equal(notice, flow.Notice);
    }

    [Fact]
    public void AnAnswerWithNoPendingRequestIsIgnored()
    {
        var flow = new SignInFlow();
        flow.Apply(new SignInResult(SignInOutcome.SignedIn, Mike));
        Assert.Equal(SignInStep.AskRacedBefore, flow.Step);
        Assert.Null(flow.Driver);
    }
}
