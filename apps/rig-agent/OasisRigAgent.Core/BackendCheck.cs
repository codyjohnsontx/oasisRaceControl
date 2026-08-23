using System.Net;

namespace OasisRigAgent.Core;

/// <summary>The verdict of one <c>--check-backend</c> run.</summary>
public sealed record BackendCheckResult(string Message, int ExitCode);

/// <summary>
/// Answers "does this rig's identity work?" on the spot, for whoever is enrolling
/// the machine.
///
/// It exists because of how a rig is enrolled: a secret is typed at a command line,
/// once per computer, twenty-plus times in an evening, and nothing has ever checked
/// it. A mistyped character produces a rig that queues every lap of the night into
/// its own outbox, is absent from the staff dashboard rather than wrong on it, and
/// says "offline" on its own screen next to twenty machines saying "online" - which
/// reads as the network, not as this machine. The whole cost of that is paid by a
/// customer whose lap never appeared.
///
/// So the check is the same shape as <c>--check-sim</c>: a few seconds, at the rig,
/// against what is actually installed on it, over the same code path the agent uses
/// (<see cref="BackendClient"/> with this machine's own config). A pass is evidence
/// about the running agent, not about a separate implementation of the same idea.
///
/// It deliberately does no writing. <see cref="BackendClient.GetAssignmentAsync"/>
/// is the agent's only read-only authenticated call, so a check run against a live
/// venue rig cannot heartbeat over a real reading, end anybody's session, or put a
/// lap anywhere.
/// </summary>
public static class BackendCheck
{
    /// <summary>The backend answered and accepts this rig.</summary>
    public const int Pass = 0;

    /// <summary>
    /// The backend could not be reached at all: no network, no DNS, nothing
    /// listening, or a request that timed out.
    ///
    /// Separate from <see cref="IdentityRefused"/> because they call for opposite
    /// actions. This one is "the venue's network or the backend is down", which is
    /// nothing to do with this computer and is very often already known; the other
    /// is "walk back to this rig with the right token". They are indistinguishable
    /// on the rig's screen without this check, which is the whole reason it exists.
    /// </summary>
    public const int Unreachable = 7;

    /// <summary>
    /// The backend answered and will not accept this rig's identity.
    ///
    /// Deliberately not folded into <see cref="Unreachable"/>: waiting fixes that
    /// one and can never fix this one.
    /// </summary>
    public const int IdentityRefused = 8;

    /// <summary>
    /// The backend answered, accepted the token, and it is another rig's.
    ///
    /// Its own code because it is the only one of these an operator can create with
    /// a correct command typed at the wrong machine, and the only one where the
    /// install otherwise looks perfect: separating it from <see cref="Pass"/> is the
    /// whole point, and folding it into <see cref="IdentityRefused"/> would send
    /// somebody looking for a mistyped secret that does not exist.
    /// </summary>
    public const int WrongRig = 9;

    /// <summary>
    /// The check could not be run at all - no config file, or one missing the rig
    /// number, token or backend URL.
    ///
    /// The same code the agent itself exits with for a config it cannot read, so an
    /// installer that reads this answer does not have to learn two spellings of
    /// "this machine is not set up".
    /// </summary>
    public const int NotConfigured = 1;

    /// <param name="probe">Makes the one authenticated read. Pinned by tests.</param>
    public static async Task<BackendCheckResult> RunAsync(
        AgentConfig config,
        Func<CancellationToken, Task<AssignmentPoll>> probe,
        CancellationToken ct = default)
    {
        try
        {
            var poll = await probe(ct);

            // Accepting the token is not the same as being the right computer for
            // it, and this is the moment to find out: the alternative is a night of
            // laps landing on the rig across the room (RigIdentity).
            if (RigIdentity.Check(config.RigNumber, poll.Rig) is { } mixup)
                return new BackendCheckResult($"Backend check: WRONG RIG - {mixup.Instruction}", WrongRig);

            return new BackendCheckResult(
                $"Backend check: ACCEPTED - rig {config.RigNumber:D2} is recognised by "
                + $"{config.BackendBaseUrl}. Laps from this computer will be scored.",
                Pass);
        }
        catch (BackendRejectedException rejected)
        {
            return new BackendCheckResult($"Backend check: REFUSED - {rejected.Verdict.Instruction}", IdentityRefused);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // The caller stopped the check. That is not an answer about the rig,
            // so it must not be reported as one.
            throw;
        }
        catch (OperationCanceledException)
        {
            // HttpClient reports its own timeout this way, and a timeout is the
            // backend being out of reach rather than a cancelled check.
            return new BackendCheckResult(Unreached(config, "it did not answer in time."), Unreachable);
        }
        catch (Exception ex)
        {
            return new BackendCheckResult(Unreached(config, ex.Message), Unreachable);
        }
    }

    /// <summary>The one authenticated read this check makes, kept here so the
    /// host and the tests cannot disagree about which call is safe to run against
    /// a rig with a customer on it.</summary>
    public static Func<CancellationToken, Task<AssignmentPoll>> ProbeWith(BackendClient client) =>
        client.GetAssignmentAsync;

    private static string Unreached(AgentConfig config, string why) =>
        $"Backend check: UNREACHABLE - {config.BackendBaseUrl} could not be reached from this "
        + $"computer: {Sentence(why)} This is the network or the backend, not this rig's token - the "
        + "token has not been judged either way. Check the machine's network, then run this again.";

    /// <summary>A framework message ends with a full stop or with a bracketed
    /// address, and the sentence after it has to read straight either way.</summary>
    private static string Sentence(string why)
    {
        var text = why.Trim();
        if (text.Length == 0) return "it did not say why.";
        return text[^1] is '.' or '!' or '?' ? text : text + ".";
    }
}
