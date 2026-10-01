namespace OasisRigAgent.Core.Iracing;

/// <summary>
/// One tick of what the race status reads: the player's own scalars, and the
/// player's own element of three <c>CarIdx*</c> arrays. Nullable throughout
/// for <see cref="TelemetryTick"/>'s reason: a channel this build does not
/// publish is "unknown", never a crash on the rig.
/// </summary>
public sealed record RaceTick
{
    public int? SessionUniqueId { get; init; }
    public int? SessionNum { get; init; }
    public int? SessionState { get; init; }
    public uint? SessionFlags { get; init; }
    public double? SessionTimeRemain { get; init; }
    public int? SessionLapsRemainEx { get; init; }
    public int? PlayerCarIdx { get; init; }
    public int? PlayerCarPosition { get; init; }
    public int? PlayerCarClassPosition { get; init; }
    public int? Lap { get; init; }
    public int? LapCompleted { get; init; }
    public float? LapDistPct { get; init; }
    public bool? OnPitRoad { get; init; }
    public bool? IsReplayPlaying { get; init; }
    public int? PlayerCarMyIncidentCount { get; init; }
    /// <summary><c>CarIdxF2Time[PlayerCarIdx]</c>, seconds.</summary>
    public float? F2Time { get; init; }
    /// <summary><c>CarIdxLastLapTime[PlayerCarIdx]</c>, seconds.</summary>
    public float? LastLapTime { get; init; }
    /// <summary><c>CarIdxBestLapTime[PlayerCarIdx]</c>, seconds.</summary>
    public float? BestLapTime { get; init; }

    /// <summary>Scalars, read every frame beside the lap detector's.</summary>
    public static readonly IReadOnlySet<string> VariableNames = new HashSet<string>(
    [
        "SessionUniqueID", "SessionNum", "SessionState", "SessionFlags", "SessionTimeRemain",
        "SessionLapsRemainEx", "PlayerCarIdx", "PlayerCarPosition", "PlayerCarClassPosition",
        "Lap", "LapCompleted", "LapDistPct", "OnPitRoad", "IsReplayPlaying", "PlayerCarMyIncidentCount",
    ], StringComparer.Ordinal);

    /// <summary>64-element arrays, of which only the player's element is read.</summary>
    public static readonly IReadOnlyList<string> ElementNames = ["CarIdxF2Time", "CarIdxLastLapTime", "CarIdxBestLapTime"];

    /// <param name="element">Reads the player's element of one of <see cref="ElementNames"/>.</param>
    public static RaceTick FromValues(IReadOnlyDictionary<string, object?> values, Func<string, object?> element) => new()
    {
        SessionUniqueId = Get<int>(values, "SessionUniqueID"),
        SessionNum = Get<int>(values, "SessionNum"),
        SessionState = Get<int>(values, "SessionState"),
        SessionFlags = Get<uint>(values, "SessionFlags"),
        SessionTimeRemain = Get<double>(values, "SessionTimeRemain"),
        SessionLapsRemainEx = Get<int>(values, "SessionLapsRemainEx"),
        PlayerCarIdx = Get<int>(values, "PlayerCarIdx"),
        PlayerCarPosition = Get<int>(values, "PlayerCarPosition"),
        PlayerCarClassPosition = Get<int>(values, "PlayerCarClassPosition"),
        Lap = Get<int>(values, "Lap"),
        LapCompleted = Get<int>(values, "LapCompleted"),
        LapDistPct = Get<float>(values, "LapDistPct"),
        OnPitRoad = Get<bool>(values, "OnPitRoad"),
        IsReplayPlaying = Get<bool>(values, "IsReplayPlaying"),
        PlayerCarMyIncidentCount = Get<int>(values, "PlayerCarMyIncidentCount"),
        F2Time = element("CarIdxF2Time") is float f2 ? f2 : null,
        LastLapTime = element("CarIdxLastLapTime") is float last ? last : null,
        BestLapTime = element("CarIdxBestLapTime") is float best ? best : null,
    };

    private static T? Get<T>(IReadOnlyDictionary<string, object?> values, string key) where T : struct
        => values.TryGetValue(key, out var v) && v is T t ? t : null;
}

/// <summary>
/// Turns iRacing ticks into this rig's live race status
/// (<see cref="RaceStatusReport"/>). Pure, like <see cref="LapDetector"/>: no
/// threads, no shared memory, a clock it is handed, so every rule below is a
/// unit test that feeds it ticks.
///
/// The telemetry thread hands it every new tick (<see cref="Observe"/>, a
/// reference swap) and the agent's race loop asks for a row every few seconds
/// (<see cref="RaceStatus"/>), so nothing is built at frame rate. A row exists
/// only while the car is in a live session:
///
///   - No tick yet, or none for <see cref="StaleAfter"/>: no row. The sim stopped
///     updating, and a row from before that would put a car on the board that
///     is not moving; silence lets the board dim it instead.
///   - A replay playing: no row. The channels then describe the replay, not
///     the race.
///   - <c>SessionState</c> 0 (invalid) or unknown, or no session id or car
///     index: not in a session, no row.
///   - Otherwise every field is iRacing's own value, sentinels turned to null
///     and the rest clamped to the contract's bounds (see
///     <see cref="RaceStatusReport"/>). The session type is
///     <c>SessionInfo.Sessions[SessionNum].SessionType</c>, null until session
///     info has named it.
/// </summary>
public sealed class RaceStatusSampler
{
    /// <summary>How old the newest tick may be. iRacing ticks at 60 Hz, so
    /// this is a sim that has stopped, not one that is slow; well inside the
    /// feed's 15 s before it dims a silent rig.</summary>
    public static readonly TimeSpan StaleAfter = TimeSpan.FromSeconds(5);

    private static readonly IReadOnlyDictionary<int, string> NoSessions = new Dictionary<int, string>();

    private readonly Func<long> _nowMs;
    private volatile Observed? _latest;
    private volatile IReadOnlyDictionary<int, string> _sessionTypes = NoSessions;

    private sealed record Observed(RaceTick Tick, long AtMs);

    /// <param name="nowMs">A monotonic millisecond clock; defaults to <see cref="Environment.TickCount64"/>.</param>
    public RaceStatusSampler(Func<long>? nowMs = null) => _nowMs = nowMs ?? (() => Environment.TickCount64);

    /// <summary>The newest tick, for the diagnostic to print raw.</summary>
    public RaceTick? Latest => _latest?.Tick;

    /// <summary>Session types by <c>SessionNum</c>, from the session info.</summary>
    public IReadOnlyDictionary<int, string> SessionTypes
    {
        get => _sessionTypes;
        set => _sessionTypes = value;
    }

    public void Observe(RaceTick tick) => _latest = new Observed(tick, _nowMs());

    /// <summary>iRacing went away: nothing it said before applies to what comes next.</summary>
    public void Reset()
    {
        _latest = null;
        _sessionTypes = NoSessions;
    }

    public RaceStatusReport? RaceStatus(DateTimeOffset sampledAt)
    {
        if (_latest is not Observed latest) return null;
        if (_nowMs() - latest.AtMs > (long)StaleAfter.TotalMilliseconds) return null;
        var t = latest.Tick;
        if (t.IsReplayPlaying == true) return null;
        if (t.SessionState is not (>= 1 and <= 6 and int state)) return null;
        if (t.SessionUniqueId is not (>= 0 and int uniqueId)) return null;
        if (t.SessionNum is not (>= 0 and <= RaceStatusReport.MaxCars and int sessionNum)) return null;
        if (t.PlayerCarIdx is not (>= 0 and < RaceStatusReport.MaxCars and int carIdx)) return null;

        return new RaceStatusReport
        {
            SampledAt = sampledAt,
            SessionUniqueId = uniqueId,
            SessionNum = sessionNum,
            SessionType = SessionTypeOf(sessionNum),
            SessionState = state,
            SessionFlags = t.SessionFlags ?? 0,
            SessionTimeRemainS = t.SessionTimeRemain is double remain && double.IsFinite(remain)
                                 && remain >= 0 && remain < RaceStatusReport.MaxSessionSeconds
                ? Math.Round(remain, 1)
                : null,
            SessionLapsRemain = t.SessionLapsRemainEx is (>= 0 and < RaceStatusReport.MaxLaps) and int laps ? laps : null,
            CarIdx = carIdx,
            Position = Position(t.PlayerCarPosition),
            ClassPosition = Position(t.PlayerCarClassPosition),
            Lap = LapCount(t.Lap),
            LapsCompleted = LapCount(t.LapCompleted),
            LapDistPct = t.LapDistPct is float pct && float.IsFinite(pct) && pct >= 0
                ? Math.Round(Math.Min(pct, 1.0), 4)
                : null,
            GapToLeaderS = t.F2Time is float gap && float.IsFinite(gap) && gap >= 0
                ? Math.Round(Math.Min(gap, RaceStatusReport.MaxGapSeconds), 3)
                : null,
            LastLapMs = LapMs(t.LastLapTime),
            BestLapMs = LapMs(t.BestLapTime),
            OnPitRoad = t.OnPitRoad ?? false,
            Incidents = Math.Clamp(t.PlayerCarMyIncidentCount ?? 0, 0, RaceStatusReport.MaxIncidents),
        };
    }

    private string? SessionTypeOf(int sessionNum)
    {
        if (!_sessionTypes.TryGetValue(sessionNum, out var type)) return null;
        type = type.Trim();
        if (type.Length == 0) return null;
        return type.Length <= RaceStatusReport.MaxSessionTypeLength ? type : type[..RaceStatusReport.MaxSessionTypeLength];
    }

    /// <summary>iRacing reports 0 for a car it has not classified yet.</summary>
    private static int? Position(int? position) => position is (>= 1 and <= RaceStatusReport.MaxCars) and int p ? p : null;

    private static int? LapCount(int? laps) => laps is (>= 0 and <= RaceStatusReport.MaxLaps) and int n ? n : null;

    /// <summary>-1 or 0 is iRacing's "no time yet"; anything past the backend's
    /// thirty-minute lap ceiling is not a lap.</summary>
    private static int? LapMs(float? seconds)
    {
        if (seconds is not float s || !float.IsFinite(s) || s <= 0) return null;
        var ms = (int)Math.Round(s * 1000.0);
        return ms is > 0 and <= RaceStatusReport.MaxLapTimeMs ? ms : null;
    }
}
