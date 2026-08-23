using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The rule that decides whether this computer is the rig it says it is.
///
/// The failure it exists for is a correct install command typed at the wrong
/// machine, and what makes that one worth its own machinery is that it does not
/// look like a failure from anywhere: the token is valid, the requests are well
/// formed, the laps are real, and they are credited to a rig across the room.
/// The only two facts that disagree are the number in this computer's config and
/// the rig its token belongs to, and they have never been in the same place
/// before.
///
/// The other half of the rule matters as much: this stops a rig scoring, so it
/// must only ever fire on an answer. A fleet of twenty-plus machines part-way
/// through a deploy, or one talking to a backend older than itself, must not
/// start accusing itself of something nobody can see is untrue.
/// </summary>
public sealed class RigIdentityTests
{
    private static BackendRigIdentity Rig(int number, string? name = null) =>
        new(number, name ?? $"Rig {number:D2}");

    [Fact]
    public void The_rig_its_token_belongs_to_is_the_rig_it_is_installed_as()
        => Assert.Null(RigIdentity.Check(7, Rig(7)));

    [Fact]
    public void Another_rigs_token_on_this_computer_is_caught()
    {
        // The whole point: one wrong paste at enrolment, and every lap driven at
        // station 4 is credited to whoever is checked in at rig 7.
        var verdict = RigIdentity.Check(4, Rig(7, "Rig 07 - corner"));

        Assert.NotNull(verdict);
        Assert.Contains("04", verdict!.Summary, StringComparison.Ordinal);
        Assert.Contains("07", verdict.Summary, StringComparison.Ordinal);
    }

    [Fact]
    public void A_backend_that_does_not_say_which_rig_is_never_an_accusation()
    {
        // A backend older than this agent does not report the rig at all, and every
        // rig in the venue polls one backend: reading silence as a mismatch would
        // take the whole room off the air during a deploy, for a fault none of them
        // have.
        Assert.Null(RigIdentity.Check(7, null));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void An_unusable_number_from_either_side_is_not_a_verdict(int number)
    {
        // A rig cannot be number 0, so neither side saying so is evidence about
        // the other. Stopping a machine scoring needs two real numbers that
        // disagree, not one that could not be read.
        Assert.Null(RigIdentity.Check(number, Rig(7)));
        Assert.Null(RigIdentity.Check(7, new BackendRigIdentity(number, "Rig 00")));
    }

    [Fact]
    public void The_short_form_fits_the_rigs_status_line()
    {
        // It shares one line with the driver's name, the sim reading and the queue
        // depth, and that line is read across a room - the same bound as the other
        // verdicts it sits beside.
        var summary = RigIdentity.Mismatch(4, Rig(7)).Summary;

        Assert.True(summary.Length <= 105, $"summary is {summary.Length} characters: {summary}");
        Assert.DoesNotContain('\n', summary);
    }

    [Fact]
    public void The_long_form_says_what_the_short_one_cannot()
    {
        // Read in logs\agent.log and from --check-backend by somebody who is fixing
        // this machine, and every part of it is something they cannot work out from
        // the rig itself: what is actually happening to the laps, that the other rig
        // is unaffected, and the command that fixes it.
        var instruction = RigIdentity.Mismatch(4, Rig(7)).Instruction;

        Assert.Contains("agent.config.json", instruction, StringComparison.Ordinal);
        Assert.Contains("Install-RigAgent.ps1", instruction, StringComparison.Ordinal);
        Assert.Contains("credited to rig 07", instruction, StringComparison.Ordinal);
        Assert.Contains("deliver themselves", instruction, StringComparison.Ordinal);
    }

    [Fact]
    public void It_names_both_rigs_because_neither_number_alone_says_which_to_fix()
    {
        // "This is the wrong rig" leaves an operator holding twenty-two identical
        // machines and no way to tell which token is on this one.
        var verdict = RigIdentity.Mismatch(4, Rig(7, "Rig 07 - corner"));

        Assert.Contains("rig 04", verdict.Instruction, StringComparison.Ordinal);
        Assert.Contains("rig 07", verdict.Instruction, StringComparison.Ordinal);
        Assert.Contains("Rig 07 - corner", verdict.Instruction, StringComparison.Ordinal);
    }
}
