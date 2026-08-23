namespace OasisRigAgent.Core;

/// <summary>
/// Why the backend will not deal with this rig, in two lengths - the same split,
/// for the same reason, as <see cref="IRacing.SimReachVerdict"/> and
/// <see cref="IRacing.SimDecodeVerdict"/>.
///
/// <see cref="Summary"/> goes on the rig's status line, where it sits beside the
/// other reasons a rig is up and delivering nothing and has to be readable at a
/// glance. <see cref="Instruction"/> goes in <c>logs\agent.log</c> and
/// <c>--check-backend</c>, where somebody is reading deliberately because they
/// are fixing this machine.
/// </summary>
public sealed record BackendReachVerdict(string Summary, string Instruction);

/// <summary>
/// Separates "the venue's network is down" from "this rig's identity is not the
/// one the backend was given".
///
/// Every backend call the agent makes funnels through one catch-everything, and
/// before this it produced one answer: offline. That answer is true of a rig
/// whose wifi dropped and it is honest - the connection comes back and the queue
/// drains. It is not true of a rig whose token is wrong. There the network is
/// fine, the backend is answering in milliseconds, and the refusal is permanent:
/// no lap is ever delivered, nobody is ever checked in, the machine never appears
/// on <c>/staff</c> at all, and waiting cannot fix any of it.
///
/// The two are told apart by exactly one thing - an HTTP status the backend
/// chose - and they look identical on the rig, so the rig has to say which. The
/// reason it matters at this venue is enrolment: a rig's identity is a secret
/// typed at a command line, once per machine, twenty-plus times in an evening.
/// A single mistyped character produces a machine that says "offline" all night
/// beside twenty that say "online", and an operator who reads that as the network
/// has no reason to look at this one again.
///
/// The backend cannot report this itself. A rig it will not authenticate cannot
/// heartbeat, so from <c>/staff</c> it is a rig nobody has heard from - which is
/// the same thing an unplugged machine looks like. This verdict exists on the rig
/// because the rig is the only place that knows.
/// </summary>
public static class BackendReach
{
    /// <summary>
    /// The backend answered and does not accept this rig's identity: a 401 or a 403.
    ///
    /// Deliberately one verdict for both statuses. They differ in what the server
    /// meant (no credentials it recognises, versus credentials it will not act on)
    /// and not at all in what the person standing at the rig does about it, which
    /// is check this machine's token against the one the rig was given.
    /// </summary>
    public static readonly BackendReachVerdict Refused = new(
        "the backend does not accept this rig's token - it is not this rig's, or the rig was removed",
        "The backend is reachable and refused this rig's identity. The token in this computer's "
        + "agent.config.json is not the one the backend holds for this rig, so no lap will ever be "
        + "delivered from here and nobody can be checked in - and because this rig cannot heartbeat, "
        + "the staff dashboard shows it as a machine nobody has heard from rather than as this. "
        + "Nothing about waiting fixes it. Re-enrol this rig with its own token: "
        + "Install-RigAgent.ps1 -RigNumber <n> -RigToken <token> -BackendBaseUrl <url>. "
        + "Laps already queued on this machine deliver themselves as soon as it is right.");

    /// <summary>
    /// Whether an HTTP status is the backend refusing this rig's identity, as
    /// opposed to a server having a bad moment (5xx) or refusing one document
    /// (400, which <see cref="BackendClient.SendLapsAsync"/> owns).
    /// </summary>
    public static bool IsIdentityRefusal(System.Net.HttpStatusCode status) =>
        status is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden;
}

/// <summary>
/// Thrown when the backend refused this rig's identity, carrying the verdict that
/// explains it.
///
/// It is an exception rather than a return value because every call the agent
/// makes has to raise it and they return five different things. It derives from
/// <see cref="HttpRequestException"/> so that anything already treating a failed
/// backend call as offline keeps working unchanged - the rig stays offline, its
/// laps stay queued, and the only thing that is new is that it can say why.
/// </summary>
public sealed class BackendRejectedException : HttpRequestException
{
    public BackendRejectedException(System.Net.HttpStatusCode status)
        : base($"the backend refused this rig's token (HTTP {(int)status})", null, status)
    {
        Verdict = BackendReach.Refused;
    }

    public BackendReachVerdict Verdict { get; }
}
