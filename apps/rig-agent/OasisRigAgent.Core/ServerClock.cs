using System.Globalization;

namespace OasisRigAgent.Core;

/// <summary>
/// How far this rig's clock is from the backend's, and the correction that puts
/// a lap on the right driver and the right night despite it.
///
/// A lap carries the moment it was driven, stamped by the machine that drove it.
/// The backend then answers two questions with that timestamp: which check-in
/// owns the lap (its window has to contain the completion time) and which
/// venue-local day it belongs to. Both are decided against the server's clock,
/// so a rig whose own clock is wrong produces:
///
/// * a rig running behind - laps stamped before the driver checked in, refused
///   as <c>assignment_mismatch</c>. That refusal is final, so the customer's
///   time is gone; and
/// * a rig running ahead - laps stamped past midnight, stored and attributed
///   correctly but filtered off tonight's leaderboard and the TV board.
///
/// Neither shows up as an error anywhere. The rig is online, the simulator is
/// readable, the lap queue drains. Across twenty-plus venue machines - some of
/// which will be old shop PCs with a dying CMOS battery or no reliable time
/// sync - that is the difference between a leaderboard and a support call.
///
/// So the agent measures the difference rather than trusting the machine it
/// runs on. Every backend response carries a <c>Date</c> header; comparing it to
/// the local clock at the midpoint of the round trip gives the offset, and laps
/// are stamped through it. Nothing is sent to the sim and no clock is changed -
/// fixing the machine is still a job for whoever maintains the rig, which is why
/// the reading is also written to the log and shown on the rig's own screen.
/// </summary>
public sealed class ServerClock
{
    /// <summary>
    /// Below this, the difference is measurement noise rather than a wrong clock:
    /// the <c>Date</c> header is whole seconds and the round trip is not
    /// instant. A healthy rig therefore keeps stamping laps with its own clock
    /// exactly, so rolling this out changes nothing on the machines that are
    /// fine - and the backend already allows five seconds of slack on a
    /// check-in window, which this sits well inside.
    /// </summary>
    public static readonly TimeSpan Deadband = TimeSpan.FromSeconds(2);

    /// <summary>
    /// A reading is only as precise as half the round trip, so a slow response is
    /// not evidence about a clock. Dropping those keeps a venue with a bad few
    /// seconds of internet from inventing a skew - it just measures again on the
    /// next call, which is at most five seconds away.
    /// </summary>
    public static readonly TimeSpan MaxRoundTrip = TimeSpan.FromSeconds(4);

    /// <summary>
    /// <c>Date</c> is truncated to the second, so the server's real time is
    /// somewhere in the second that follows it. Taking the middle removes the
    /// half-second of bias that would otherwise be baked into every reading.
    /// </summary>
    private static readonly TimeSpan DateHeaderMidpoint = TimeSpan.FromMilliseconds(500);

    private long _offsetTicks;
    private long _measurements;

    /// <summary>
    /// Raised when the correction being applied changes materially. Fired from
    /// whichever thread made the backend call, so a subscriber has to be
    /// thread-safe; the agent uses it to write one log line rather than one per
    /// request.
    /// </summary>
    public event Action<ServerClock>? Changed;

    /// <summary>Backend time minus this machine's time. Positive means this rig is
    /// running behind the backend. Zero until a reading says otherwise.</summary>
    public TimeSpan Offset => TimeSpan.FromTicks(Interlocked.Read(ref _offsetTicks));

    /// <summary>True once a backend response has been measured against. Before that
    /// the agent is stamping laps with an unchecked clock, which is worth being able
    /// to say out loud.</summary>
    public bool Measured => Interlocked.Read(ref _measurements) > 0;

    /// <summary>True when this machine's clock is far enough out to be worth a
    /// person's attention. The laps are already corrected; the machine is not.</summary>
    public bool IsSkewed => Offset != TimeSpan.Zero;

    /// <summary>The moment the backend would call <paramref name="local"/>.</summary>
    public DateTimeOffset Correct(DateTimeOffset local) => local + Offset;

    /// <summary>
    /// Record one completed round trip.
    /// </summary>
    /// <param name="serverDate">The response's <c>Date</c> header.</param>
    /// <param name="sentAt">This machine's clock immediately before the request.</param>
    /// <param name="receivedAt">This machine's clock immediately after the response.</param>
    /// <returns>False when the round trip was too slow or ran backwards to be
    /// evidence about anything, in which case the previous correction stands.</returns>
    public bool Observe(DateTimeOffset serverDate, DateTimeOffset sentAt, DateTimeOffset receivedAt)
    {
        var roundTrip = receivedAt - sentAt;
        if (roundTrip < TimeSpan.Zero || roundTrip > MaxRoundTrip) return false;

        var localMidpoint = sentAt + (roundTrip / 2);
        var measured = serverDate + DateHeaderMidpoint - localMidpoint;

        // Reported as no correction at all inside the deadband, rather than as a
        // small one: a lap's timestamp should be this machine's own reading
        // unless that reading is actually wrong.
        var reported = measured.Duration() < Deadband ? TimeSpan.Zero : measured;

        var previous = TimeSpan.FromTicks(Interlocked.Exchange(ref _offsetTicks, reported.Ticks));
        var first = Interlocked.Increment(ref _measurements) == 1;

        if ((first && reported != TimeSpan.Zero) || (reported - previous).Duration() >= Deadband)
        {
            try { Changed?.Invoke(this); }
            catch { /* a rig's log must never fail a backend call */ }
        }

        return true;
    }

    /// <summary>How this rig's clock reads to a person, e.g. "3m 12s behind".
    /// Null when there is nothing to say.</summary>
    public string? Describe()
    {
        var offset = Offset;
        if (offset == TimeSpan.Zero) return null;
        var direction = offset > TimeSpan.Zero ? "behind" : "ahead of";
        return $"{Humanize(offset.Duration())} {direction} the venue's";
    }

    private static string Humanize(TimeSpan raw)
    {
        // A reading is a second's worth of precision at best, so the sub-second
        // remainder is noise that reads as an error: a machine exactly six hours
        // out would otherwise be reported to the operator as "5h 59m".
        var span = TimeSpan.FromSeconds(Math.Round(raw.TotalSeconds));
        if (span.TotalDays >= 1) return $"{(int)span.TotalDays}d {span.Hours}h";
        if (span.TotalHours >= 1) return $"{(int)span.TotalHours}h {span.Minutes}m";
        if (span.TotalMinutes >= 1) return $"{(int)span.TotalMinutes}m {span.Seconds}s";
        return span.TotalSeconds.ToString("0.#", CultureInfo.InvariantCulture) + "s";
    }
}

/// <summary>
/// Measures <see cref="ServerClock"/> off every backend response.
///
/// It sits in the HTTP pipeline rather than inside <see cref="BackendClient"/> so
/// that every call the agent makes is a reading - the heartbeat every thirty
/// seconds, the driver poll every ten, the lap flush every five - and so a call
/// added later is one too without anybody remembering to wire it up. It reads a
/// header and nothing else: it never alters a request, never fails one, and a
/// response without a usable <c>Date</c> simply is not a reading.
/// </summary>
public sealed class ServerClockHandler : DelegatingHandler
{
    private readonly ServerClock _clock;
    private readonly Func<DateTimeOffset> _localNow;

    public ServerClockHandler(ServerClock clock, HttpMessageHandler? inner = null, Func<DateTimeOffset>? localNow = null)
    {
        _clock = clock;
        _localNow = localNow ?? (() => DateTimeOffset.UtcNow);
        InnerHandler = inner ?? new HttpClientHandler();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var sentAt = _localNow();
        var response = await base.SendAsync(request, ct).ConfigureAwait(false);
        var receivedAt = _localNow();

        // Errors are readings too: an offline rig is exactly the machine whose
        // clock nobody has checked, and a 401 or a 500 still carries the header.
        if (response.Headers.Date is { } date) _clock.Observe(date, sentAt, receivedAt);

        return response;
    }
}
