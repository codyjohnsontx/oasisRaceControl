using System.Buffers.Binary;
using OasisRigAgent.Core.IRacing;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// A simulator the tests can drive: shared memory in iRacing's own layout, with
/// the channels the lap rules watch, that can be advanced a frame at a time.
///
/// This is what makes the whole live path testable on any machine. The agent
/// above it does not know it is not iRacing - it opens the same bytes, decodes
/// the same frames, and applies the same rules.
/// </summary>
internal sealed class FakeSim
{
    private const int LapCompletedOffset = 0;
    private const int LapOffset = 4;
    private const int IncidentsOffset = 8;
    private const int SurfaceOffset = 12;
    private const int SessionNumOffset = 16;
    private const int SessionUniqueIdOffset = 20;
    private const int LastLapTimeOffset = 24;
    private const int OnPitRoadOffset = 28;
    private const int IsOnTrackOffset = 29;
    private const int IsInGarageOffset = 30;
    private const int IsReplayPlayingOffset = 31;

    private const int SurfaceOnTrack = 3;

    private readonly IrsdkMemoryFixture _fixture = new();
    private int _tick = 100;
    private int _sessionInfoUpdate = 1;

    /// <summary>Shaped like the sim's own payload, trimmed to the fields the venue reads.</summary>
    internal const string SpaInAPorsche = """
        WeekendInfo:
         TrackName: spa gp
         TrackID: 341
         TrackDisplayName: Circuit de Spa-Francorchamps
         TrackConfigName: Grand Prix Pits
        DriverInfo:
         DriverCarIdx: 1
         Drivers:
         - CarIdx: 0
           CarScreenName: Pace Car
           CarID: 0
         - CarIdx: 1
           CarScreenName: Porsche 911 GT3 R
           CarID: 173
        """;

    internal const string MonzaInAFerrari = """
        WeekendInfo:
         TrackName: monza full
         TrackID: 349
         TrackDisplayName: Autodromo Nazionale Monza
         TrackConfigName: Grand Prix
        DriverInfo:
         DriverCarIdx: 1
         Drivers:
         - CarIdx: 1
           CarScreenName: Ferrari 296 GT3
           CarID: 192
        """;

    internal FakeSim() : this(omitted: null)
    {
    }

    /// <param name="omitted">Channels this build of the sim does not publish - what a
    /// different iRacing version, or a name the agent got wrong, looks like from here.</param>
    /// <param name="retyped">Channels published under a different type than the agent
    /// expects, which reads as absent rather than as a wrong value.</param>
    internal FakeSim(
        IEnumerable<string>? omitted,
        IReadOnlyDictionary<string, IrsdkVariableType>? retyped = null)
    {
        var skip = new HashSet<string>(omitted ?? [], StringComparer.Ordinal);

        void Publish(string name, IrsdkVariableType type, int offset, object value)
        {
            if (skip.Contains(name)) return;
            if (retyped is not null && retyped.TryGetValue(name, out var other))
            {
                _fixture.AddVariable(name, other, offset, Retype(other, value));
                return;
            }

            _fixture.AddVariable(name, type, offset, value);
        }

        Publish("LapCompleted", IrsdkVariableType.Int, LapCompletedOffset, 3);
        Publish("Lap", IrsdkVariableType.Int, LapOffset, 4);
        Publish("PlayerCarMyIncidentCount", IrsdkVariableType.Int, IncidentsOffset, 0);
        Publish("PlayerTrackSurface", IrsdkVariableType.Int, SurfaceOffset, SurfaceOnTrack);
        Publish("SessionNum", IrsdkVariableType.Int, SessionNumOffset, 0);
        Publish("SessionUniqueID", IrsdkVariableType.Int, SessionUniqueIdOffset, 7);
        Publish("LapLastLapTime", IrsdkVariableType.Float, LastLapTimeOffset, 0f);
        Publish("OnPitRoad", IrsdkVariableType.Bool, OnPitRoadOffset, false);
        Publish("IsOnTrack", IrsdkVariableType.Bool, IsOnTrackOffset, true);
        Publish("IsInGarage", IrsdkVariableType.Bool, IsInGarageOffset, false);
        Publish("IsReplayPlaying", IrsdkVariableType.Bool, IsReplayPlayingOffset, false);
        SetSessionInfo(SpaInAPorsche);
    }

    private static object Retype(IrsdkVariableType type, object value) => type switch
    {
        IrsdkVariableType.Float => Convert.ToSingle(AsNumber(value)),
        IrsdkVariableType.Double => AsNumber(value),
        IrsdkVariableType.Bool => AsNumber(value) != 0,
        _ => Convert.ToInt32(AsNumber(value)),
    };

    private static double AsNumber(object value) => value is bool flag ? (flag ? 1 : 0) : Convert.ToDouble(value);

    /// <summary>The mapping itself. Held live, so a change here is visible to a reader
    /// that already attached - exactly as the running sim behaves.</summary>
    internal byte[] Bytes => _fixture.Bytes;

    /// <summary>Publishes the next frame. The sim advances its tick on every one.</summary>
    internal FakeSim NextFrame()
    {
        _fixture.WriteInt(48, ++_tick);
        return this;
    }

    /// <summary>Republishes the current frame without advancing the tick, the way a
    /// reader that polls faster than the sim publishes sees it.</summary>
    internal FakeSim RepeatFrame() => this;

    internal FakeSim CrossTheLine(int lapCompleted, float lastLapTimeSeconds)
    {
        WriteInt(LapCompletedOffset, lapCompleted);
        WriteInt(LapOffset, lapCompleted + 1);
        WriteFloat(LastLapTimeOffset, lastLapTimeSeconds);
        return NextFrame();
    }

    /// <summary>
    /// Crosses the line the way a simulator that moves the lap counter before it
    /// publishes the time does: the counter goes up and the time channel still holds
    /// what the PREVIOUS lap took. Which of the two orderings iRacing actually uses
    /// has never been established here (docs/spike-findings.md), so the agent is
    /// driven against both.
    /// </summary>
    internal FakeSim CrossTheLineBeforePublishingTheTime(int lapCompleted)
    {
        WriteInt(LapCompletedOffset, lapCompleted);
        WriteInt(LapOffset, lapCompleted + 1);
        return NextFrame();
    }

    /// <summary>The time for the lap that has already been counted.</summary>
    internal FakeSim PublishLapTime(float seconds)
    {
        WriteFloat(LastLapTimeOffset, seconds);
        return NextFrame();
    }

    internal FakeSim Incidents(int total)
    {
        WriteInt(IncidentsOffset, total);
        return this;
    }

    internal FakeSim OnPitRoad(bool onPitRoad)
    {
        WriteBool(OnPitRoadOffset, onPitRoad);
        return this;
    }

    /// <summary>Puts the car's own tyres off the racing surface, or back on it.
    /// irsdk_TrkLoc: 0 is off track, 3 is on it.</summary>
    internal FakeSim OffTrack(bool offTrack)
    {
        WriteInt(SurfaceOffset, offTrack ? 0 : SurfaceOnTrack);
        return this;
    }

    internal FakeSim SessionId(int uniqueId)
    {
        WriteInt(SessionUniqueIdOffset, uniqueId);
        return this;
    }

    internal FakeSim SetSessionInfo(string payload, bool announceChange = true)
    {
        _fixture.SetSessionInfo(payload);
        if (announceChange) _fixture.WriteInt(12, ++_sessionInfoUpdate);
        return this;
    }

    /// <summary>Announces a new session document and gets only the first part of it
    /// written before the agent looks - the sim writes that document straight into the
    /// mapping, and the length it declares is the finished one's.</summary>
    internal FakeSim BeginSessionInfo(string payload, int written)
    {
        _fixture.SetPartialSessionInfo(payload, written);
        _fixture.WriteInt(12, ++_sessionInfoUpdate);
        return this;
    }

    /// <summary>Clears the sim's "in a session" flag: iRacing is open, but nothing is
    /// being driven.</summary>
    internal FakeSim InASession(bool inASession)
    {
        _fixture.WriteInt(4, inASession ? 1 : 0);
        return this;
    }

    /// <summary>
    /// The layout version the sim stamps on its telemetry. Anything other than the
    /// one this agent reads is what an iRacing build that moved the format looks like
    /// from here - the whole fleet, on the same forced update.
    /// </summary>
    internal FakeSim LayoutVersion(int version)
    {
        _fixture.WriteInt(0, version);
        return this;
    }

    /// <summary>Makes the mapping describe itself impossibly - a header that cannot be
    /// followed, as opposed to a buffer rewritten mid-read, which is
    /// <see cref="TearingMemoryReader"/>.</summary>
    internal FakeSim Corrupt(bool corrupt)
    {
        _fixture.WriteInt(8, corrupt ? 0 : 60);
        return this;
    }

    private void WriteInt(int valueOffset, int value) =>
        _fixture.WriteInt(IrsdkMemoryFixture.BufferOffset + valueOffset, value);

    private void WriteFloat(int valueOffset, float value) =>
        _fixture.WriteInt(IrsdkMemoryFixture.BufferOffset + valueOffset, BitConverter.SingleToInt32Bits(value));

    private void WriteBool(int valueOffset, bool value) =>
        Bytes[IrsdkMemoryFixture.BufferOffset + valueOffset] = value ? (byte)1 : (byte)0;
}

/// <summary>One attachment to the fake sim, which records what the agent did with it.</summary>
internal sealed class FakeSimConnection : ISimConnection
{
    private readonly Func<TimeSpan, bool>? _onWait;

    internal FakeSimConnection(byte[] bytes, Func<TimeSpan, bool>? onWait = null)
        : this(new ByteArrayMemoryReader(bytes), onWait)
    {
    }

    internal FakeSimConnection(IReadOnlyMemoryReader reader, Func<TimeSpan, bool>? onWait = null)
    {
        Reader = reader;
        _onWait = onWait;
    }

    public IReadOnlyMemoryReader Reader { get; }
    internal bool Disposed { get; private set; }
    internal int Waits { get; private set; }

    public bool WaitForFrame(TimeSpan timeout)
    {
        Waits++;
        return _onWait?.Invoke(timeout) ?? true;
    }

    public void Dispose() => Disposed = true;
}

/// <summary>Stands in for "is iRacing running on this rig right now?".</summary>
internal sealed class FakeSimConnectionFactory : ISimConnectionFactory
{
    private readonly FakeSim _sim;

    internal FakeSimConnectionFactory(FakeSim sim) => _sim = sim;

    /// <summary>Whether the sim is running. Flipping this is how a test closes and
    /// re-opens iRacing under the agent.</summary>
    internal bool SimIsRunning { get; set; } = true;

    /// <summary>Set to make attaching fail outright, as a genuinely unexpected fault would.</summary>
    internal Func<Exception>? FailWith { get; set; }

    /// <summary>
    /// Why nothing attaches, when it is not "iRacing is closed" - how a test stands in
    /// for an agent Windows started outside the signed-in user's session, or as an
    /// account that may not read the sim's memory.
    /// </summary>
    public SimReachVerdict? UnreachableReason { get; set; }

    /// <summary>Called instead of blocking on the sim's frame signal.</summary>
    internal Func<TimeSpan, bool>? OnWait { get; set; }

    /// <summary>How the agent reads this sim's memory, when a test needs the sim to
    /// write into it part-way through a read.</summary>
    internal IReadOnlyMemoryReader? ReadThrough { get; set; }

    internal List<FakeSimConnection> Opened { get; } = new();
    internal int Attempts { get; private set; }
    internal FakeSimConnection? Latest => Opened.Count == 0 ? null : Opened[^1];

    public ISimConnection? TryConnect()
    {
        Attempts++;
        if (FailWith is { } fail) throw fail();
        if (!SimIsRunning) return null;
        var connection = ReadThrough is null
            ? new FakeSimConnection(_sim.Bytes, OnWait)
            : new FakeSimConnection(ReadThrough, OnWait);
        Opened.Add(connection);
        return connection;
    }
}
