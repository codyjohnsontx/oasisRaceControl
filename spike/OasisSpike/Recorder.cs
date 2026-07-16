using System.Text.Json;

namespace OasisSpike;

public sealed class Recorder : IDisposable
{
    private static readonly string[] WatchedInts =
    [
        "SessionNum", "SessionState", "SessionUniqueID", "SessionTick",
        "Lap", "LapCompleted", "PlayerCarIdx",
        "PlayerCarMyIncidentCount", "PlayerCarDriverIncidentCount", "PlayerCarTeamIncidentCount",
        "PlayerTrackSurface", "EnterExitReset", "PitsOpen"
    ];

    private static readonly string[] WatchedFloats =
    [
        "LapLastLapTime", "LapBestLapTime", "LapCurrentLapTime", "LapDistPct", "LapDist", "Speed"
    ];

    private static readonly string[] WatchedBools =
    [
        "OnPitRoad", "IsOnTrack", "IsOnTrackCar", "IsInGarage", "IsReplayPlaying"
    ];

    private static readonly string[] WatchedDoubles = ["SessionTime"];
    private static readonly string[] WatchedBitFields = ["SessionFlags"];
    private static readonly string[] ChangeWatchedInts =
    [
        "SessionNum", "SessionState", "SessionUniqueID", "PlayerTrackSurface", "Lap", "EnterExitReset"
    ];
    private static readonly string[] ChangeWatchedBools = ["OnPitRoad", "IsOnTrack", "IsInGarage"];

    internal static readonly IReadOnlySet<string> WatchedVariableNames =
        new HashSet<string>(WatchedInts.Concat(WatchedFloats).Concat(WatchedBools)
            .Concat(WatchedDoubles).Concat(WatchedBitFields), StringComparer.Ordinal);

    private readonly IIrracingTelemetrySource _source;
    private readonly LogBudget _logs;
    private readonly RecorderMode _mode;
    private readonly SafetyLimits _limits;
    private readonly string _version;
    private readonly string _sourceRevision;
    private readonly ManualResetEventSlim _stopped = new(false);
    private int _stopStarted;
    private Timer? _deadline;
    private DateTimeOffset _startedAt;
    private long _lastSnapshotTick;
    private bool _dumpedVariables;
    private int _sessionInfoCount;
    private int? _lastLapCompleted;
    private int? _lapStartIncidentCount;
    private bool _offTrackSeen;
    private bool _pitRoadSeen;
    private bool _resetSeen;
    private readonly Dictionary<string, long> _previousInts = new();
    private readonly Dictionary<string, bool> _previousBools = new();

    public bool Stopped => _stopped.IsSet;
    public RecorderExitCode ExitCode { get; private set; } = RecorderExitCode.Success;
    public string ExitReason { get; private set; } = "running";

    public Recorder(
        IIrracingTelemetrySource source,
        LogBudget logs,
        RecorderMode mode,
        SafetyLimits limits,
        string version,
        string sourceRevision)
    {
        _source = source;
        _logs = logs;
        _mode = mode;
        _limits = limits;
        _version = version;
        _sourceRevision = sourceRevision;

        source.Connected += () => SafeCallback(() => Emit("CONNECTED", new { }));
        source.Disconnected += () => SafeCallback(() =>
        {
            Emit("DISCONNECTED", new { });
            ResetTelemetryState();
        });
        source.SessionInfo += snapshot => SafeCallback(() => OnSessionInfo(snapshot));
        source.Telemetry += snapshot => SafeCallback(() => OnTelemetry(snapshot));
        source.Faulted += exception => SafeCallback(() =>
        {
            Emit("SOURCE_FAULT", new { message = exception.Message });
            Stop(exception is MalformedTelemetryException ? "malformed-telemetry" : "source-failure",
                exception is MalformedTelemetryException ? RecorderExitCode.MalformedTelemetry : RecorderExitCode.InternalFailure);
        });
    }

    public void Start()
    {
        _startedAt = DateTimeOffset.UtcNow;
        WriteManifest("running");
        Emit("RECORDER_STARTED", new
        {
            mode = _mode.ToCliValue(),
            maxDurationSeconds = (long)_limits.MaxDuration.TotalSeconds,
            maxOutputBytes = _limits.MaxOutputBytes
        });
        _deadline = new Timer(_ => Stop("duration-limit"), null, _limits.MaxDuration, Timeout.InfiniteTimeSpan);
        _source.Start();
    }

    public void Stop(string reason, RecorderExitCode exitCode = RecorderExitCode.Success)
    {
        if (Interlocked.CompareExchange(ref _stopStarted, 1, 0) != 0) return;
        ExitReason = reason;
        ExitCode = exitCode;
        _deadline?.Change(Timeout.Infinite, Timeout.Infinite);
        try
        {
            try { Emit("RECORDER_STOPPED", new { reason, exitCode = (int)exitCode }); } catch { }
            try { _source.Stop(); } catch { }
            try { WriteManifest(reason); } catch { }
        }
        finally
        {
            _stopped.Set();
        }
    }

    public void Marker(string note)
    {
        if (Stopped) return;
        const int maximumMarkerLength = 512;
        var truncated = note.Length > maximumMarkerLength;
        if (truncated) note = note[..maximumMarkerLength];
        SafeCallback(() => Emit("MARKER", new { note, truncated }));
    }

    public void WaitForStop() => _stopped.Wait();

    public void Dispose()
    {
        Stop("disposed");
        _deadline?.Dispose();
        _stopped.Dispose();
    }

    private void OnSessionInfo(SessionInfoSnapshot snapshot)
    {
        if (_sessionInfoCount >= LogBudget.MaximumSessionInfoFiles)
            throw new LogLimitException("The session metadata file-count limit was reached.");
        if (snapshot.RawBytes.Length > IrracingMemoryParser.MaximumSessionInfoBytes)
            throw new MalformedTelemetryException("Session metadata exceeded 4 MiB.");

        var number = ++_sessionInfoCount;
        var file = $"sessioninfo-{number:000}.yaml";
        _logs.WriteFile(file, snapshot.RawBytes);
        Emit("SESSION_INFO", new { file, updateNumber = snapshot.UpdateNumber, bytes = snapshot.RawBytes.Length });
    }

    private void OnTelemetry(TelemetrySnapshot snapshot)
    {
        if (!_dumpedVariables)
        {
            DumpVariableHeaders(snapshot.Variables);
            _dumpedVariables = true;
        }

        DetectChanges(snapshot.Values);
        DetectLapBoundary(snapshot.Values);

        var tick = Environment.TickCount64;
        if (tick - _lastSnapshotTick >= 1000)
        {
            _lastSnapshotTick = tick;
            _logs.WriteJsonLine("telemetry.jsonl", new { t = DateTimeOffset.UtcNow, tick = snapshot.TickCount, vars = snapshot.Values });
        }
    }

    private void DetectChanges(IReadOnlyDictionary<string, object?> now)
    {
        foreach (var name in ChangeWatchedInts)
        {
            if (GetInt(now, name) is not int value) continue;
            if (_previousInts.TryGetValue(name, out var previous) && previous != value)
            {
                Emit("CHANGE", new { var = name, from = previous, to = value, sessionTime = GetValue(now, "SessionTime") });
                if (name == "PlayerTrackSurface" && value == 0) _offTrackSeen = true;
                if (name == "Lap" && value < previous) _resetSeen = true;
            }
            _previousInts[name] = value;
        }

        foreach (var name in ChangeWatchedBools)
        {
            if (GetBool(now, name) is not bool value) continue;
            if (_previousBools.TryGetValue(name, out var previous) && previous != value)
            {
                Emit("CHANGE", new { var = name, from = previous, to = value, sessionTime = GetValue(now, "SessionTime") });
                if (name == "OnPitRoad" && value) _pitRoadSeen = true;
            }
            _previousBools[name] = value;
        }

        if (GetInt(now, "PlayerCarMyIncidentCount") is int incidents)
        {
            if (_previousInts.TryGetValue("PlayerCarMyIncidentCount", out var previous) && previous != incidents)
            {
                Emit("INCIDENT_COUNT_CHANGE", new
                {
                    from = previous,
                    to = incidents,
                    lap = GetValue(now, "Lap"),
                    lapDistPct = GetValue(now, "LapDistPct"),
                    trackSurface = GetValue(now, "PlayerTrackSurface"),
                    sessionTime = GetValue(now, "SessionTime")
                });
            }
            _previousInts["PlayerCarMyIncidentCount"] = incidents;
        }
    }

    private void DetectLapBoundary(IReadOnlyDictionary<string, object?> now)
    {
        if (GetInt(now, "LapCompleted") is not int lapCompleted) return;
        if (_lastLapCompleted is null)
        {
            _lastLapCompleted = lapCompleted;
            _lapStartIncidentCount = GetInt(now, "PlayerCarMyIncidentCount");
            return;
        }
        if (lapCompleted == _lastLapCompleted) return;

        if (lapCompleted < _lastLapCompleted)
        {
            Emit("LAP_COUNTER_RESET", new { from = _lastLapCompleted, to = lapCompleted, sessionTime = GetValue(now, "SessionTime") });
        }
        else
        {
            var incidentNow = GetInt(now, "PlayerCarMyIncidentCount");
            var lastLapSeconds = GetFloat(now, "LapLastLapTime");
            Emit("LAP_BOUNDARY", new
            {
                lapCompleted,
                lapLastLapTimeSec = lastLapSeconds,
                lapTimeMs = lastLapSeconds is > 0 ? (int)Math.Round(lastLapSeconds.Value * 1000) : (int?)null,
                incidentDelta = incidentNow is not null && _lapStartIncidentCount is not null ? incidentNow - _lapStartIncidentCount : null,
                offTrackSeen = _offTrackSeen,
                pitRoadSeen = _pitRoadSeen,
                resetSeen = _resetSeen,
                sessionNum = GetValue(now, "SessionNum"),
                sessionUniqueId = GetValue(now, "SessionUniqueID"),
                sessionTime = GetValue(now, "SessionTime")
            });
        }

        _lastLapCompleted = lapCompleted;
        _lapStartIncidentCount = GetInt(now, "PlayerCarMyIncidentCount");
        _offTrackSeen = false;
        _pitRoadSeen = false;
        _resetSeen = false;
    }

    private void DumpVariableHeaders(IReadOnlyDictionary<string, TelemetryVariable> variables)
    {
        var lines = variables.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => JsonSerializer.Serialize(pair.Value));
        _logs.WriteTextFile("telemetry-vars.txt", string.Join(Environment.NewLine, lines) + Environment.NewLine);
        var missing = WatchedVariableNames.Where(name => !variables.ContainsKey(name)).OrderBy(name => name).ToArray();
        Emit("VAR_DUMP", new { file = "telemetry-vars.txt", count = variables.Count, missingWatchedVars = missing });
    }

    private void ResetTelemetryState()
    {
        _lastLapCompleted = null;
        _lapStartIncidentCount = null;
        _offTrackSeen = false;
        _pitRoadSeen = false;
        _resetSeen = false;
        _previousInts.Clear();
        _previousBools.Clear();
    }

    private void Emit(string type, object data)
    {
        var record = new { t = DateTimeOffset.UtcNow, type, data };
        _logs.WriteJsonLine("events.jsonl", record);
        Console.WriteLine($"[{record.t:HH:mm:ss}] {type} {JsonSerializer.Serialize(data)}");
    }

    private void WriteManifest(string state)
    {
        _logs.WriteManifest(new
        {
            formatVersion = 1,
            recorderVersion = _version,
            sourceRevision = _sourceRevision,
            mode = _mode.ToCliValue(),
            maxDurationSeconds = (long)_limits.MaxDuration.TotalSeconds,
            maxOutputBytes = _limits.MaxOutputBytes,
            startedAtUtc = _startedAt,
            endedAtUtc = state == "running" ? (DateTimeOffset?)null : DateTimeOffset.UtcNow,
            state,
            exitCode = state == "running" ? null : (int?)ExitCode,
            osVersion = Environment.OSVersion.VersionString
        });
    }

    private void SafeCallback(Action callback)
    {
        if (Stopped) return;
        try { callback(); }
        catch (LogLimitException) { Stop("log-limit", RecorderExitCode.LogLimit); }
        catch (MalformedTelemetryException) { Stop("malformed-telemetry", RecorderExitCode.MalformedTelemetry); }
        catch (IOException) { Stop("output-failure", RecorderExitCode.OutputFailure); }
        catch (UnauthorizedAccessException) { Stop("output-failure", RecorderExitCode.OutputFailure); }
        catch (Exception) { Stop("internal-failure", RecorderExitCode.InternalFailure); }
    }

    private static object? GetValue(IReadOnlyDictionary<string, object?> values, string key) =>
        values.TryGetValue(key, out var value) ? value : null;
    private static int? GetInt(IReadOnlyDictionary<string, object?> values, string key) => GetValue(values, key) as int?;
    private static float? GetFloat(IReadOnlyDictionary<string, object?> values, string key) => GetValue(values, key) as float?;
    private static bool? GetBool(IReadOnlyDictionary<string, object?> values, string key) => GetValue(values, key) as bool?;
}
