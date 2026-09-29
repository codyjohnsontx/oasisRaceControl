using System.Text.Json.Nodes;
using OasisRigAgent.Core.Iracing;

namespace OasisRigAgent.Core;

/// <summary>
/// One RIG_HEARTBEAT, v2: what this agent knows about its rig right now, sent
/// once a minute so the server-side monitor can judge the rig without asking
/// it anything. Everything here is state the agent already holds or a counter
/// it keeps; building it touches no file but the outbox counts, and nothing
/// the sim is using.
///
/// Mirrors <c>heartbeatEvent</c> in apps/web/src/lib/events.ts; both ends of
/// the wire change together. Every field there is optional, so a backend that
/// predates v2 strips what it does not know and still records the rig as seen.
/// The bounds below are that schema's: one value past them fails the whole
/// batch, which for a heartbeat means the rig reads as silent.
///
/// It deliberately carries no driver name. The server knows the driver from
/// <see cref="AssignmentId"/>, and a heartbeat that never holds personal data
/// never needs redacting before it is shown to anything.
/// </summary>
public sealed record HeartbeatReport
{
    public const int MaxListItems = 10;
    public const int MaxNoticeLength = 200;
    public const int MaxVariableNameLength = 64;
    public const int MaxSessionNameLength = 120;

    public required string AgentVersion { get; init; }
    public required DateTimeOffset SentAt { get; init; }
    public DateTimeOffset? ProcessStartedAt { get; init; }
    public int? StartCount { get; init; }
    public required long OsUptimeS { get; init; }
    public required TelemetryMode TelemetryMode { get; init; }
    public required bool SimConnected { get; init; }
    public required bool TelemetryFaulted { get; init; }
    public IReadOnlyList<string> MissingVariables { get; init; } = Array.Empty<string>();
    public SessionCombo? Session { get; init; }
    public string? AssignmentId { get; init; }
    public required bool AssignmentKnown { get; init; }
    public int? PendingLaps { get; init; }
    public double? OldestPendingAgeS { get; init; }
    public int? RejectedLaps { get; init; }
    public required CheckoutDelivery Checkout { get; init; }
    public DateTimeOffset? LastLapCapturedAt { get; init; }
    public DateTimeOffset? LastLapPostedAt { get; init; }
    public required int SignInFailures { get; init; }
    public IReadOnlyList<SignInFailureKind> SignInFailureKinds { get; init; } = Array.Empty<SignInFailureKind>();
    public IReadOnlyList<string> Notices { get; init; } = Array.Empty<string>();
    public double? AgentCpuPercent { get; init; }
    public double? AgentMemoryMb { get; init; }
    public required bool ShuttingDown { get; init; }

    /// <summary>The event as it goes on the wire. A count the outbox could not
    /// answer is left out rather than guessed, so a failing disk still sends
    /// the heartbeat that says the rig is alive.</summary>
    public JsonObject ToEvent()
    {
        var json = new JsonObject
        {
            ["type"] = "RIG_HEARTBEAT",
            ["agentVersion"] = AgentVersion,
            ["sentAt"] = SentAt.ToString("o"),
        };
        if (ProcessStartedAt is { } started) json["processStartedAt"] = started.ToString("o");
        if (StartCount is { } starts) json["startCount"] = starts;
        json["osUptimeS"] = OsUptimeS;
        json["telemetryMode"] = TelemetryMode switch
        {
            TelemetryMode.Iracing => "iracing",
            TelemetryMode.Simulated => "simulated",
            _ => "none",
        };
        json["simConnected"] = SimConnected;
        json["telemetryFaulted"] = TelemetryFaulted;
        json["missingVariables"] = Strings(MissingVariables, MaxVariableNameLength);
        json["session"] = Session is { } s
            ? new JsonObject
            {
                ["trackName"] = Clip(s.TrackDisplayName, MaxSessionNameLength),
                ["trackConfig"] = s.TrackConfigName is null ? null : Clip(s.TrackConfigName, MaxSessionNameLength),
                ["carName"] = Clip(s.CarScreenName, MaxSessionNameLength),
            }
            : null;
        json["assignmentId"] = AssignmentId;
        json["assignmentKnown"] = AssignmentKnown;
        if (PendingLaps is { } pending) json["pendingLaps"] = pending;
        if (PendingLaps is not null) json["oldestPendingAgeS"] = OldestPendingAgeS is { } age ? Math.Round(Math.Max(0, age), 1) : null;
        if (RejectedLaps is { } rejected) json["rejectedLaps"] = rejected;
        json["checkout"] = Checkout switch
        {
            CheckoutDelivery.Queued => "queued",
            CheckoutDelivery.NotQueued => "not_queued",
            _ => "none",
        };
        json["lastLapCapturedAt"] = LastLapCapturedAt?.ToString("o");
        json["lastLapPostedAt"] = LastLapPostedAt?.ToString("o");
        json["signInFailures"] = SignInFailures;
        var kinds = new JsonArray();
        foreach (var kind in SignInFailureKinds.Distinct().Take(MaxListItems)) kinds.Add(kind.WireName());
        json["signInFailureKinds"] = kinds;
        json["notices"] = Strings(Notices, MaxNoticeLength);
        if (AgentCpuPercent is { } cpu) json["agentCpuPercent"] = cpu;
        if (AgentMemoryMb is { } memory) json["agentMemoryMb"] = memory;
        json["shuttingDown"] = ShuttingDown;
        return json;
    }

    /// <summary>The newest items, clipped, because the backend refuses the whole
    /// batch over one item past its bound and a lost heartbeat costs more than
    /// a truncated line.</summary>
    private static JsonArray Strings(IReadOnlyList<string> items, int maxLength)
    {
        var array = new JsonArray();
        foreach (var item in items.Skip(Math.Max(0, items.Count - MaxListItems)))
            array.Add(Clip(item, maxLength));
        return array;
    }

    private static string Clip(string text, int maxLength)
        => text.Length <= maxLength ? text : text[..(maxLength - 3)] + "...";
}

/// <summary>
/// When the next heartbeat goes. Once a minute while the backend answers -
/// the owner's cadence, and what the monitor's two-minute silence rule is
/// sized against. One heartbeat the backend did not receive still waits the
/// minute, so a blip cannot outlast that rule. From the second in a row the
/// gap doubles (two, four, then five minutes at most) with a little jitter,
/// so an offline rig spends nothing on a network that is not there and a
/// whole venue coming back does not knock in step. The first heartbeat that
/// gets through puts it straight back to a minute. The poll or the flush
/// bringing the link back wakes the heartbeat at once, once per streak of
/// failures, without resetting the count (see
/// <c>AgentService.HeartbeatLoop</c>).
///
/// Only the heartbeat backs off. The assignment poll and the lap flush keep
/// their intervals, because they carry the laps and the sign-out and have to
/// notice the link return within seconds, not minutes.
/// </summary>
public static class HeartbeatSchedule
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan MaxInterval = TimeSpan.FromSeconds(300);
    public const double Jitter = 0.10;

    /// <param name="consecutiveFailures">Heartbeats in a row the backend did not
    /// receive; zero after one it did.</param>
    /// <param name="jitterUnit">A value in [0, 1), from Random in the agent and
    /// fixed in tests.</param>
    public static TimeSpan Delay(int consecutiveFailures, double jitterUnit)
    {
        if (consecutiveFailures <= 1) return Interval;
        // Capped before it is doubled any further, so a night-long outage
        // cannot overflow the shift.
        var doubled = Interval.TotalSeconds * Math.Pow(2, Math.Min(consecutiveFailures - 1, 8));
        var seconds = Math.Min(doubled, MaxInterval.TotalSeconds);
        return TimeSpan.FromSeconds(seconds * (1 + (jitterUnit * 2 - 1) * Jitter));
    }
}

/// <summary>Why a walk-up sign-in on this rig did not seat anyone. Counted
/// per heartbeat so the monitor can see a rig where nobody can get in -
/// the PIN that would not match at the 2026-09-27 event - without the rig
/// saying who was trying.</summary>
public enum SignInFailureKind
{
    /// <summary>A name the backend will not take, or a name registered to a
    /// different PIN.</summary>
    WrongPinOrName,
    /// <summary>The name is locked after too many wrong PINs.</summary>
    Locked,
    /// <summary>The backend's per-network limit on sign-ins or check-ins.</summary>
    RateLimited,
    /// <summary>The backend could not be reached at all.</summary>
    Unreachable,
    /// <summary>Any other refusal: a server error, the rig's QR token not
    /// registered, a check-in that did not complete.</summary>
    Other,
}

public static class SignInFailureKindExtensions
{
    /// <summary>The name in <c>SIGN_IN_FAILURE_KINDS</c> (apps/web/src/lib/events.ts).</summary>
    public static string WireName(this SignInFailureKind kind) => kind switch
    {
        SignInFailureKind.WrongPinOrName => "wrong_pin_or_name",
        SignInFailureKind.Locked => "locked",
        SignInFailureKind.RateLimited => "rate_limited",
        SignInFailureKind.Unreachable => "unreachable",
        _ => "other",
    };
}

/// <summary>
/// What a telemetry source can say about the sim beyond laps, for the
/// heartbeat: which session it is in, the variables its build does not
/// publish, and whether lap reading stopped for good. Optional - the
/// simulated and null sources have none of it and report none.
/// <see cref="Iracing.IracingTelemetrySource"/> already raises all four for
/// the console, so the agent listens to the same events rather than asking
/// the sim anything more.
/// </summary>
public interface ISimHealthSource
{
    /// <summary>iRacing connected (true) or went away (false).</summary>
    event Action<bool>? ConnectionChanged;
    /// <summary>The session names a different track and car.</summary>
    event Action<SessionCombo>? ComboChanged;
    /// <summary>Watched variables this iRacing build does not publish, once per connection.</summary>
    event Action<IReadOnlyList<string>>? MissingVariables;
    /// <summary>Lap reading stopped until the program is restarted.</summary>
    event Action<Exception>? Faulted;
}
