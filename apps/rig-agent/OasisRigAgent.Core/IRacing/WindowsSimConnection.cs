using System.ComponentModel;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace OasisRigAgent.Core.IRacing;

/// <summary>
/// Attaches to iRacing on the rig: the only code in the agent that asks Windows
/// for anything.
///
/// The rights it requests are deliberately the smallest that can work, and they
/// are the ones <c>docs/venue-safety.md</c> commits to for anything the venue
/// installs on its own computers:
///
/// * the telemetry mapping is opened <see cref="MemoryMappedFileRights.Read"/>,
///   and its view <see cref="MemoryMappedFileAccess.Read"/>, so the agent cannot
///   write into the running simulator's memory even by mistake;
/// * the frame signal is opened with <c>SYNCHRONIZE</c> alone, which permits
///   waiting on it and nothing else - not setting it, not resetting it;
/// * there is no broadcast-message registration, so the agent has no way to send
///   the sim a command. It observes; it never drives.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsSimConnectionFactory : ISimConnectionFactory
{
    /// <summary>The shared memory iRacing publishes telemetry into. Session-local,
    /// so it names the mapping in the signed-in user's own session.</summary>
    public const string TelemetryMapName = @"Local\IRSDKMemMapFileName";

    /// <summary>The event iRacing raises when a new frame is ready.</summary>
    public const string FrameReadyEventName = @"Local\IRSDKDataValidEvent";

    /// <summary>Permission to wait on a handle, and nothing else.</summary>
    private const uint Synchronize = 0x00100000;

    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorInvalidName = 123;

    private readonly string _mapName;
    private readonly string _eventName;
    private readonly Func<int> _windowsSession;
    private volatile bool _openWasDenied;

    public WindowsSimConnectionFactory() : this(TelemetryMapName, FrameReadyEventName) { }

    /// <param name="mapName">Overridable so a synthetic publisher can be attached to in
    /// a controlled rehearsal rather than pointing the agent at a real simulator.</param>
    /// <param name="eventName">The sim's frame signal, overridable for the same reason.</param>
    /// <param name="windowsSession">Which terminal-services session Windows is running
    /// this agent in. Injectable so the reachability rule can be driven from a test;
    /// production reads it from the operating system.</param>
    public WindowsSimConnectionFactory(string mapName, string eventName, Func<int>? windowsSession = null)
    {
        _mapName = mapName;
        _eventName = eventName;
        _windowsSession = windowsSession ?? CurrentWindowsSession;
    }

    /// <summary>
    /// Why nothing attached, when it is not simply that iRacing is closed.
    ///
    /// Evaluated on demand rather than cached, because the account half is a reading
    /// of the last attempt and clears itself as soon as one succeeds.
    /// </summary>
    public SimReachVerdict? UnreachableReason => SimReach.Explain(_windowsSession(), _openWasDenied);

    public ISimConnection? TryConnect()
    {
        MemoryMappedFile map;
        try
        {
            map = MemoryMappedFile.OpenExisting(_mapName, MemoryMappedFileRights.Read);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode is ErrorFileNotFound or ErrorPathNotFound or ErrorInvalidName)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            // The mapping is there and this account may not read it: the agent is
            // running as a different Windows user than iRacing. That is a settled
            // fact about how the machine was set up, not a transient fault, so it
            // becomes a reason rather than a throw every two seconds forever.
            _openWasDenied = true;
            return null;
        }

        _openWasDenied = false;

        MemoryMappedViewAccessor? view = null;
        EventWaitHandle? frameReady = null;
        try
        {
            view = map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            frameReady = OpenFrameReadyEvent();
            return new WindowsSimConnection(map, view, frameReady);
        }
        catch
        {
            frameReady?.Dispose();
            view?.Dispose();
            map.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Opens the sim's frame signal for waiting only.
    ///
    /// .NET's own <c>EventWaitHandle.OpenExisting</c> asks for modify rights as well,
    /// which would let the agent reset an event the simulator owns. Opening the handle
    /// directly is what keeps the request to <c>SYNCHRONIZE</c>.
    /// </summary>
    private EventWaitHandle OpenFrameReadyEvent()
    {
        var handle = NativeMethods.OpenEvent(Synchronize, false, _eventName);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }

        // Ownership of the handle moves to the wait handle, which disposes it.
        return new EventWaitHandle(false, EventResetMode.AutoReset) { SafeWaitHandle = handle };
    }

    /// <summary>
    /// The terminal-services session this process is in, which decides whether the
    /// sim's session-local mapping name resolves here at all.
    ///
    /// Asked of the operating system about this process and nothing else - it does
    /// not enumerate, open, or inspect any other process. A failure to answer reports
    /// an interactive session, so refusing to read the session can never be the thing
    /// that stops a working rig from scoring.
    /// </summary>
    public static int CurrentWindowsSession()
    {
        try
        {
            return NativeMethods.ProcessIdToSessionId(NativeMethods.GetCurrentProcessId(), out var session)
                ? (int)session
                : 1;
        }
        catch (EntryPointNotFoundException) { return 1; }
        catch (DllNotFoundException) { return 1; }
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", EntryPoint = "OpenEventW", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeWaitHandle OpenEvent(
            uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            string name);

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentProcessId();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    }
}

/// <summary>One open, read-only attachment to the running simulator.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsSimConnection : ISimConnection
{
    private readonly MemoryMappedFile _map;
    private readonly MemoryMappedViewAccessor _view;
    private readonly EventWaitHandle _frameReady;

    internal WindowsSimConnection(MemoryMappedFile map, MemoryMappedViewAccessor view, EventWaitHandle frameReady)
    {
        _map = map;
        _view = view;
        _frameReady = frameReady;
        Reader = new MappedViewReader(view);
    }

    public IReadOnlyMemoryReader Reader { get; }

    public bool WaitForFrame(TimeSpan timeout) => _frameReady.WaitOne(timeout);

    public void Dispose()
    {
        _frameReady.Dispose();
        _view.Dispose();
        _map.Dispose();
    }
}
