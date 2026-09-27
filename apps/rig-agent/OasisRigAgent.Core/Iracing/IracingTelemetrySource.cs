using System.ComponentModel;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
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
/// from the previous session cannot bleed into the next. What each read means
/// is decided by <see cref="IracingFrameProcessor"/>, and no read ever ends
/// the loop: an unready header is waited out, not faulted.
///
/// Beyond the <see cref="ITelemetrySource"/> contract it exposes what the
/// diagnostic mode and the agent log print: connection changes, the raw
/// header on attach and on rejection, the combo strings as parsed, every lap
/// decision, and the variables iRacing did not publish.
/// </summary>
public sealed class IracingTelemetrySource : ITelemetrySource, IDisposable
{
    private const string MemoryMapName = "Local\\IRSDKMemMapFileName";
    private const string DataEventName = "Local\\IRSDKDataValidEvent";
    private const uint Synchronize = 0x00100000;
    private const int ErrorFileNotFound = 2;
    private const int ErrorInvalidName = 123;
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(1);

    private readonly IracingFrameProcessor _frames;
    private readonly CancellationTokenSource _stop = new();
    private Thread? _thread;

    public IracingTelemetrySource(LapDetector? detector = null)
    {
        var lapDetector = detector ?? new LapDetector();
        lapDetector.Decided += decision =>
        {
            LapDecided?.Invoke(decision);
            if (decision.Lap is not null) LapCompleted?.Invoke(decision.Lap);
        };
        _frames = new IracingFrameProcessor(lapDetector);
        _frames.ConnectionChanged += up => ConnectionChanged?.Invoke(up);
        _frames.Attached += header => Attached?.Invoke(header);
        _frames.HeaderRejected += (header, reason) => HeaderRejected?.Invoke(header, reason);
        _frames.ComboChanged += combo => ComboChanged?.Invoke(combo);
        _frames.SessionInfoIncomplete += found => SessionInfoIncomplete?.Invoke(found);
        _frames.MissingVariables += names => MissingVariables?.Invoke(names);
    }

    public bool SimRunning => _frames.Connected;
    public event Action<LapCompleted>? LapCompleted;

    /// <summary>iRacing connected (true) or went away (false).</summary>
    public event Action<bool>? ConnectionChanged;
    /// <summary>The raw header the first time a frame is accepted after attaching.</summary>
    public event Action<RawHeader>? Attached;
    /// <summary>A read was rejected and the block is being waited out; once per distinct reason.</summary>
    public event Action<RawHeader?, string>? HeaderRejected;
    /// <summary>Session info was (re)read and named a different track and car.</summary>
    public event Action<SessionCombo>? ComboChanged;
    /// <summary>Session info named no track and car yet; once per connection, with what it did find.</summary>
    public event Action<string>? SessionInfoIncomplete;
    /// <summary>Every lap boundary, posted or skipped, with the reason.</summary>
    public event Action<LapDecision>? LapDecided;
    /// <summary>Watched variables this iRacing build does not publish, once per connection.</summary>
    public event Action<IReadOnlyList<string>>? MissingVariables;
    /// <summary>Something outside telemetry itself the loop could not recover from
    /// (the map could be opened but not read at all). It stops; the agent keeps running without laps.</summary>
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

    [SupportedOSPlatform("windows")]
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
                _frames.Detach();
                _stop.Token.WaitHandle.WaitOne(ReconnectDelay);
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode is ErrorFileNotFound or ErrorInvalidName)
            {
                _frames.Detach();
                _stop.Token.WaitHandle.WaitOne(ReconnectDelay);
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _frames.Detach();
                Faulted?.Invoke(ex);
                break;
            }
        }
        _frames.Detach();
    }

    private void ReadLoop(IReadOnlyMemoryReader reader, EventWaitHandle dataEvent)
    {
        while (!_stop.IsCancellationRequested)
        {
            WaitHandle.WaitAny([dataEvent, _stop.Token.WaitHandle], TimeSpan.FromMilliseconds(250));
            if (_stop.IsCancellationRequested) return;

            switch (_frames.Process(reader))
            {
                case FrameOutcome.Retry:
                    Thread.Yield();
                    break;
                case FrameOutcome.NotReady:
                    _stop.Token.WaitHandle.WaitOne(ReconnectDelay);
                    break;
            }
        }
    }

    [SupportedOSPlatform("windows")]
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
