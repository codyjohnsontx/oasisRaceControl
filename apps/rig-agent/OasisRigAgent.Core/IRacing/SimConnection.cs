namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// An open, read-only attachment to a running sim: the memory the sim publishes
/// telemetry into, plus the signal it raises when a new frame is ready.
///
/// This is the seam that keeps every lap rule testable without Windows and
/// without iRacing. The production implementation
/// (<see cref="WindowsSimConnectionFactory"/>) is the only code in the agent that
/// touches an operating-system handle; everything above it - framing, session
/// metadata, and the lap rules themselves - runs against bytes and is exercised
/// in CI on any machine.
/// </summary>
public interface ISimConnection : IDisposable
{
    /// <summary>The sim's published memory, opened for reading only.</summary>
    IReadOnlyMemoryReader Reader { get; }

    /// <summary>
    /// Waits for the sim to publish its next frame. Returns true if it did, false
    /// if <paramref name="timeout"/> elapsed first.
    ///
    /// A false return is normal, not a fault: the sim stops publishing whenever
    /// the driver is in a menu. The caller re-reads anyway, because that is how
    /// it notices the sim has gone away.
    /// </summary>
    bool WaitForFrame(TimeSpan timeout);
}

/// <summary>
/// Opens a connection to the sim if it is running.
/// </summary>
public interface ISimConnectionFactory
{
    /// <summary>
    /// Attaches to the running sim, or returns null when there is nothing to
    /// attach to.
    ///
    /// "The sim is not running" is the overwhelmingly common case on a venue rig -
    /// it is how every machine sits between customers - so it is an ordinary null
    /// rather than an exception. A null that is <i>not</i> that is explained by
    /// <see cref="UnreachableReason"/> rather than thrown, because the conditions
    /// it covers are settled facts about how this machine was set up: throwing
    /// would put the same unactionable line in the log every two seconds for the
    /// life of the rig. Anything genuinely unexpected still throws.
    /// </summary>
    ISimConnection? TryConnect();

    /// <summary>
    /// Why the last <see cref="TryConnect"/> returned null, when the answer is
    /// something other than "iRacing is closed". Null the rest of the time, which
    /// is most of a rig's day.
    ///
    /// This exists because the two install mistakes that leave a machine permanently
    /// unable to see its simulator - running the agent outside the signed-in user's
    /// Windows session, and running it as another user - are indistinguishable from
    /// an idle rig from every screen the venue has. See <see cref="SimReach"/>.
    ///
    /// Only ever read after a failed attach, so it cannot withhold a lap from a rig
    /// that is reading its sim.
    /// </summary>
    SimReachVerdict? UnreachableReason => null;
}
