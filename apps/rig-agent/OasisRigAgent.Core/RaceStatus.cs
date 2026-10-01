using System.Net;
using System.Text.Json.Nodes;

namespace OasisRigAgent.Core;

/// <summary>
/// One rig's live race status: its own car as iRacing sees it right now, for
/// the league-night race board. Every rig reports only itself, so identity
/// comes from the rig's assignment on the server exactly as a lap's does, and
/// the row carries no driver or iRacing account name.
///
/// Mirrors <c>raceStatusEvent</c> in apps/web/src/lib/events.ts; both ends of
/// the wire change together. Every key is always sent, null included - the
/// schema's nullable fields are not optional. The bounds are that schema's:
/// the body is validated whole, so one value past them is a 400 and the car
/// vanishes from the board. So iRacing's sentinels (position 0, lap time -1,
/// 32767 laps, 604800 s) go out as null and everything else is clamped to them
/// before it is sent - by <see cref="Iracing.RaceStatusSampler"/>, the one
/// place a row is built - rather than discovered there.
/// </summary>
public sealed record RaceStatusReport
{
    public const int MaxCars = 64;
    public const int MaxSessionNum = 63;
    public const int MaxLaps = 32_767;
    public const double MaxSessionSeconds = 7 * 24 * 60 * 60;
    public const double MaxGapSeconds = 86_400;
    public const int MaxLapTimeMs = 30 * 60_000;
    public const int MaxIncidents = 9_999;
    public const int MaxSessionTypeLength = 40;

    public required DateTimeOffset SampledAt { get; init; }
    public required int SessionUniqueId { get; init; }
    public required int SessionNum { get; init; }
    public string? SessionType { get; init; }
    public required int SessionState { get; init; }
    public required uint SessionFlags { get; init; }
    public double? SessionTimeRemainS { get; init; }
    public int? SessionLapsRemain { get; init; }
    public required int CarIdx { get; init; }
    public int? Position { get; init; }
    public int? ClassPosition { get; init; }
    public int? Lap { get; init; }
    public int? LapsCompleted { get; init; }
    public double? LapDistPct { get; init; }
    /// <summary><c>CarIdxF2Time[PlayerCarIdx]</c> as read: seconds behind the
    /// leader in a race, a lap time in any other session. The server decides
    /// which from <see cref="SessionType"/>.</summary>
    public double? GapToLeaderS { get; init; }
    public int? LastLapMs { get; init; }
    public int? BestLapMs { get; init; }
    public required bool OnPitRoad { get; init; }
    public required int Incidents { get; init; }

    /// <summary>The same car in the same place: everything but when it was read
    /// and the session clock, which moves every sample whether or not anything
    /// on the board would. A row that is the same is not sent again until
    /// <see cref="RaceStatusThrottle.KeepAlive"/>.</summary>
    public bool SameRowAs(RaceStatusReport other)
        => this with { SampledAt = default, SessionTimeRemainS = null }
           == other with { SampledAt = default, SessionTimeRemainS = null };

    public JsonObject ToJson() => new()
    {
        ["sampledAt"] = SampledAt.ToString("o"),
        ["sessionUniqueId"] = SessionUniqueId,
        ["sessionNum"] = SessionNum,
        ["sessionType"] = SessionType,
        ["sessionState"] = SessionState,
        ["sessionFlags"] = SessionFlags,
        ["sessionTimeRemainS"] = SessionTimeRemainS,
        ["sessionLapsRemain"] = SessionLapsRemain,
        ["carIdx"] = CarIdx,
        ["position"] = Position,
        ["classPosition"] = ClassPosition,
        ["lap"] = Lap,
        ["lapsCompleted"] = LapsCompleted,
        ["lapDistPct"] = LapDistPct,
        ["gapToLeaderS"] = GapToLeaderS,
        ["lastLapMs"] = LastLapMs,
        ["bestLapMs"] = BestLapMs,
        ["onPitRoad"] = OnPitRoad,
        ["incidents"] = Incidents,
    };
}

/// <summary>
/// Something that can say where this rig's car is in the session right now -
/// the iRacing source. Null whenever the sim is not in a session, so nothing
/// is reported between sessions. Optional, like <see cref="ISimHealthSource"/>:
/// the simulated and null sources report no race.
/// </summary>
public interface IRaceStatusSource
{
    RaceStatusReport? RaceStatus(DateTimeOffset sampledAt);
}

/// <summary>
/// When a race status goes. Sampled every <see cref="Interval"/>; a row that
/// changed goes at once, and an unchanged one - a car parked in the pits or the
/// garage - goes again once <see cref="KeepAlive"/> has passed, because the
/// live feed dims a rig it has not heard from in 15 s and drops it at 60 s. A
/// report the backend did not take is not recorded as sent, so the next sample
/// the reporter posts goes whatever it holds. Pure, and only ever used from the
/// one loop.
/// </summary>
public sealed class RaceStatusThrottle
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(2.5);

    /// <summary>Under the contract's ten-second ceiling on silence by a whole
    /// interval, so the resend lands on the third tick (7.5 s), not the fourth.</summary>
    public static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(7);

    private RaceStatusReport? _lastSent;
    private long _lastSentAtMs;

    public bool ShouldSend(RaceStatusReport report, long nowMs)
        => _lastSent is null
           || !report.SameRowAs(_lastSent)
           || nowMs - _lastSentAtMs >= (long)KeepAlive.TotalMilliseconds;

    public void Sent(RaceStatusReport report, long nowMs)
    {
        _lastSent = report;
        _lastSentAtMs = nowMs;
    }
}

/// <summary>
/// The agent's race-status loop body: sample, decide, post, and forget. There
/// is no outbox and no retry - a position is worth something for seconds, so a
/// report that fails is dropped and a fresh sample goes in its place on the
/// next interval: one timeout or 5xx mid-race costs one sample, not a car
/// dimmed on the board. Only a 404 (a site without the route) or
/// <see cref="FailuresBeforeBackoff"/> failures in a row hold the reporter
/// back for <see cref="FailureBackoff"/>, so a site that cannot take the
/// reports hears from each rig twice a minute, not every interval. Each post
/// is cut off at one <see cref="RaceStatusThrottle.Interval"/>, so a slow
/// backend costs one sample, never a queue of them. It never touches the
/// agent's online/offline state, for the heartbeat's reason: a site that does
/// not have the route yet would otherwise flap the rig's status line every few
/// seconds.
/// </summary>
public sealed class RaceStatusReporter
{
    public static readonly TimeSpan FailureBackoff = TimeSpan.FromSeconds(30);
    public const int FailuresBeforeBackoff = 3;

    private readonly IRaceStatusSource _source;
    private readonly BackendClient _client;
    private readonly Action<string> _notice;
    private readonly Func<long> _nowMs;
    private readonly RaceStatusThrottle _throttle = new();
    private bool _failing;
    private int _consecutiveFailures;
    private long _resumeAtMs = long.MinValue;

    /// <param name="notice">One line when the reporter starts backing off, and
    /// not again until a report has got through.</param>
    /// <param name="nowMs">A monotonic millisecond clock; defaults to <see cref="Environment.TickCount64"/>.</param>
    public RaceStatusReporter(IRaceStatusSource source, BackendClient client, Action<string> notice, Func<long>? nowMs = null)
    {
        _source = source;
        _client = client;
        _notice = notice;
        _nowMs = nowMs ?? (() => Environment.TickCount64);
    }

    public async Task TickAsync(CancellationToken ct)
    {
        var now = _nowMs();
        if (now < _resumeAtMs) return;
        var report = _source.RaceStatus(DateTimeOffset.UtcNow);
        if (report is null || !_throttle.ShouldSend(report, now)) return;

        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct);
        bounded.CancelAfter(RaceStatusThrottle.Interval);
        try
        {
            await _client.PostRaceStatusAsync(report, bounded.Token);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _consecutiveFailures++;
            if (ex is HttpRequestException { StatusCode: HttpStatusCode.NotFound }
                || _consecutiveFailures >= FailuresBeforeBackoff)
            {
                _resumeAtMs = now + (long)FailureBackoff.TotalMilliseconds;
                if (!_failing)
                {
                    _failing = true;
                    _notice($"[agent] live race position is not reaching the site ({Describe(ex)}); "
                        + $"laps are unaffected, and it tries again every {FailureBackoff.TotalSeconds:0} s.");
                }
            }
            return;
        }
        _consecutiveFailures = 0;
        _failing = false;
        _throttle.Sent(report, now);
    }

    private static string Describe(Exception ex) => ex switch
    {
        HttpRequestException { StatusCode: { } status } => $"HTTP {(int)status}",
        OperationCanceledException => "timed out",
        _ => ex.Message,
    };
}
