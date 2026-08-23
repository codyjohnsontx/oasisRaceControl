namespace OasisRigAgent.Core;

/// <summary>Which rig the backend says the token on this computer belongs to.
/// Null everywhere it is optional, because a backend older than this agent does
/// not answer it and a rig must never accuse itself on a missing answer.</summary>
public sealed record BackendRigIdentity(int Number, string DisplayName);

/// <summary>
/// Why this computer must not score, in two lengths - the same split, for the
/// same reason, as <see cref="BackendReachVerdict"/>: the summary goes on the
/// rig's status line, the instruction into <c>logs\agent.log</c> and
/// <c>--check-backend</c>, where somebody is reading because they are fixing
/// this machine.
/// </summary>
public sealed record RigIdentityVerdict(string Summary, string Instruction);

/// <summary>
/// Separates "this computer is rig 4" from "this computer holds rig 4's token",
/// which enrolment can make two different things.
///
/// A rig's bearer token is the whole of its identity to the backend. Laps
/// arrive, the token names a rig, and whoever is checked in there is credited.
/// The rig number in <c>agent.config.json</c> never travels: it is what the
/// machine calls itself on its own screen, in its own log, and nowhere else. So
/// the two can disagree, and one command does it - twenty-plus rigs are enrolled
/// from twenty-plus per-rig install commands typed in one evening, and pasting
/// the line meant for the machine next to this one is a single wrong paste with
/// no error anywhere.
///
/// What that machine then does is worse than not working. It works: it
/// authenticates, it heartbeats, it polls, it delivers laps. They are credited
/// to the other rig, to the customer checked in over there, while the customer
/// sitting at this one scanned this station's QR code and watches a leaderboard
/// their laps never reach. Both customers' nights are wrong, the screen at each
/// machine says the number somebody typed, and there is nothing in the database
/// that looks unusual.
///
/// Neither side can see it alone. The backend sees a valid token making valid
/// requests; the number the machine calls itself never reaches it. The machine
/// knows which station it is standing at and cannot see whose token it holds.
/// The comparison is the fix, and it can only happen here - which is why the
/// assignment poll now carries the rig the backend authenticated
/// (<c>apps/web/src/app/api/agent/assignment/route.ts</c>).
/// </summary>
public static class RigIdentity
{
    /// <summary>
    /// Compares the number this computer was installed as with the rig the
    /// backend says its token belongs to.
    ///
    /// Answers null for agreement and for every kind of not-knowing: a backend
    /// that does not report the rig (one older than this agent, mid-deploy), or
    /// a number that is not a real rig number. A rig that stops scoring must do
    /// it on an answer, never on a silence - the failure this exists to catch is
    /// rare and the fleet is twenty-plus machines, so a false accusation would
    /// cost more nights than the real one.
    /// </summary>
    public static RigIdentityVerdict? Check(int configuredNumber, BackendRigIdentity? reported)
    {
        if (reported is null || configuredNumber <= 0 || reported.Number <= 0) return null;
        if (reported.Number == configuredNumber) return null;
        return Mismatch(configuredNumber, reported);
    }

    /// <summary>The verdict for a computer holding another rig's token, naming
    /// both numbers: which one to fix is not obvious from either alone, and the
    /// person reading it is standing in front of one of them.</summary>
    public static RigIdentityVerdict Mismatch(int configuredNumber, BackendRigIdentity reported) => new(
        $"WRONG RIG - this computer is set up as rig {configuredNumber:D2} but its token belongs to "
        + $"rig {reported.Number:D2} ({reported.DisplayName})",
        $"This computer calls itself rig {configuredNumber:D2}, and the token in its "
        + $"agent.config.json is the one the backend holds for rig {reported.Number:D2} "
        + $"({reported.DisplayName}) - almost always an install command meant for another "
        + "machine, pasted here. Left alone it does not fail: every lap driven at this station "
        + $"is credited to rig {reported.Number:D2} and to whoever is checked in there, while the "
        + "customer at this one never sees a time. So this rig has stopped delivering laps and "
        + $"stopped claiming rig {reported.Number:D2}, and the machine that really is rig "
        + $"{reported.Number:D2} keeps scoring. Re-enrol this computer with its own token: "
        + "Install-RigAgent.ps1 -RigNumber <n> -RigToken <token> -BackendBaseUrl <url>. Laps "
        + "already queued here deliver themselves as soon as it is right.");
}
