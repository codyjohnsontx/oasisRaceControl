namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// The live telemetry source: attaches to iRacing, decodes frames, and raises the
/// laps the venue keeps.
///
/// This is the piece that joins the three pure components built for this - the
/// shared-memory parser, the session-metadata reader, and the lap rules - to a
/// real, running simulator, and it is the only one of the four that owns a thread.
/// Everything it decides is still reachable from a unit test: the operating-system
/// attachment sits behind <see cref="ISimConnectionFactory"/>, and <see cref="Step"/>
/// performs exactly one attach-or-read, so a test drives the whole state machine
/// frame by frame without iRacing, without Windows, and without waiting on a clock.
///
/// What it has to survive, because a venue rig runs it unattended all day:
///
/// * <b>The sim comes and goes constantly.</b> A rig sits with iRacing closed
///   between customers. Not finding the sim is the normal state, not an error, and
///   the agent keeps the backend heartbeat alive throughout.
/// * <b>A reconnect must never invent a lap.</b> Losing the sim drops the lap
///   rules' state, so the first crossing after it comes back only re-establishes a
///   baseline (<see cref="LapDetector"/>). A lap whose start nobody watched has an
///   unknowable incident count, and the venue's rule is clean laps only.
/// * <b>The bytes are written by another process while they are read.</b> The
///   parser proves each frame was copied out untouched and reports no frame at all
///   rather than a mixture of two ticks; this waits for the next one, which is what
///   iRacing's own client does. A mapping that never yields a clean frame, and one
///   that describes itself impossibly, are both stops: the connection is dropped
///   and re-opened from scratch rather than parsed around.
/// * <b>Nothing it does may take the agent down.</b> The read loop contains every
///   failure, including one thrown by a lap subscriber, and reports it rather than
///   letting it reach the process.
/// </summary>
public sealed class IRacingTelemetrySource : ITelemetrySource, IDisposable
{
    /// <summary>How long to wait for the sim's next frame before looking again anyway.
    /// The sim publishes at 60 Hz while it is running, so this only expires when it
    /// has gone quiet - which is exactly when we want to re-check that it is there.</summary>
    private static readonly TimeSpan FrameWait = TimeSpan.FromMilliseconds(250);

    /// <summary>How long to wait before looking for the sim again. The rig spends most
    /// of its day here, so it is deliberately cheap rather than instant.</summary>
    private static readonly TimeSpan ReconnectWait = TimeSpan.FromSeconds(2);

    /// <summary>Consecutive frames that could not be decoded at all before the mapping is
    /// treated as unusable. A buffer rewritten mid-read is a separate outcome and is not
    /// counted here - this is for a header that cannot be followed.</summary>
    private const int MalformedReadsTolerated = 2;

    /// <summary>Attempts to read a given revision of the session metadata before giving
    /// up on it. Bounded so an unreadable payload cannot turn into a per-frame re-parse
    /// of a document that can be hundreds of kilobytes.</summary>
    private const int SessionInfoAttempts = 3;

    /// <summary>How long a session may go without publishing a frame before the sim is
    /// treated as gone. It publishes at 60 Hz while a session is live, so a gap this
    /// long is not slowness - it is a simulator that has stopped.</summary>
    private static readonly TimeSpan StaleAfter = TimeSpan.FromSeconds(5);

    private readonly ISimConnectionFactory _connections;
    private readonly LapDetector _detector;
    private readonly Func<DateTimeOffset> _clock;
    private readonly CancellationTokenSource _stop = new();

    private ISimConnection? _connection;
    private IrsdkMemoryParser? _parser;
    private SimSessionIdentity? _identity;
    private int? _lastSessionInfoUpdate;
    private int _sessionInfoAttempts;
    private int? _lastTick;
    private DateTimeOffset _tickMovedAt;
    private int _malformedReads;
    private volatile bool _simRunning;
    private TelemetryChannelReport? _channels;
    private volatile SimDecodeVerdict? _undecodable;
    private volatile SimReachVerdict? _unreachable;
    private Thread? _thread;

    /// <param name="rigNumber">Which simulator this agent runs on; namespaces lap identity.</param>
    /// <param name="connections">How to attach to the sim. Production passes
    /// <see cref="WindowsSimConnectionFactory"/>; tests pass a fake.</param>
    /// <param name="clock">Reads the completion time stamped on a lap. Tests pin it.</param>
    /// <param name="instanceId">Passed through to <see cref="LapDetector"/> to disambiguate
    /// sessions the sim did not give an id to.</param>
    public IRacingTelemetrySource(
        int rigNumber,
        ISimConnectionFactory connections,
        Func<DateTimeOffset>? clock = null,
        string? instanceId = null)
    {
        _connections = connections;
        _detector = new LapDetector(rigNumber, instanceId);
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>
    /// True when the sim is attached and publishing telemetry - not merely when
    /// iRacing's process exists. This is what the rig display and the staff dashboard
    /// mean by "sim running": the rig is in a state where a lap would be recorded.
    /// </summary>
    public bool SimRunning => _simRunning;

    /// <summary>A lap the venue keeps. Raised on the read thread.</summary>
    public event Action<LapCompleted>? LapCompleted;

    /// <summary>
    /// A crossing of the line that did not become a lap, with the reason.
    ///
    /// Dropping laps silently is how a leaderboard quietly stops matching what
    /// customers just drove, so the reason is surfaced rather than swallowed. The
    /// host logs it; nothing downstream depends on it.
    /// </summary>
    public event Action<LapDetection>? LapRejected;

    /// <summary>A failure the loop absorbed and recovered from, for the host to log.</summary>
    public event Action<Exception>? Faulted;

    /// <summary>
    /// What the sim just attached to actually publishes, checked against
    /// <see cref="TelemetryChannels"/>. Raised once per attach, pass or fail, because
    /// the pass is the evidence that this rig is reading the sim correctly and the
    /// fail is the only warning anyone gets before a night of missing laps.
    /// </summary>
    public event Action<TelemetryChannelReport>? ChannelsChecked;

    /// <summary>The last channel check, or null before the first frame of an attach.</summary>
    public TelemetryChannelReport? Channels => _channels;

    /// <summary>
    /// Why this rig cannot score, when the answer is something other than "iRacing is
    /// closed". Null when there is nothing wrong, which is the normal state whether a
    /// customer is driving or the machine is sitting idle between them.
    ///
    /// Three different failures reach here and every one of them leaves a rig looking
    /// exactly like an idle one. It is reading the sim and cannot judge a lap from it
    /// (<see cref="TelemetryChannels"/>), it attached and could not decode a frame at
    /// all (<see cref="SimDecode"/>), or it could not see the sim from where Windows
    /// is running it (<see cref="SimReach"/>).
    ///
    /// They are answered closest-first, which is also the order in which they can be
    /// true at the same time: a channel verdict belongs to a sim that decoded, a decode
    /// verdict to a sim that attached, and a reach reason only ever describes a failure
    /// to attach.
    /// </summary>
    public string? SimUnusableReason =>
        _channels is { CanScore: false } report ? report.BlockingSummary
        : _undecodable?.Summary ?? _unreachable?.Summary;

    /// <summary>
    /// Why the last frames this rig read could not be decoded, or null when they
    /// could. Null is the normal state whether a customer is driving or the machine
    /// is sitting idle.
    /// </summary>
    public SimDecodeVerdict? UndecodableReason => _undecodable;

    /// <summary>
    /// Raised when the reason this agent cannot see the simulator changes, including
    /// back to null when it starts working. Once per change, not once per attempt:
    /// the loop retries every couple of seconds and a rig runs all day.
    /// </summary>
    public event Action<SimReachVerdict?>? SimReachChanged;

    /// <summary>
    /// Raised when the reason this agent cannot decode the simulator's telemetry
    /// changes, including back to null when a frame decodes again. Once per change
    /// for the same reason as <see cref="SimReachChanged"/>: the loop drops the
    /// connection and re-attaches every couple of seconds for as long as it holds.
    /// </summary>
    public event Action<SimDecodeVerdict?>? SimDecodeChanged;

    public void Start()
    {
        if (_thread is not null) throw new InvalidOperationException("The telemetry source was already started.");
        // Stopping is final: the loop would exit on the first check, and a source that
        // silently reads nothing is worse than one that says it cannot start.
        if (_stop.IsCancellationRequested) throw new InvalidOperationException("The telemetry source was stopped.");
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "OasisRigAgent.Telemetry",
        };
        _thread.Start();
    }

    public void Stop()
    {
        if (!_stop.IsCancellationRequested) _stop.Cancel();
        var thread = _thread;
        if (thread is not null && thread != Thread.CurrentThread) thread.Join(TimeSpan.FromSeconds(5));
        _thread = null;
        Detach();
        _simRunning = false;
    }

    public void Dispose()
    {
        Stop();
        _stop.Dispose();
    }

    private void Run()
    {
        while (!_stop.IsCancellationRequested)
        {
            bool attached;
            try
            {
                attached = Step();
            }
            catch (Exception ex)
            {
                // Anything unexpected - a fault opening the mapping, a subscriber that
                // threw - is contained here. The agent's whole job is to still be
                // running when the next customer sits down, so the connection is
                // dropped and the loop backs off rather than the process ending.
                Detach();
                attached = false;
                Report(ex);
            }

            if (!attached) _stop.Token.WaitHandle.WaitOne(ReconnectWait);
        }

        Detach();
        _simRunning = false;
    }

    /// <summary>
    /// Performs one unit of work: attach to the sim if not attached, otherwise read
    /// and judge one frame. Returns whether the sim is attached, which is the caller's
    /// cue to back off before trying again.
    ///
    /// Public because it is the seam the tests drive. Calling it while
    /// <see cref="Start"/> is running would race the read thread; nothing in the agent
    /// does both.
    /// </summary>
    public bool Step()
    {
        if (_connection is null || _parser is null)
        {
            var connection = _connections.TryConnect();
            if (connection is null)
            {
                // Ordinary: iRacing is not open. Whatever the lap rules knew belonged
                // to a session that has ended.
                //
                // Not always ordinary, though: an agent Windows started outside the
                // signed-in user's session cannot see iRacing even when it is running,
                // and the failure is byte-for-byte this one. Asking why keeps that
                // machine from spending the night looking like an idle rig.
                Detach();
                ObserveReach(_connections.UnreachableReason);
                return false;
            }

            ObserveReach(null);

            try
            {
                _parser = new IrsdkMemoryParser(connection.Reader);
            }
            catch
            {
                connection.Dispose();
                throw;
            }

            _connection = connection;
            _identity = null;
            _lastSessionInfoUpdate = null;
            _sessionInfoAttempts = 0;
            _lastTick = null;
            _tickMovedAt = _clock();
            _malformedReads = 0;
            _channels = null;
            _detector.Reset();
        }

        _connection.WaitForFrame(FrameWait);
        if (_stop.IsCancellationRequested) return true;

        IrsdkFrame? frame;
        try
        {
            frame = _parser.Parse(LapDetector.WatchedVariables);
        }
        catch (MalformedTelemetryException ex)
        {
            if (++_malformedReads <= MalformedReadsTolerated) return true;
            Detach();
            // Said once per change rather than once per attempt. The connection is
            // dropped and re-opened every couple of seconds for as long as this holds,
            // and a reason repeated 1,800 times an hour buries everything else the rig
            // had to say - the same rule as an unreachable sim, above.
            if (ObserveDecode(SimDecode.Explain(ex))) Report(ex);
            return false;
        }

        _malformedReads = 0;
        ObserveDecode(null);
        return frame is null ? NoUsableFrame() : ObserveFrame(frame);
    }

    /// <summary>
    /// The sim was rewriting its telemetry buffer under every attempt to copy it, so
    /// there is nothing to judge this pass.
    ///
    /// One of these is ordinary and the answer is to read the next frame - dropping the
    /// connection over it would reset the lap rules and cost the customer their next lap
    /// for a race that resolves itself in 16 milliseconds. But if it is all this rig ever
    /// gets, the rig is not scoring and must not look healthy, so it falls to the same
    /// rule that catches a simulator which died with its last frame still in memory.
    /// </summary>
    private bool NoUsableFrame()
    {
        if (_clock() - _tickMovedAt <= StaleAfter) return true;
        Detach();
        Report(new TimeoutException(
            $"The sim rewrote its telemetry buffer under every read for {StaleAfter.TotalSeconds:0} seconds; reconnecting."));
        return false;
    }

    private bool ObserveFrame(IrsdkFrame frame)
    {
        if (!frame.IsConnected)
        {
            // The mapping is there but no session is live: iRacing is loading, sitting
            // in a menu, or has closed. The handle is let go rather than held, because
            // a mapping is resolved by name only when it is opened - iRacing starting
            // again publishes into a new one, and an agent still holding the old one
            // would watch a dead region for the rest of the day.
            Detach();
            return false;
        }

        var now = _clock();
        ReadSessionIdentity(frame);

        // The sim rewrites its buffers in place; an unchanged tick is the same frame
        // read twice, and judging it twice would double-count a lap.
        if (_lastTick == frame.TickCount)
        {
            // ...but a tick that has not moved for seconds is not a fast reader. It is
            // a simulator that died with its last frame still in memory, which would
            // otherwise leave the rig reporting a live session until someone noticed.
            if (now - _tickMovedAt <= StaleAfter) return true;
            Detach();
            Report(new TimeoutException(
                $"The sim published no telemetry for {StaleAfter.TotalSeconds:0} seconds; reconnecting."));
            return false;
        }

        _lastTick = frame.TickCount;
        _tickMovedAt = now;

        // What this sim publishes, checked once per attach and before any lap is
        // judged from it. The agent reads channels by name and a name that is not
        // there decodes to null, so an unchecked mismatch does not fail - it silently
        // turns off whichever rule reads it. See TelemetryChannels.
        if (_channels is null)
        {
            _channels = TelemetryChannels.Check(frame.Variables);
            Raise(ChannelsChecked, _channels);
        }

        if (!_channels.CanScore)
        {
            // The sim is running and readable, but a lap built from it could not be
            // judged clean - and the venue's rule is clean laps only. Publishing one
            // anyway would put a pit lap or an incident-laden lap on the leaderboard
            // as a real time, which is worse than this rig scoring nothing. So it
            // reads frames (staying attached, so the check re-runs when the sim is
            // restarted) and keeps every lap.
            _simRunning = false;
            return true;
        }

        _simRunning = true;

        var detection = _detector.Observe(frame.Values, _identity, now);
        switch (detection.Outcome)
        {
            case LapOutcome.None:
                break;
            case LapOutcome.Emitted when detection.Lap is { } lap:
                Raise(LapCompleted, lap);
                break;
            default:
                Raise(LapRejected, detection);
                break;
        }

        return true;
    }

    /// <summary>
    /// Hands a result to everyone listening, without letting any of them break the read.
    ///
    /// A subscriber that throws is a bug in the host, not evidence that the sim
    /// connection is bad, so it is reported and the loop reads the next frame - dropping
    /// the connection over it would cost the driver their next lap too. Listeners are
    /// called one at a time for the same reason: a display that falls over must not stop
    /// the lap reaching the queue that submits it.
    /// </summary>
    private void Raise<T>(Action<T>? listeners, T value)
    {
        if (listeners is null) return;
        foreach (var listener in listeners.GetInvocationList())
        {
            try { ((Action<T>)listener)(value); }
            catch (Exception ex) { Report(ex); }
        }
    }

    /// <summary>
    /// Keeps the track/car labels in step with the sim.
    ///
    /// The metadata is re-read only when the sim says it changed, because it is a
    /// large document and the frame rate is 60 Hz. When it does change, the old labels
    /// are dropped first: the change may be the customer switching car, and a lap
    /// labelled with the car before it is worse than a lap held back. If the new
    /// revision cannot be read, the lap rules see an unknown combination and drop
    /// laps until it can be.
    ///
    /// A revision that did not parse is the one case worth another copy of the same
    /// bytes: the sim writes that document in place, so the usual reason it does not
    /// parse is that it was read half-written. The parser hands out the copy it already
    /// took until asked for a fresh one, and asking is what makes the attempts below
    /// mean anything.
    /// </summary>
    private void ReadSessionIdentity(IrsdkFrame frame)
    {
        if (_lastSessionInfoUpdate != frame.SessionInfoUpdate)
        {
            _lastSessionInfoUpdate = frame.SessionInfoUpdate;
            _sessionInfoAttempts = 0;
            _identity = null;
        }

        if (_identity is not null || _sessionInfoAttempts >= SessionInfoAttempts) return;
        _sessionInfoAttempts++;
        _identity = IrsdkSessionInfo.Parse(frame.SessionInfoBytes);
        if (_identity is null) _parser?.RefreshSessionInfo();
    }

    /// <summary>Drops the sim connection and everything learned through it, so the next
    /// attach starts from nothing rather than from a session that has gone.</summary>
    private void Detach()
    {
        var connection = Interlocked.Exchange(ref _connection, null);
        try { connection?.Dispose(); }
        catch (Exception ex) { Report(ex); }

        _parser = null;
        _identity = null;
        _lastSessionInfoUpdate = null;
        _sessionInfoAttempts = 0;
        _lastTick = null;
        _malformedReads = 0;
        _simRunning = false;
        _channels = null;
        _detector.Reset();
    }

    /// <summary>
    /// Records why the agent could not see the simulator, and says so only when the
    /// answer changes.
    ///
    /// The reasons this carries are settled facts about how the machine was set up,
    /// so they hold for the life of the process. Announcing one per attempt would put
    /// the same line in the log 1,800 times an hour and bury everything else the rig
    /// had to say.
    /// </summary>
    private void ObserveReach(SimReachVerdict? reason)
    {
        if (reason == _unreachable) return;
        _unreachable = reason;
        try { SimReachChanged?.Invoke(reason); }
        catch (Exception ex) { Report(ex); }
    }

    /// <summary>
    /// Records why frames from this rig's simulator cannot be decoded, and says so
    /// only when the answer changes. Returns whether it changed.
    ///
    /// Deliberately not cleared by <see cref="Detach"/>, unlike everything else the
    /// connection taught this source. What it carries is a fact about what the
    /// simulator on this machine publishes, not a reading of a live session: dropping
    /// it with the connection would leave the rig reporting a healthy idle machine
    /// again two seconds later, and it is the couple of hours before the first
    /// customer sits down that are worth being told in. Only a frame that decodes
    /// clears it, and a single unreadable frame never sets it
    /// (<see cref="MalformedReadsTolerated"/>) - a mapping caught mid-rewrite is an
    /// ordinary event with its own answer.
    /// </summary>
    private bool ObserveDecode(SimDecodeVerdict? reason)
    {
        if (reason == _undecodable) return false;
        _undecodable = reason;
        try { SimDecodeChanged?.Invoke(reason); }
        catch (Exception ex) { Report(ex); }
        return true;
    }

    private void Report(Exception ex)
    {
        try { Faulted?.Invoke(ex); }
        catch { /* a broken error handler must not become the error */ }
    }
}
