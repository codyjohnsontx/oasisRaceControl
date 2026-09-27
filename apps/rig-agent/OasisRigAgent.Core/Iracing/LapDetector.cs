namespace OasisRigAgent.Core.Iracing;

/// <summary>
/// One tick of the telemetry the detector looks at. Every field is nullable
/// because a variable iRacing does not publish (older sim build, a renamed
/// channel) must degrade to "unknown", never to a crash on the rig.
/// </summary>
public sealed record TelemetryTick
{
    public int? LapCompleted { get; init; }
    public float? LapLastLapTime { get; init; }
    public int? Lap { get; init; }
    public bool? OnPitRoad { get; init; }
    public bool? IsOnTrack { get; init; }
    public bool? IsReplayPlaying { get; init; }
    public int? PlayerTrackSurface { get; init; }
    public int? EnterExitReset { get; init; }
    public int? PlayerCarMyIncidentCount { get; init; }
    public int? SessionNum { get; init; }
    public int? SessionUniqueId { get; init; }
    public int? PlayerCarIdx { get; init; }

    public static readonly IReadOnlySet<string> VariableNames = new HashSet<string>(
    [
        "LapCompleted", "LapLastLapTime", "Lap", "OnPitRoad", "IsOnTrack", "IsReplayPlaying",
        "PlayerTrackSurface", "EnterExitReset", "PlayerCarMyIncidentCount",
        "SessionNum", "SessionUniqueID", "PlayerCarIdx",
    ], StringComparer.Ordinal);

    public static TelemetryTick FromValues(IReadOnlyDictionary<string, object?> values) => new()
    {
        LapCompleted = Get<int>(values, "LapCompleted"),
        LapLastLapTime = Get<float>(values, "LapLastLapTime"),
        Lap = Get<int>(values, "Lap"),
        OnPitRoad = Get<bool>(values, "OnPitRoad"),
        IsOnTrack = Get<bool>(values, "IsOnTrack"),
        IsReplayPlaying = Get<bool>(values, "IsReplayPlaying"),
        PlayerTrackSurface = Get<int>(values, "PlayerTrackSurface"),
        EnterExitReset = Get<int>(values, "EnterExitReset"),
        PlayerCarMyIncidentCount = Get<int>(values, "PlayerCarMyIncidentCount"),
        SessionNum = Get<int>(values, "SessionNum"),
        SessionUniqueId = Get<int>(values, "SessionUniqueID"),
        PlayerCarIdx = Get<int>(values, "PlayerCarIdx"),
    };

    private static T? Get<T>(IReadOnlyDictionary<string, object?> values, string key) where T : struct
        => values.TryGetValue(key, out var v) && v is T t ? t : null;
}

/// <summary>What the detector decided about one crossing of the timing line.
/// Both outcomes are reported so the diagnostic mode and the agent log can say
/// why a lap the driver just saw on screen did or did not go anywhere.</summary>
public sealed record LapDecision(
    int LapCompleted,
    /// <summary>Set when the lap will be posted.</summary>
    LapCompleted? Lap,
    /// <summary>Set when it will not, in words staff can act on.</summary>
    string? SkipReason);

/// <summary>
/// Turns iRacing telemetry ticks into completed laps. Pure: no threads, no
/// shared memory, no clock beyond the tick counter it is handed, so every trap
/// below is covered by a unit test that feeds it ticks.
///
/// A lap is detected when `LapCompleted` goes up by one. Its time is
/// `LapLastLapTime`, which iRacing may publish a few ticks AFTER the counter
/// moves, so the detector waits for that channel to change from what it read
/// on the previous lap (or for a short deadline to pass) before it trusts the
/// value. The known traps and what happens to each:
///
///   - Out lap / no time: `LapLastLapTime` stays at or below zero (iRacing uses
///     -1 for "no time") - skipped.
///   - Pit lane: `OnPitRoad` seen at any tick of the lap - skipped. This also
///     drops the first crossing after leaving the box, which is an out lap.
///   - Reset / tow / garage: `Lap` going down, `EnterExitReset` changing, the
///     car leaving the world (`PlayerTrackSurface` -1) or `IsOnTrack` dropping
///     mid-lap - the next crossing is skipped as incomplete.
///   - Replay: ticks while `IsReplayPlaying` is true are ignored and the lap in
///     progress is marked incomplete.
///   - Session change: `SessionNum`, `SessionUniqueID` or `PlayerCarIdx` changing
///     re-baselines with no lap emitted.
///   - Counter going down (exit to the garage, reset, tow, session restart): a
///     resync, not a lap and not a jump. The next rise of any size - iRacing
///     briefly restoring the old count, seen on a real rig, or the out lap after
///     a garage exit or reset, which is never timed - quietly re-baselines with
///     no decision and raises <see cref="Resynced"/>. The `LapLastLapTime` shown
///     at the drop is remembered as stale, across <see cref="Reset"/> too, and a
///     later lap still showing it is skipped rather than posting that time twice.
///   - Counter jump of more than one (ticks missed): re-baselined, skipped.
///   - Pause: nothing crosses the line, so nothing happens; the lap time comes
///     from the sim's own clock, which pauses too.
///   - Incidents: the change in `PlayerCarMyIncidentCount` across the lap;
///     null when the channel is absent, and the backend then treats the lap as
///     clean.
///   - Disconnect / restart of iRacing: the owner calls <see cref="Reset"/>.
/// </summary>
public sealed class LapDetector
{
    /// <summary>How long to wait for `LapLastLapTime` to catch up with
    /// `LapCompleted`, in ticks (iRacing publishes 60 a second).</summary>
    public const int LapTimeDeadlineTicks = 180;

    private readonly Func<DateTimeOffset> _now;
    private readonly string _rigTag;
    private int _tick;

    private int? _lastLapCompleted;
    private float? _lastLapTimeSeen;
    private int? _lapStartIncidents;
    private (int? Num, int? Unique, int? CarIdx) _session;
    private bool _pitSeen, _incompleteSeen, _replaySeen;
    private int? _previousLap, _previousReset;
    private bool? _previousOnTrack;
    private Pending? _pending;
    private bool _resyncing;
    private float? _staleLapTime;

    private sealed record Pending(int LapCompleted, int Deadline, float? TimeBefore, int? Incidents,
        bool Pit, bool Incomplete, bool Replay);

    public LapDetector(Func<DateTimeOffset>? now = null, string? rigTag = null)
    {
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _rigTag = rigTag ?? Environment.MachineName;
    }

    /// <summary>The combo the next emitted lap is stamped with. Set from session
    /// info; a lap that completes while it is null is skipped and says so.</summary>
    public SessionCombo? Combo { get; set; }

    public event Action<LapDecision>? Decided;
    /// <summary>The counter came back up after going down and was re-baselined
    /// with no lap decided; the message says from what to what.</summary>
    public event Action<string>? Resynced;

    /// <summary>Forget everything: iRacing went away, or is starting over. The
    /// stale lap time is kept - the time channel can still show it afterwards.</summary>
    public void Reset()
    {
        _lastLapCompleted = null;
        _resyncing = false;
        _lastLapTimeSeen = null;
        _lapStartIncidents = null;
        _session = default;
        _pitSeen = _incompleteSeen = _replaySeen = false;
        _previousLap = _previousReset = null;
        _previousOnTrack = null;
        _pending = null;
    }

    public void Observe(TelemetryTick t)
    {
        _tick++;

        var session = (t.SessionNum, t.SessionUniqueId, t.PlayerCarIdx);
        if (_lastLapCompleted is not null && session != _session)
        {
            // A new session (or a new car) - laps do not carry across it.
            Reset();
        }
        _session = session;

        if (t.IsReplayPlaying == true)
        {
            _replaySeen = true;
            return;
        }

        TrackLapFlags(t);
        ObserveCounter(t);
        SettlePending(t);
        // Remembered AFTER this tick is judged, so a pending lap compares the
        // time channel against what it read before the counter moved - which is
        // what lets a time that lands on the very same tick be trusted at once.
        if (t.LapLastLapTime is float seen)
        {
            _lastLapTimeSeen = seen;
            if (seen > 0 && seen != _staleLapTime) _staleLapTime = null;
        }
    }

    private void ObserveCounter(TelemetryTick t)
    {
        if (t.LapCompleted is not int lapCompleted) return;

        if (_lastLapCompleted is null)
        {
            Baseline(lapCompleted, t);
            return;
        }
        if (lapCompleted == _lastLapCompleted) return;

        if (lapCompleted < _lastLapCompleted)
        {
            _pending = null;
            _resyncing = true;
            _staleLapTime = t.LapLastLapTime ?? _lastLapTimeSeen;
            Baseline(lapCompleted, t);
            return;
        }

        if (_resyncing)
        {
            _resyncing = false;
            _pending = null;
            Resynced?.Invoke($"lap counter resynced {_lastLapCompleted} -> {lapCompleted}");
            Baseline(lapCompleted, t);
            return;
        }

        if (lapCompleted - _lastLapCompleted > 1)
        {
            _pending = null;
            Decided?.Invoke(new LapDecision(lapCompleted, null,
                $"lap counter jumped from {_lastLapCompleted} to {lapCompleted} (telemetry ticks were missed) - not timed"));
            Baseline(lapCompleted, t);
            return;
        }

        // Exactly one more lap. A lap still waiting for its time when the next
        // one completes gets whatever the channel showed last - a lap under
        // three seconds is not a real one anyway.
        if (_pending is Pending stale)
        {
            _pending = null;
            Decided?.Invoke(Decide(stale, _lastLapTimeSeen));
        }

        // Snapshot what this lap looked like, then wait for the time channel.
        _pending = new Pending(
            lapCompleted,
            Deadline: _tick + LapTimeDeadlineTicks,
            TimeBefore: _lastLapTimeSeen,
            Incidents: t.PlayerCarMyIncidentCount is int now && _lapStartIncidents is int start ? now - start : null,
            Pit: _pitSeen,
            Incomplete: _incompleteSeen,
            Replay: _replaySeen);
        Baseline(lapCompleted, t);
    }

    private void Baseline(int lapCompleted, TelemetryTick t)
    {
        _lastLapCompleted = lapCompleted;
        _lapStartIncidents = t.PlayerCarMyIncidentCount;
        _pitSeen = t.OnPitRoad == true;
        _incompleteSeen = false;
        _replaySeen = false;
    }

    private void TrackLapFlags(TelemetryTick t)
    {
        if (t.OnPitRoad == true) _pitSeen = true;
        if (t.PlayerTrackSurface == -1) _incompleteSeen = true;
        if (t.Lap is int lap)
        {
            if (_previousLap is int prev && lap < prev) _incompleteSeen = true;
            _previousLap = lap;
        }
        if (t.EnterExitReset is int reset)
        {
            if (_previousReset is int prev && reset != prev) _incompleteSeen = true;
            _previousReset = reset;
        }
        if (t.IsOnTrack is bool onTrack)
        {
            if (_previousOnTrack == true && !onTrack) _incompleteSeen = true;
            _previousOnTrack = onTrack;
        }
    }

    private void SettlePending(TelemetryTick t)
    {
        var time = t.LapLastLapTime;
        if (_pending is not Pending p) return;

        // The time is trusted once it differs from the previous lap's, or once
        // the deadline passes (two identical laps to the millisecond are rare
        // but possible, and the deadline is what lets them through).
        var caughtUp = time is float f && f > 0 && f != p.TimeBefore && f != _staleLapTime;
        if (!caughtUp && _tick < p.Deadline) return;
        _pending = null;

        var decision = Decide(p, time);
        Decided?.Invoke(decision);
    }

    private LapDecision Decide(Pending p, float? time)
    {
        var n = p.LapCompleted;
        if (p.Replay) return new LapDecision(n, null, "a replay was playing during this lap - not timed");
        if (p.Incomplete) return new LapDecision(n, null, "the car was reset, towed or left the track mid-lap - not timed");
        if (p.Pit) return new LapDecision(n, null, "the lap went through the pit lane (out lap or pit stop) - not timed");
        if (time is float t && t > 0 && t == _staleLapTime)
            return new LapDecision(n, null, "lap time unchanged since the counter resynced (stale) - not timed");
        if (time is not float seconds || seconds <= 0)
            return new LapDecision(n, null, "iRacing reported no lap time for it (out lap or invalid lap)");

        var ms = (int)Math.Round(seconds * 1000);
        if (ms > 30 * 60_000)
            return new LapDecision(n, null, $"lap time {seconds:F3}s is over thirty minutes, which the backend refuses");
        if (Combo is not SessionCombo combo)
            return new LapDecision(n, null, "session info has not named the track and car yet - not posted");

        var at = _now();
        return new LapDecision(n, new LapCompleted
        {
            EventId = $"ir-{_rigTag}-{at.ToUnixTimeMilliseconds()}-{n}",
            TrackName = combo.TrackDisplayName,
            TrackConfig = combo.TrackConfigName,
            CarName = combo.CarScreenName,
            LapNumber = n,
            LapTimeMs = ms,
            IncidentDelta = p.Incidents is int d && d >= 0 ? d : null,
            CompletedAt = at,
        }, null);
    }
}
