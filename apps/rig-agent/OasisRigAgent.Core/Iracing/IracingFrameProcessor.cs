namespace OasisRigAgent.Core.Iracing;

/// <summary>What one read of the shared-memory block amounted to.</summary>
public enum FrameOutcome
{
    /// <summary>The header's connected bit is clear: iRacing is not in a session.</summary>
    NotConnected,
    /// <summary>The frame was malformed but the previous ones were fine - the
    /// producer may be mid-swap. Read again straight away.</summary>
    Retry,
    /// <summary>The block is there but not usable yet (a header still being
    /// filled in while a session loads, or one this reader cannot make sense
    /// of). Treated as not connected; try again in a second.</summary>
    NotReady,
    /// <summary>A telemetry frame was processed.</summary>
    Frame,
}

/// <summary>
/// The platform-independent half of the iRacing read loop: given a reader over
/// the block, decide what this read means and feed the lap detector. Kept out
/// of the Windows thread so it can be driven by a synthetic block in tests,
/// which is how the case the first real rig produced is pinned: a header whose
/// connected bit is set while <c>tickRate</c> is still 0, seen the moment a
/// test drive starts loading.
///
/// The rule this class exists to enforce: <b>no read ever stops the loop</b>.
/// A header that is unready or implausible is "not connected yet", reported
/// once per distinct reason, and read again.
///
/// The connected bit alone cannot say the sim is still there: a hung or
/// crashed iRacing leaves it set and the block readable. So, as the iRacing
/// SDK's own connection check does, a block whose tick count has not moved
/// for <see cref="StallTimeout"/> is treated as not connected until it moves.
/// </summary>
public sealed class IracingFrameProcessor
{
    /// <summary>How long the tick count may stand still under a set connected
    /// bit before the sim counts as gone. The SDK's own connection check
    /// (irsdk_isConnected in irsdk_utils.cpp) calls a block with no new tick
    /// for 30 seconds disconnected, so this is the SDK's figure, not a tuning knob.</summary>
    public static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(30);

    private readonly LapDetector _detector;
    private readonly Func<long> _nowMs;
    private int? _progressTick;
    private long _progressAtMs;
    private IReadOnlyMemoryReader? _readerOf;
    private IracingMemoryParser? _parser;
    private int _lastTick = int.MinValue;
    private int _sessionReadUpdate = int.MinValue;
    private int _sessionReadTick;
    private bool _sessionNamed;
    private string? _reportedIncomplete;
    private int _consecutiveMalformed;
    private bool _reportedMissing;
    private bool _reportedAttached;
    private string? _lastRejection;

    /// <param name="nowMs">A monotonic millisecond clock; defaults to <see cref="Environment.TickCount64"/>.</param>
    public IracingFrameProcessor(LapDetector detector, Func<long>? nowMs = null)
    {
        _detector = detector;
        _nowMs = nowMs ?? (() => Environment.TickCount64);
    }

    public bool Connected { get; private set; }

    /// <summary>iRacing connected (true) or went away (false).</summary>
    public event Action<bool>? ConnectionChanged;
    /// <summary>The header as read the first time a frame was accepted after attaching.</summary>
    public event Action<RawHeader>? Attached;
    /// <summary>A read was rejected and the block is being treated as not ready.
    /// Raised once per distinct reason; the header is null when even that could not be read.</summary>
    public event Action<RawHeader?, string>? HeaderRejected;
    /// <summary>Session info was (re)read and named a different track and car.
    /// Session info that names none yet is read again once a second of sim time
    /// and never replaces a combo already named during this connection.</summary>
    public event Action<SessionCombo>? ComboChanged;
    /// <summary>Session info was read but named no track and car for the player
    /// while none was known yet, with what it did find - raised again only when
    /// that changes, so the last one shows the state loading settled in.</summary>
    public event Action<string>? SessionInfoIncomplete;
    /// <summary>Watched variables this iRacing build does not publish, once per connection.</summary>
    public event Action<IReadOnlyList<string>>? MissingVariables;

    public FrameOutcome Process(IReadOnlyMemoryReader reader)
    {
        if (!ReferenceEquals(reader, _readerOf))
        {
            _readerOf = reader;
            _parser = null;
        }

        try
        {
            var header = IracingMemoryParser.ReadHeader(reader);
            if (!header.Connected)
            {
                // Menus, loading, or the sim on its way out. Laps cannot
                // continue across this, so start clean when it comes back.
                SetConnected(false);
                return FrameOutcome.NotConnected;
            }

            _parser ??= new IracingMemoryParser(reader);
            var parsed = _parser.Parse(TelemetryTick.VariableNames);
            if (!parsed.IsConnected)
            {
                SetConnected(false);
                return FrameOutcome.NotConnected;
            }
            if (Stalled(parsed.TickCount))
            {
                SetConnected(false);
                var reason = $"tickCount {parsed.TickCount} has not advanced in {StallTimeout.TotalSeconds:0}s: iRacing stopped updating the block.";
                if (reason != _lastRejection)
                {
                    _lastRejection = reason;
                    HeaderRejected?.Invoke(header, reason);
                }
                return FrameOutcome.NotConnected;
            }
            _consecutiveMalformed = 0;
            _lastRejection = null;

            if (!_reportedAttached)
            {
                _reportedAttached = true;
                Attached?.Invoke(header);
            }
            SetConnected(true);

            if (!_reportedMissing)
            {
                _reportedMissing = true;
                var missing = TelemetryTick.VariableNames.Where(n => !parsed.Variables.ContainsKey(n)).Order().ToList();
                if (missing.Count > 0) MissingVariables?.Invoke(missing);
            }

            // Named sessions are re-read only when iRacing bumps the update
            // counter; one still unnamed is retried once a second of sim time.
            if (parsed.SessionInfoUpdate != _sessionReadUpdate
                || (!_sessionNamed && parsed.TickCount - _sessionReadTick >= parsed.TickRate))
            {
                if (!ReadSessionInfo(parsed))
                {
                    SetConnected(false);
                    return FrameOutcome.NotConnected;
                }
            }

            if (parsed.TickCount != _lastTick)
            {
                _lastTick = parsed.TickCount;
                _detector.Observe(TelemetryTick.FromValues(parsed.Values));
            }
            return FrameOutcome.Frame;
        }
        catch (MalformedTelemetryException ex)
        {
            // The producer can swap buffers while a frame is being read, so a
            // frame that follows good ones gets two immediate retries.
            if (Connected && ++_consecutiveMalformed < 3) return FrameOutcome.Retry;

            // Otherwise the block is not usable right now. That is the state
            // iRacing leaves it in while a session loads - the first real rig
            // showed tickRate=0 under a set connected bit - and it clears by
            // itself, so it is reported and waited out, never fatal.
            _consecutiveMalformed = 0;
            _parser = null;
            SetConnected(false);
            if (ex.Message != _lastRejection)
            {
                _lastRejection = ex.Message;
                HeaderRejected?.Invoke(TryReadHeader(reader), ex.Message);
            }
            return FrameOutcome.NotReady;
        }
    }

    /// <summary>True once the tick count has stood still for <see cref="StallTimeout"/>.
    /// Tracked apart from the connection so that going not-connected does not
    /// make the frozen tick look new again.</summary>
    private bool Stalled(int tick)
    {
        var now = _nowMs();
        if (tick != _progressTick)
        {
            _progressTick = tick;
            _progressAtMs = now;
            return false;
        }
        return now - _progressAtMs >= (long)StallTimeout.TotalMilliseconds;
    }

    /// <summary>False when the sim left the session before its session info could be read.</summary>
    private bool ReadSessionInfo(ParsedMemorySnapshot parsed)
    {
        var bytes = _parser!.ReadSessionInfo();
        if (bytes is null) return false;
        _sessionReadUpdate = parsed.SessionInfoUpdate;
        _sessionReadTick = parsed.TickCount;
        var yaml = SessionInfoParser.Decode(bytes);
        var playerIdx = parsed.Values.TryGetValue("PlayerCarIdx", out var idx) && idx is int i ? i : (int?)null;
        var combo = SessionInfoParser.Parse(yaml, playerIdx);
        _sessionNamed = combo is not null;
        if (combo is null)
        {
            var found = SessionInfoParser.DescribeFound(yaml, playerIdx);
            if (_detector.Combo is null && found != _reportedIncomplete)
            {
                _reportedIncomplete = found;
                SessionInfoIncomplete?.Invoke(found);
            }
        }
        else if (!Equals(combo, _detector.Combo))
        {
            _detector.Combo = combo;
            ComboChanged?.Invoke(combo);
        }
        return true;
    }

    /// <summary>The map went away (iRacing closed).</summary>
    public void Detach()
    {
        _parser = null;
        _readerOf = null;
        _progressTick = null;
        SetConnected(false);
    }

    private static RawHeader? TryReadHeader(IReadOnlyMemoryReader reader)
    {
        try { return IracingMemoryParser.ReadHeader(reader); }
        catch (MalformedTelemetryException) { return null; }
    }

    private void SetConnected(bool connected)
    {
        if (Connected == connected) return;
        Connected = connected;
        if (!connected)
        {
            _detector.Reset();
            _detector.Combo = null;
            _lastTick = int.MinValue;
            _sessionReadUpdate = int.MinValue;
            _sessionNamed = false;
            _reportedIncomplete = null;
            _reportedMissing = false;
            _reportedAttached = false;
        }
        ConnectionChanged?.Invoke(connected);
    }
}
