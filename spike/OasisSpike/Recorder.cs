using System.Text.Json;
using IRSDKSharper;

namespace OasisSpike;

/// <summary>
/// Records everything the Phase 1 spike needs to prove:
///  - telemetry-vars.txt   every variable iRacing actually exposes (name, type, unit, description)
///  - sessioninfo-NNN.yaml full session info YAML each time it changes
///  - telemetry.jsonl      ~1 Hz snapshots of the variables Oasis Race Control cares about
///  - events.jsonl         derived events: lap boundaries (with incident delta and surface history),
///                         session/state changes, connect/disconnect, driver markers
/// All files are append-only JSONL/YAML so a crash loses at most the last line.
/// </summary>
public sealed class Recorder
{
    // Variables the product design depends on. Anything missing from the live var dump
    // is a spike finding in itself — see docs/spike-findings.md.
    private static readonly string[] WatchedInts =
    {
        "SessionNum", "SessionState", "SessionUniqueID", "SessionTick",
        "Lap", "LapCompleted", "PlayerCarIdx",
        "PlayerCarMyIncidentCount", "PlayerCarDriverIncidentCount", "PlayerCarTeamIncidentCount",
        "PlayerTrackSurface", "EnterExitReset", "PitsOpen",
    };

    private static readonly string[] WatchedFloats =
    {
        "LapLastLapTime", "LapBestLapTime", "LapCurrentLapTime", "LapDistPct", "LapDist",
    };

    private static readonly string[] WatchedBools =
    {
        "OnPitRoad", "IsOnTrack", "IsOnTrackCar", "IsInGarage", "IsReplayPlaying",
    };

    private readonly string _runDir;
    private readonly IRacingSdk _sdk;
    private readonly object _lock = new();
    private readonly StreamWriter _events;
    private readonly StreamWriter _telemetry;
    private readonly ManualResetEventSlim _stopped = new(false);
    private readonly JsonSerializerOptions _json = new() { WriteIndented = false };

    private int _sessionInfoCount;
    private long _lastSnapshotTick;
    private bool _dumpedVars;

    // Per-lap accumulators, reset at every lap boundary. These are the heart of the
    // 0x validity question: can we attribute incidents and off-tracks to a specific lap?
    private int? _lastLapCompleted;
    private int? _lapStartIncidentCount;
    private bool _offTrackSeen;
    private bool _pitRoadSeen;
    private bool _resetSeen;

    // Previous values for change detection between telemetry frames.
    private readonly Dictionary<string, long> _prevInts = new();
    private readonly Dictionary<string, bool> _prevBools = new();

    public bool Stopped => _stopped.IsSet;

    public Recorder(string runDir)
    {
        _runDir = runDir;
        _events = new StreamWriter(Path.Combine(runDir, "events.jsonl")) { AutoFlush = true };
        _telemetry = new StreamWriter(Path.Combine(runDir, "telemetry.jsonl")) { AutoFlush = true };

        _sdk = new IRacingSdk
        {
            UpdateInterval = 6 // ~10 Hz at iRacing's 60 Hz — enough to catch brief surface changes
        };

        _sdk.OnConnected += () => Emit("CONNECTED", new { });
        _sdk.OnDisconnected += () =>
        {
            Emit("DISCONNECTED", new { });
            _dumpedVars = false; // re-dump vars on next connect; content may differ per car/track
        };
        _sdk.OnException += ex => Emit("SDK_EXCEPTION", new { message = ex.ToString() });
        _sdk.OnSessionInfo += OnSessionInfo;
        _sdk.OnTelemetryData += OnTelemetryData;
    }

    public void Start()
    {
        Emit("RECORDER_STARTED", new { machine = Environment.MachineName, os = Environment.OSVersion.ToString() });
        _sdk.Start();
    }

    public void Stop()
    {
        if (_stopped.IsSet) return;
        Emit("RECORDER_STOPPED", new { });
        try { _sdk.Stop(); } catch { /* already stopping */ }
        lock (_lock)
        {
            _events.Flush();
            _telemetry.Flush();
        }
        _stopped.Set();
    }

    public void WaitForStop() => _stopped.Wait();

    public void Marker(string note) => Emit("MARKER", new { note });

    private void OnSessionInfo()
    {
        try
        {
            var n = ++_sessionInfoCount;
            File.WriteAllText(Path.Combine(_runDir, $"sessioninfo-{n:000}.yaml"), _sdk.Data.SessionInfoYaml);

            // Best-effort typed summary; raw YAML above is the source of truth for analysis.
            string? summary = null;
            try
            {
                var w = _sdk.Data.SessionInfo.WeekendInfo;
                summary = $"track={w.TrackName} config={w.TrackConfigName} trackId={w.TrackID} sessionId={w.SessionID} subSessionId={w.SubSessionID}";
            }
            catch { summary = "(typed session info unavailable — see YAML)"; }

            Emit("SESSION_INFO", new { file = $"sessioninfo-{n:000}.yaml", summary });
        }
        catch (Exception ex)
        {
            Emit("RECORDER_ERROR", new { where = "OnSessionInfo", message = ex.ToString() });
        }
    }

    private void OnTelemetryData()
    {
        try
        {
            if (!_dumpedVars)
            {
                _dumpedVars = true;
                DumpVarHeaders();
            }

            var now = ReadWatched();

            DetectChanges(now);
            DetectLapBoundary(now);

            // 1 Hz snapshot regardless of changes, for offline timeline reconstruction.
            var tick = Environment.TickCount64;
            if (tick - _lastSnapshotTick >= 1000)
            {
                _lastSnapshotTick = tick;
                WriteLine(_telemetry, new { t = DateTimeOffset.Now, vars = now });
            }
        }
        catch (Exception ex)
        {
            Emit("RECORDER_ERROR", new { where = "OnTelemetryData", message = ex.ToString() });
        }
    }

    private Dictionary<string, object?> ReadWatched()
    {
        var vars = new Dictionary<string, object?>();
        var props = _sdk.Data.TelemetryDataProperties;

        foreach (var name in WatchedInts)
            vars[name] = props.ContainsKey(name) ? _sdk.Data.GetInt(name) : null;
        foreach (var name in WatchedFloats)
            vars[name] = props.ContainsKey(name) ? _sdk.Data.GetFloat(name) : null;
        foreach (var name in WatchedBools)
            vars[name] = props.ContainsKey(name) ? _sdk.Data.GetBool(name) : null;

        vars["SessionTime"] = props.ContainsKey("SessionTime") ? _sdk.Data.GetDouble("SessionTime") : null;
        vars["SessionFlags"] = props.ContainsKey("SessionFlags") ? _sdk.Data.GetBitField("SessionFlags") : null;

        return vars;
    }

    private void DetectChanges(Dictionary<string, object?> now)
    {
        // Int-valued state whose every transition matters for session-end and reset detection.
        foreach (var name in new[] { "SessionNum", "SessionState", "SessionUniqueID", "PlayerTrackSurface", "Lap", "EnterExitReset" })
        {
            if (now[name] is not int v) continue;
            if (_prevInts.TryGetValue(name, out var prev) && prev != v)
            {
                Emit("CHANGE", new { var = name, from = prev, to = v, sessionTime = now["SessionTime"] });

                if (name == "PlayerTrackSurface" && v == 0) _offTrackSeen = true; // 0 = OffTrack (verify in findings)
                if (name == "Lap" && v < prev) _resetSeen = true;                 // lap counter went backwards
            }
            _prevInts[name] = v;
        }

        foreach (var name in new[] { "OnPitRoad", "IsOnTrack", "IsInGarage" })
        {
            if (now[name] is not bool b) continue;
            if (_prevBools.TryGetValue(name, out var prev) && prev != b)
            {
                Emit("CHANGE", new { var = name, from = prev, to = b, sessionTime = now["SessionTime"] });
                if (name == "OnPitRoad" && b) _pitRoadSeen = true;
            }
            _prevBools[name] = b;
        }

        // Incident count changes mid-lap are the raw material for per-lap attribution.
        if (now["PlayerCarMyIncidentCount"] is int inc)
        {
            if (_prevInts.TryGetValue("PlayerCarMyIncidentCount", out var prev) && prev != inc)
                Emit("INCIDENT_COUNT_CHANGE", new
                {
                    from = prev,
                    to = inc,
                    lap = now["Lap"],
                    lapDistPct = now["LapDistPct"],
                    trackSurface = now["PlayerTrackSurface"],
                    sessionTime = now["SessionTime"],
                });
            _prevInts["PlayerCarMyIncidentCount"] = inc;
        }
    }

    private void DetectLapBoundary(Dictionary<string, object?> now)
    {
        if (now["LapCompleted"] is not int lapCompleted) return;

        if (_lastLapCompleted is null)
        {
            _lastLapCompleted = lapCompleted;
            _lapStartIncidentCount = now["PlayerCarMyIncidentCount"] as int?;
            return;
        }

        if (lapCompleted == _lastLapCompleted) return;

        if (lapCompleted < _lastLapCompleted)
        {
            // Session restart / reset — the exact conditions here are a spike question.
            Emit("LAP_COUNTER_RESET", new { from = _lastLapCompleted, to = lapCompleted, sessionTime = now["SessionTime"] });
        }
        else
        {
            var incNow = now["PlayerCarMyIncidentCount"] as int?;
            var lastLapTime = now["LapLastLapTime"] as float?;

            Emit("LAP_BOUNDARY", new
            {
                lapCompleted,
                lapLastLapTimeSec = lastLapTime,
                lapTimeMs = lastLapTime is > 0 ? (int)Math.Round(lastLapTime.Value * 1000) : (int?)null,
                incidentDelta = (incNow is not null && _lapStartIncidentCount is not null) ? incNow - _lapStartIncidentCount : null,
                offTrackSeen = _offTrackSeen,
                pitRoadSeen = _pitRoadSeen,
                resetSeen = _resetSeen,
                sessionNum = now["SessionNum"],
                sessionUniqueId = now["SessionUniqueID"],
                sessionTime = now["SessionTime"],
            });
        }

        _lastLapCompleted = lapCompleted;
        _lapStartIncidentCount = now["PlayerCarMyIncidentCount"] as int?;
        _offTrackSeen = false;
        _pitRoadSeen = false;
        _resetSeen = false;
    }

    private void DumpVarHeaders()
    {
        var path = Path.Combine(_runDir, "telemetry-vars.txt");
        using var w = new StreamWriter(path);
        foreach (var kvp in _sdk.Data.TelemetryDataProperties.OrderBy(k => k.Key))
            w.WriteLine(JsonSerializer.Serialize(kvp.Value, _json));

        var missing = WatchedInts.Concat(WatchedFloats).Concat(WatchedBools)
            .Where(name => !_sdk.Data.TelemetryDataProperties.ContainsKey(name))
            .ToArray();

        Emit("VAR_DUMP", new { file = "telemetry-vars.txt", count = _sdk.Data.TelemetryDataProperties.Count, missingWatchedVars = missing });
    }

    private void Emit(string type, object data)
    {
        var record = new { t = DateTimeOffset.Now, type, data };
        WriteLine(_events, record);
        Console.WriteLine($"[{record.t:HH:mm:ss}] {type} {JsonSerializer.Serialize(data, _json)}");
    }

    private void WriteLine(StreamWriter writer, object record)
    {
        lock (_lock)
        {
            writer.WriteLine(JsonSerializer.Serialize(record, _json));
        }
    }
}
