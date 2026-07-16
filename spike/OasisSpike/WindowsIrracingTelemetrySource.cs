using System.ComponentModel;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace OasisSpike;

public sealed class WindowsIrracingTelemetrySource : IIrracingTelemetrySource
{
    private const string MemoryMapName = "Local\\IRSDKMemMapFileName";
    private const string DataEventName = "Local\\IRSDKDataValidEvent";
    private const uint Synchronize = 0x00100000;
    private const int ErrorFileNotFound = 2;
    private const int ErrorInvalidName = 123;
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(1);

    private readonly CancellationTokenSource _stop = new();
    private Thread? _thread;
    private bool _connected;

    public event Action? Connected;
    public event Action? Disconnected;
    public event Action<TelemetrySnapshot>? Telemetry;
    public event Action<SessionInfoSnapshot>? SessionInfo;
    public event Action<Exception>? Faulted;

    public void Start()
    {
        if (_thread is not null) throw new InvalidOperationException("The telemetry source was already started.");
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "OasisSpike.ReadOnlyTelemetry"
        };
        _thread.Start();
    }

    public void Stop()
    {
        _stop.Cancel();
        if (_thread is not null && _thread != Thread.CurrentThread)
            _thread.Join(TimeSpan.FromSeconds(5));
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
        var parser = new IrracingMemoryParser(reader);
        var lastTick = int.MinValue;
        var lastSessionUpdate = int.MinValue;
        var malformedReads = 0;

        while (!_stop.IsCancellationRequested)
        {
            WaitHandle.WaitAny([dataEvent, _stop.Token.WaitHandle], TimeSpan.FromMilliseconds(250));
            if (_stop.IsCancellationRequested) return;

            try
            {
                var parsed = parser.Parse(Recorder.WatchedVariableNames);
                malformedReads = 0;
                SetConnected(parsed.IsConnected);
                if (!parsed.IsConnected) continue;

                if (parsed.SessionInfoUpdate != lastSessionUpdate && parsed.SessionInfoBytes is not null)
                {
                    lastSessionUpdate = parsed.SessionInfoUpdate;
                    SessionInfo?.Invoke(new SessionInfoSnapshot(parsed.SessionInfoUpdate, parsed.SessionInfoBytes));
                }

                if (parsed.TickCount != lastTick)
                {
                    lastTick = parsed.TickCount;
                    Telemetry?.Invoke(new TelemetrySnapshot(
                        parsed.TickCount,
                        parsed.TickRate,
                        parsed.SessionInfoUpdate,
                        parsed.Variables,
                        parsed.Values));
                }
            }
            catch (MalformedTelemetryException) when (++malformedReads < 3)
            {
                // The producer can swap buffers while a frame is being read. Two retries
                // tolerate that race; a third malformed read is a hard safety stop.
                Thread.Yield();
            }
        }
    }

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
        if (connected) Connected?.Invoke(); else Disconnected?.Invoke();
    }

    private sealed class AccessorReader : IReadOnlyMemoryReader, IDisposable
    {
        private readonly MemoryMappedViewAccessor _accessor;
        public AccessorReader(MemoryMappedViewAccessor accessor) => _accessor = accessor;
        public long Capacity => _accessor.Capacity;

        public void Read(long offset, Span<byte> destination)
        {
            var rented = destination.Length <= 1024 ? null : new byte[destination.Length];
            if (rented is not null)
            {
                _accessor.ReadArray(offset, rented, 0, rented.Length);
                rented.CopyTo(destination);
                return;
            }

            Span<byte> small = stackalloc byte[destination.Length];
            for (var index = 0; index < small.Length; index++) small[index] = _accessor.ReadByte(offset + index);
            small.CopyTo(destination);
        }

        public void Dispose() { }
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", EntryPoint = "OpenEventW", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeWaitHandle OpenEvent(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, string name);
    }
}
