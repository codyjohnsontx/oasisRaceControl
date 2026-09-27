using System.ComponentModel;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace OasisRigAgent.Core.Iracing;

/// <summary>
/// The real telemetry source: reads iRacing's shared memory on the rig PC and
/// turns it into completed laps through <see cref="LapDetector"/>.
///
/// The read path is the spike recorder's, unchanged in what it asks Windows
/// for: the map `Local\IRSDKMemMapFileName` is opened with read rights only,
/// the data-ready event `Local\IRSDKDataValidEvent` with SYNCHRONIZE only, and
/// nothing is ever written to the sim. iRacing not running, or closed and
/// reopened, is the normal case: the reader retries once a second, reports
/// <see cref="SimRunning"/> false meanwhile, and resets the detector so laps
/// from the previous session cannot bleed into the next.
///
/// Beyond the <see cref="ITelemetrySource"/> contract it exposes what the
/// diagnostic mode and the agent log print: connection changes, the combo
/// strings as parsed, every lap decision, and the variables iRacing did not
/// publish.
/// </summary>
public sealed class IracingTelemetrySource : ITelemetrySource, IDisposable
{
    private const string MemoryMapName = "Local\\IRSDKMemMapFileName";
    private const string DataEventName = "Local\\IRSDKDataValidEvent";
    private const uint Synchronize = 0x00100000;
    private const int ErrorFileNotFound = 2;
    private const int ErrorInvalidName = 123;
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(1);

    private readonly LapDetector _detector;
    private readonly CancellationTokenSource _stop = new();
    private Thread? _thread;
    private volatile bool _connected;

    public IracingTelemetrySource(LapDetector? detector = null)
    {
        _detector = detector ?? new LapDetector();
        _detector.Decided += decision =>
        {
            LapDecided?.Invoke(decision);
            if (decision.Lap is not null) LapCompleted?.Invoke(decision.Lap);
        };
    }

    public bool SimRunning => _connected;
    public event Action<LapCompleted>? LapCompleted;

    /// <summary>iRacing connected (true) or went away (false).</summary>
    public event Action<bool>? ConnectionChanged;
    /// <summary>Session info was (re)read and named a track and car - or did not, null.</summary>
    public event Action<SessionCombo?>? ComboChanged;
    /// <summary>Every lap boundary, posted or skipped, with the reason.</summary>
    public event Action<LapDecision>? LapDecided;
    /// <summary>Watched variables this iRacing build does not publish, once per connection.</summary>
    public event Action<IReadOnlyList<string>>? MissingVariables;
    /// <summary>Something the read loop could not recover from. It stops; the agent keeps running without laps.</summary>
    public event Action<Exception>? Faulted;

    public void Start()
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("iRacing telemetry is read from Windows shared memory; run this on the rig PC.");
        if (_thread is not null) throw new InvalidOperationException("The telemetry source was already started.");
        _thread = new Thread(Run) { IsBackground = true, Name = "OasisRigAgent.IracingTelemetry" };
        _thread.Start();
    }

    public void Stop()
    {
        _stop.Cancel();
        if (_thread is not null && _thread != Thread.CurrentThread) _thread.Join(TimeSpan.FromSeconds(5));
    }

    public void Dispose()
    {
        Stop();
        _stop.Dispose();
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private void Run()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                using var map = MemoryMappedFile.OpenExisting(MemoryMapName, MemoryMappedFileRights.Read);
                using var view = map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
                using var reader = new AccessorReader(view);
                using var dataEvent = OpenSynchronizationEvent();
                ReadLoop(reader, dataEvent);
            }
            catch (FileNotFoundException)
            {
                SetConnected(false);
                _stop.Token.WaitHandle.WaitOne(ReconnectDelay);
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode is ErrorFileNotFound or ErrorInvalidName)
            {
                SetConnected(false);
                _stop.Token.WaitHandle.WaitOne(ReconnectDelay);
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                SetConnected(false);
                Faulted?.Invoke(ex);
                break;
            }
        }
        SetConnected(false);
    }

    private void ReadLoop(IReadOnlyMemoryReader reader, EventWaitHandle dataEvent)
    {
        var parser = new IracingMemoryParser(reader);
        var lastTick = int.MinValue;
        var lastSessionUpdate = int.MinValue;
        var malformedReads = 0;
        var reportedMissing = false;

        while (!_stop.IsCancellationRequested)
        {
            WaitHandle.WaitAny([dataEvent, _stop.Token.WaitHandle], TimeSpan.FromMilliseconds(250));
            if (_stop.IsCancellationRequested) return;

            try
            {
                var parsed = parser.Parse(TelemetryTick.VariableNames);
                malformedReads = 0;
                SetConnected(parsed.IsConnected);
                if (!parsed.IsConnected)
                {
                    // iRacing is up but not in a session (menus, loading). Laps
                    // cannot continue across that, so start clean when it returns.
                    lastSessionUpdate = int.MinValue;
                    reportedMissing = false;
                    continue;
                }

                if (!reportedMissing)
                {
                    reportedMissing = true;
                    var missing = TelemetryTick.VariableNames.Where(n => !parsed.Variables.ContainsKey(n)).Order().ToList();
                    if (missing.Count > 0) MissingVariables?.Invoke(missing);
                }

                if (parsed.SessionInfoUpdate != lastSessionUpdate && parsed.SessionInfoBytes is not null)
                {
                    lastSessionUpdate = parsed.SessionInfoUpdate;
                    var yaml = SessionInfoParser.Decode(parsed.SessionInfoBytes);
                    var playerIdx = parsed.Values.TryGetValue("PlayerCarIdx", out var idx) && idx is int i ? i : (int?)null;
                    var combo = SessionInfoParser.Parse(yaml, playerIdx);
                    if (!Equals(combo, _detector.Combo))
                    {
                        _detector.Combo = combo;
                        ComboChanged?.Invoke(combo);
                    }
                }

                if (parsed.TickCount != lastTick)
                {
                    lastTick = parsed.TickCount;
                    _detector.Observe(TelemetryTick.FromValues(parsed.Values));
                }
            }
            catch (MalformedTelemetryException) when (++malformedReads < 3)
            {
                // The producer can swap buffers while a frame is being read.
                // Two retries tolerate that race; a third is a real fault.
                Thread.Yield();
            }
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static EventWaitHandle OpenSynchronizationEvent()
    {
        var handle = NativeMethods.OpenEvent(Synchronize, false, DataEventName);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return new EventWaitHandle(false, EventResetMode.AutoReset) { SafeWaitHandle = handle };
    }

    private void SetConnected(bool connected)
    {
        if (_connected == connected) return;
        _connected = connected;
        if (!connected)
        {
            _detector.Reset();
            _detector.Combo = null;
        }
        ConnectionChanged?.Invoke(connected);
    }

    private sealed class AccessorReader : IReadOnlyMemoryReader, IDisposable
    {
        private readonly MemoryMappedViewAccessor _accessor;
        public AccessorReader(MemoryMappedViewAccessor accessor) => _accessor = accessor;
        public long Capacity => _accessor.Capacity;

        public void Read(long offset, Span<byte> destination)
        {
            if (destination.Length > 1024)
            {
                var buffer = new byte[destination.Length];
                _accessor.ReadArray(offset, buffer, 0, buffer.Length);
                buffer.CopyTo(destination);
                return;
            }
            for (var index = 0; index < destination.Length; index++)
                destination[index] = _accessor.ReadByte(offset + index);
        }

        public void Dispose() { }
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", EntryPoint = "OpenEventW", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeWaitHandle OpenEvent(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, string name);
    }
}
