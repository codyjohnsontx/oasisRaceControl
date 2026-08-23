using System.Globalization;

namespace OasisRigAgent.Core.IRacing;

/// <summary>Why a crossing of the line did or did not become a lap the venue keeps.</summary>
public enum LapOutcome
{
    /// <summary>No line crossing in this frame.</summary>
    None,

    /// <summary>A lap the venue keeps.</summary>
    Emitted,

    /// <summary>First crossing after attaching to a session. The lap started before we
    /// were watching, so its time and incident count cannot be trusted.</summary>
    Priming,

    /// <summary>The sim reported no usable time for the lap (out lap, or timing reset).</summary>
    NoLapTime,

    /// <summary>Pit lane was used during the lap, so it is an in-lap or out-lap.</summary>
    PitLap,

    /// <summary>The car was reset, towed, or teleported during the lap.</summary>
    ResetDuringLap,

    /// <summary>The car was not being driven for part of the lap (garage, replay, out of the world).</summary>
    NotDriving,

    /// <summary>The sim moved to a different session or a different track/car combination.</summary>
    SessionChanged,

    /// <summary>The track/car combination is not known yet, so the lap cannot be labelled.</summary>
    UnknownCombo,

    /// <summary>The reported time is outside anything a real lap can be.</summary>
    ImplausibleTime,

    /// <summary>The sim reported a lap counter that cannot be real.</summary>
    ImplausibleLapNumber,
}

/// <summary>
/// One frame's verdict. <see cref="Lap"/> is set only when <see cref="Outcome"/> is
/// <see cref="LapOutcome.Emitted"/>.
///
/// <see cref="OffTrackSeen"/> is reported for EVERY crossing, including the ones
/// that produced no lap, so the rig's log can say a dropped lap also went off.
/// A lap that is kept carries the same observation on <see cref="LapCompleted.OffTrackSeen"/>
/// and out to the backend, which is what decides whether it counts
/// (apps/web/src/lib/validity.ts). Both come from one read of the accumulated flag.
/// </summary>
public sealed record LapDetection(
    LapOutcome Outcome,
    LapCompleted? Lap,
    int? LapNumber,
    string? Detail = null,
    bool OffTrackSeen = false)
{
    public static readonly LapDetection Nothing = new(LapOutcome.None, null, null);
}

/// <summary>
/// Turns a stream of telemetry frames into the completed laps the venue keeps.
///
/// This is the whole of the agent's lap logic and it is deliberately pure: it owns
/// no threads, no clock, and no I/O, so every edge case the venue can produce -
/// out laps, a tow, a session restart, an agent restart mid-session, a combo change,
/// someone watching a replay - is reachable from a unit test without iRacing
/// (docs/plan.md, "Testing strategy").
///
/// The rules it enforces, and why:
///
/// * <b>Never judge a lap we did not watch end to end.</b> Attaching, reconnecting,
///   or any discontinuity leaves the car mid-lap, so it takes two crossings to get
///   back to judging: the first ends the lap we joined partway through and is
///   discarded, and the lap starting there is the first one watched throughout. A lap
///   whose start nobody saw has an unknowable incident count and could have been
///   through the pits or off the road before we arrived, and the venue's rule is
///   clean laps only - so keeping it would be a wrong result on a public leaderboard.
/// * <b>Pit, reset and not-driving laps are dropped, not sent invalid.</b> The lap
///   event contract carries a time and an incident delta, not a reason code
///   (apps/web/src/lib/events.ts), so a junk lap has no honest representation on the
///   wire. Dropping it locally keeps lap history readable; the caller still learns
///   the reason through <see cref="LapDetection.Outcome"/> and can log it.
/// * <b>Two laps on one rig never share an identity.</b> A lap's <c>eventId</c> is
///   the backend's idempotency key, so two different laps carrying one id is not a
///   clash that gets reported - the second one is dropped as a retry of the first
///   and is gone. Rig, sim session and lap number are not enough to prevent that:
///   the lap counter goes back to 1 every time a driver restarts their session, and
///   whether iRacing's own session id changes with it has never been established
///   (<c>docs/spike-findings.md</c>). So each run of lap numbers gets its own token
///   from this detector - see <see cref="StartNewLap"/> - and uniqueness stops
///   depending on a property of somebody else's binary.
/// * <b>Resubmission is the outbox's job, not the id's.</b> A lap already queued
///   keeps the id it was minted with, however many times it is sent, so retries and
///   crash recovery deduplicate on that. A lap the detector never watched from its
///   start is never emitted, so no restart can produce the same lap twice.
/// </summary>
public sealed class LapDetector
{
    /// <summary>Telemetry channels this detector reads. The source watches exactly
    /// these, so an unused channel is never copied out of shared memory.
    ///
    /// Declared by <see cref="TelemetryChannels"/> rather than listed here, so a
    /// channel cannot be read without also being checked against the running sim -
    /// reading one the sim does not publish is silent, and every rule below that
    /// depends on it then stands down without saying so.</summary>
    public static IReadOnlySet<string> WatchedVariables => TelemetryChannels.Names;

    /// <summary>Track surface value meaning the car is not in the world at all -
    /// what a reset-to-pits, a tow, or a return to the garage looks like.</summary>
    private const int SurfaceNotInWorld = -1;

    /// <summary>Track surface value meaning all four wheels are off the racing surface.</summary>
    private const int SurfaceOffTrack = 0;

    private const int MinimumPlausibleLapMs = 5_000;
    private const int MaximumPlausibleLapMs = 60 * 60 * 1000;

    /// <summary>
    /// How long a completed lap waits for the sim to publish its time before the lap
    /// is given up on.
    ///
    /// The sim publishes the lap counter and the lap time as two independent channels,
    /// and nothing documents which of them moves first - iRacing's own reference names
    /// <c>LapLastLapTime</c> as "Players last lap time" in seconds and says nothing
    /// about when it lands relative to the line. `docs/spike-findings.md` still carries
    /// that as an open question ("Off-by-one behavior at boundary?"), so this agent is
    /// written to be right under either answer rather than to bet on one.
    ///
    /// A whole second is generous against a channel that moves within a few of the
    /// sim's own 60 Hz ticks, and it is far shorter than the shortest lap the venue
    /// will keep (<see cref="MinimumPlausibleLapMs"/>), so a lap can never still be
    /// waiting when the next one arrives.
    /// </summary>
    private static readonly TimeSpan LapTimeSettleWindow = TimeSpan.FromSeconds(2);

    /// <summary>
    /// A crossing that is a lap the venue keeps in every respect except that the sim
    /// has not yet said what it took. Everything here is read at the line, because
    /// none of it can be read afterwards: the incident count is a movement across the
    /// lap, the off-track and pit flags are cleared for the lap starting now, and the
    /// completion time is when the driver crossed, not when the sim got round to
    /// publishing the time.
    /// </summary>
    private sealed record PendingLap(
        int LapNumber,
        string EventId,
        SimSessionIdentity Identity,
        int? IncidentDelta,
        bool OffTrackSeen,
        float? TimeStandingAtTheLine,
        DateTimeOffset CompletedAt);

    private readonly int _rigNumber;
    private readonly string _instanceId;

    private string? _sessionKey;
    /// <summary>Names the current run of lap numbers. Bumped by
    /// <see cref="StartNewLap"/> whenever numbering restarts, which is what keeps
    /// one customer's lap 6 from carrying the identity of the previous customer's.</summary>
    private int _runOrdinal;
    private bool _primed;
    private int? _lastLapCompleted;
    private int? _lastLap;
    private int? _incidentsAtLapStart;
    private bool _pitRoadSeen;
    private bool _resetSeen;
    private bool _notDrivingSeen;
    private bool _offTrackSeen;
    /// <summary>The lap time standing on the previous frame. A time that has not moved
    /// since before the line is the PREVIOUS lap's, whatever the counter says.</summary>
    private float? _lapTimeOnLastFrame;
    private PendingLap? _pending;

    /// <param name="rigNumber">Which simulator this agent runs on. Namespaces the lap
    /// identity so two rigs on the same combo can never collide.</param>
    /// <param name="instanceId">Disambiguates sessions the sim did not give an id to.
    /// Defaults to something unique per agent run; tests pin it.</param>
    public LapDetector(int rigNumber, string? instanceId = null)
    {
        _rigNumber = rigNumber;
        _instanceId = Sanitize(instanceId ?? DefaultInstanceId());
    }

    /// <summary>True once a lap has been watched from its start, so the next crossing
    /// can be judged. False while attaching, and after any discontinuity.</summary>
    public bool IsPrimed => _primed;

    /// <summary>
    /// Feeds one telemetry frame through the state machine.
    /// </summary>
    /// <param name="values">Watched channel values from this frame.</param>
    /// <param name="identity">Combo from the most recent session metadata, or null if
    /// it has not arrived or could not be read.</param>
    /// <param name="at">When the frame was read. Becomes the lap's completion time.</param>
    public LapDetection Observe(
        IReadOnlyDictionary<string, object?> values,
        SimSessionIdentity? identity,
        DateTimeOffset at)
    {
        // Read once, before anything below can return: what the lap time was on the
        // previous frame is the only thing that tells a time the sim has just
        // published apart from the one still standing from the lap before, and every
        // path out of this method has to leave that shadow one frame old.
        var lapTimeNow = GetFloat(values, "LapLastLapTime");
        var lapTimeBefore = _lapTimeOnLastFrame;
        _lapTimeOnLastFrame = lapTimeNow;

        // A replay is the sim re-playing telemetry that is not being driven now.
        // Nothing in it is a lap, and the channels jump when it stops, so stand
        // down until a fresh lap can be watched from its start.
        if (GetBool(values, "IsReplayPlaying") == true)
        {
            Unprime();
            return new LapDetection(LapOutcome.NotDriving, null, null, "replay playing");
        }

        var sessionKey = BuildSessionKey(values, identity);
        if (_sessionKey is null || !string.Equals(_sessionKey, sessionKey, StringComparison.Ordinal))
        {
            var previous = _sessionKey;
            _sessionKey = sessionKey;
            ResetLapState();
            if (previous is not null)
                return new LapDetection(LapOutcome.SessionChanged, null, null, $"{previous} -> {sessionKey}");
        }

        ObserveLapConditions(values);

        if (GetInt(values, "LapCompleted") is not int lapCompleted)
            return Settle(lapTimeNow, at) ?? LapDetection.Nothing;

        // "Laps completed" is a count, so a negative one is not a lap counter at all -
        // it is a corrupt read that happened to land inside the mapping. Nothing is
        // timed across it, and no lap is built on it: the backend's contract rejects a
        // negative lap number for the whole batch it arrives in, and the agent would
        // then resubmit that batch for the rest of the day.
        if (lapCompleted < 0)
        {
            Unprime();
            return new LapDetection(LapOutcome.ImplausibleLapNumber, null, lapCompleted, "negative lap counter");
        }

        if (_lastLapCompleted is not int previousLapCompleted)
        {
            // The first frame after attaching. It says where the lap counter is and
            // nothing else: the car is somewhere mid-lap, and whatever happened
            // earlier in that lap happened before anyone was watching.
            StartNewLap(lapCompleted, values, watchedFromItsStart: false);
            return new LapDetection(LapOutcome.Priming, null, lapCompleted);
        }

        if (lapCompleted == previousLapCompleted) return Settle(lapTimeNow, at) ?? LapDetection.Nothing;

        // From here this frame is a crossing, and a lap still waiting for its time
        // has run out of time to get one: emitting it now would put the wrong number
        // on it, and holding two at once would let the next crossing's time settle the
        // last crossing's lap. It is dropped rather than guessed at.
        _pending = null;

        if (lapCompleted < previousLapCompleted)
        {
            // The counter only goes backwards when the sim rewound the session under
            // us. Whatever we were timing is gone, and the car is mid-lap again.
            StartNewLap(lapCompleted, values, watchedFromItsStart: false);
            return new LapDetection(LapOutcome.ResetDuringLap, null, lapCompleted,
                $"lap counter {previousLapCompleted} -> {lapCompleted}");
        }

        if (!_primed)
        {
            // The first crossing since attaching. The lap it ended is the one we joined
            // partway through, so it cannot be judged - but from this line onwards a
            // whole lap is watched, so the next one can be.
            StartNewLap(lapCompleted, values, watchedFromItsStart: true);
            return new LapDetection(LapOutcome.Priming, null, lapCompleted);
        }

        // Read once: the lap that is kept and the verdict about it must agree, and
        // StartNewLap below clears the flag.
        var offTrackSeen = _offTrackSeen;
        var detection = JudgeCompletedLap(lapCompleted, values, identity, at, offTrackSeen, lapTimeNow, lapTimeBefore)
            with { OffTrackSeen = offTrackSeen };
        StartNewLap(lapCompleted, values, watchedFromItsStart: true);
        return detection;
    }

    /// <summary>Drops everything learned about the session. Called when the sim goes
    /// away, so the next connection re-establishes its baseline from scratch.</summary>
    public void Reset()
    {
        _sessionKey = null;
        // The sim has gone. Whatever it was publishing as the last lap time is not
        // evidence about anything the next connection sees.
        _lapTimeOnLastFrame = null;
        ResetLapState();
    }

    private LapDetection JudgeCompletedLap(
        int lapCompleted,
        IReadOnlyDictionary<string, object?> values,
        SimSessionIdentity? identity,
        DateTimeOffset at,
        bool offTrackSeen,
        float? lapTimeNow,
        float? lapTimeBefore)
    {
        if (_notDrivingSeen)
            return new LapDetection(LapOutcome.NotDriving, null, lapCompleted, "driver was out of the car during the lap");
        if (_resetSeen)
            return new LapDetection(LapOutcome.ResetDuringLap, null, lapCompleted, "reset, tow, or teleport during the lap");
        if (_pitRoadSeen)
            return new LapDetection(LapOutcome.PitLap, null, lapCompleted, "pit lane used during the lap");

        if (identity is null)
            return new LapDetection(LapOutcome.UnknownCombo, null, lapCompleted, "no session metadata yet");

        var pending = new PendingLap(
            lapCompleted,
            BuildEventId(values, lapCompleted),
            identity,
            IncidentDelta(values),
            offTrackSeen,
            lapTimeBefore,
            at);

        // The counter has moved. Whether the TIME has is a separate question, and the
        // answer decides whose time this lap gets: a channel that still holds what it
        // held before the line holds the PREVIOUS lap's time, and sending that is a
        // lap on the board the driver never drove, while their real one - usually
        // their last and best - never appears at all.
        if (IsFreshLapTime(lapTimeNow, lapTimeBefore)) return BuildLap(pending, lapTimeNow);

        _pending = pending;
        return LapDetection.Nothing;
    }

    /// <summary>
    /// Finishes, gives up on, or keeps waiting for a lap whose time had not been
    /// published when the driver crossed the line. Returns null while it is still
    /// worth waiting, which is the caller's "nothing happened this frame".
    /// </summary>
    private LapDetection? Settle(float? lapTimeNow, DateTimeOffset at)
    {
        if (_pending is not PendingLap pending) return null;

        if (IsFreshLapTime(lapTimeNow, pending.TimeStandingAtTheLine))
        {
            _pending = null;
            return BuildLap(pending, lapTimeNow);
        }

        if (at - pending.CompletedAt < LapTimeSettleWindow) return null;

        // Waited, and the sim never published a time for this lap. That is what a
        // timing reset or an invalidated lap looks like from here, and the only other
        // reading - two laps to the same ten-millionth of a second - is not something
        // a person can drive. Either way the venue would rather be short one lap than
        // carry one whose time we cannot stand behind.
        _pending = null;
        return new LapDetection(LapOutcome.NoLapTime, null, pending.LapNumber,
            "the sim published no time for this lap", pending.OffTrackSeen);
    }

    /// <summary>
    /// Whether the lap time on this frame belongs to the lap that just ended rather
    /// than to the one before it. An absent channel is never fresh, so a frame that
    /// lost the channel waits rather than settling on nothing.
    /// </summary>
    private static bool IsFreshLapTime(float? now, float? standing) =>
        now is float value && (standing is not float before || !value.Equals(before));

    /// <summary>Turns a lap and the time the sim published for it into this frame's
    /// verdict. Split out because a lap reaches it from the line or from a frame up to
    /// <see cref="LapTimeSettleWindow"/> later, and both must judge it identically.</summary>
    private static LapDetection BuildLap(PendingLap pending, float? lapTime)
    {
        if (lapTime is not float seconds || seconds <= 0f || float.IsNaN(seconds))
            return new LapDetection(LapOutcome.NoLapTime, null, pending.LapNumber,
                "sim reported no lap time", pending.OffTrackSeen);

        var milliseconds = (long)Math.Round(seconds * 1000d);
        if (milliseconds < MinimumPlausibleLapMs || milliseconds > MaximumPlausibleLapMs)
            return new LapDetection(LapOutcome.ImplausibleTime, null, pending.LapNumber,
                $"{milliseconds} ms", pending.OffTrackSeen);

        return new LapDetection(LapOutcome.Emitted, new LapCompleted
        {
            EventId = pending.EventId,
            TrackName = pending.Identity.TrackName,
            TrackConfig = pending.Identity.TrackConfig,
            CarName = pending.Identity.CarName,
            LapNumber = pending.LapNumber,
            LapTimeMs = (int)milliseconds,
            IncidentDelta = pending.IncidentDelta,
            OffTrackSeen = pending.OffTrackSeen,
            // When the driver crossed the line, never when the sim got round to
            // saying what it took: which check-in owns a lap is decided from this
            // (apps/web/src/app/api/agent/events/route.ts), and so is which night it
            // counts for.
            CompletedAt = pending.CompletedAt,
        }, pending.LapNumber, null, pending.OffTrackSeen);
    }

    /// <summary>
    /// Accumulates, across the whole lap, the conditions that decide whether it counts.
    /// A single frame is not enough: a two-wheel off or a pit entry is over long before
    /// the car reaches the line.
    /// </summary>
    private void ObserveLapConditions(IReadOnlyDictionary<string, object?> values)
    {
        if (GetBool(values, "OnPitRoad") == true) _pitRoadSeen = true;
        if (GetBool(values, "IsInGarage") == true) _notDrivingSeen = true;
        if (GetBool(values, "IsOnTrack") == false) _notDrivingSeen = true;

        if (GetInt(values, "PlayerTrackSurface") is int surface)
        {
            if (surface == SurfaceNotInWorld) _resetSeen = true;
            else if (surface == SurfaceOffTrack) _offTrackSeen = true;
        }

        // The lap counter running backwards is the other face of a reset: it can move
        // without LapCompleted moving, so it is watched separately.
        if (GetInt(values, "Lap") is int lap)
        {
            if (_lastLap is int previous && lap < previous) _resetSeen = true;
            _lastLap = lap;
        }
    }

    /// <param name="watchedFromItsStart">Whether the lap beginning now started at a
    /// moment we were watching. Only such a lap can be judged: the conditions that
    /// invalidate one - a trip through the pits, a spin, a tow - are accumulated across
    /// the whole lap, and the incident count is a movement between its two ends. Both
    /// are unknowable for a lap we joined partway through.</param>
    private void StartNewLap(int lapCompleted, IReadOnlyDictionary<string, object?> values, bool watchedFromItsStart)
    {
        // A lap whose start nobody watched is also the first lap of a new run of lap
        // numbers: the detector has just attached, or the counter went backwards, or
        // the session moved. Either way the numbers from here on may repeat ones
        // already spent, so this is where the run token turns over. It is the only
        // place it does, and it happens once per transition rather than per frame.
        if (!watchedFromItsStart) _runOrdinal++;
        _primed = watchedFromItsStart;
        _lastLapCompleted = lapCompleted;
        _incidentsAtLapStart = GetInt(values, "PlayerCarMyIncidentCount");
        _lastLap = GetInt(values, "Lap");
        _pitRoadSeen = false;
        _resetSeen = false;
        _notDrivingSeen = false;
        _offTrackSeen = false;
    }

    private void Unprime()
    {
        _primed = false;
        _lastLapCompleted = null;
        // Whatever we were waiting on a time for, we are no longer watching the
        // session that would publish it.
        _pending = null;
    }

    private void ResetLapState()
    {
        Unprime();
        _lastLap = null;
        _incidentsAtLapStart = null;
        _pitRoadSeen = false;
        _resetSeen = false;
        _notDrivingSeen = false;
        _offTrackSeen = false;
    }

    /// <summary>
    /// Incidents charged to this lap. The sim exposes a running total, so a lap's
    /// share is the movement across it; the contract carries a count, never a
    /// negative, so a total that went backwards reads as zero rather than as an
    /// invalid event the backend would reject.
    /// </summary>
    private int? IncidentDelta(IReadOnlyDictionary<string, object?> values)
    {
        if (_incidentsAtLapStart is not int start) return null;
        if (GetInt(values, "PlayerCarMyIncidentCount") is not int now) return null;
        return Math.Max(0, now - start);
    }

    /// <summary>
    /// A session is the combination the sim is running: its own session identity plus
    /// the combo. Either moving means the laps before and after belong to different
    /// things, so state is dropped rather than carried across.
    /// </summary>
    private static string BuildSessionKey(IReadOnlyDictionary<string, object?> values, SimSessionIdentity? identity)
    {
        var unique = GetInt(values, "SessionUniqueID")?.ToString(CultureInfo.InvariantCulture) ?? "?";
        var number = GetInt(values, "SessionNum")?.ToString(CultureInfo.InvariantCulture) ?? "?";
        return $"{unique}/{number}/{identity?.ComboKey ?? "?"}";
    }

    /// <summary>
    /// The lap's identity, which is also the backend's idempotency key.
    ///
    /// The run token (<c>t...</c>) is what makes it unique: this agent run, and the
    /// run of lap numbers it is currently watching. Everything before it - the rig,
    /// the sim's session id and session number - is there so a line in a log or a
    /// database says which machine and which sim session a lap came from, and none of
    /// it is relied on to keep two laps apart.
    /// </summary>
    private string BuildEventId(IReadOnlyDictionary<string, object?> values, int lapCompleted)
    {
        var session = GetInt(values, "SessionUniqueID") is int unique
            ? unique.ToString(CultureInfo.InvariantCulture)
            : "none";
        var number = GetInt(values, "SessionNum") ?? 0;
        var id = $"lap-r{_rigNumber}-s{session}-n{number}-l{lapCompleted}-t{_instanceId}x{_runOrdinal}";
        return id.Length <= 128 ? id : id[..128];
    }

    /// <summary>Names this agent run. Two runs on one rig are seconds apart at the
    /// closest, but a millisecond clock is not a uniqueness argument - a rig whose
    /// clock steps back (the case <see cref="ServerClock"/> exists for) would repeat
    /// one - so the random half is what actually carries it.</summary>
    private static string DefaultInstanceId() =>
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
        + Guid.NewGuid().ToString("N")[..8];

    /// <summary>The id rides in a validated event field; keep it to characters that
    /// cannot change how anything downstream reads it, and short enough that the run
    /// token can never be the part <see cref="BuildEventId"/> trims off - that would
    /// put two customers back on one identity, silently.</summary>
    private static string Sanitize(string value)
    {
        var safe = value.Where(char.IsLetterOrDigit).Take(32).ToArray();
        return safe.Length == 0 ? "0" : new string(safe);
    }

    private static object? Get(IReadOnlyDictionary<string, object?> values, string key) =>
        values.TryGetValue(key, out var value) ? value : null;
    private static int? GetInt(IReadOnlyDictionary<string, object?> values, string key) => Get(values, key) as int?;
    private static float? GetFloat(IReadOnlyDictionary<string, object?> values, string key) => Get(values, key) as float?;
    private static bool? GetBool(IReadOnlyDictionary<string, object?> values, string key) => Get(values, key) as bool?;
}
