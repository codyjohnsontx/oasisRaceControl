using System.Runtime.InteropServices;

namespace OasisRigAgent.Windows;

/// <summary>
/// The rig build is a windowed program (WinExe), so it has no console of its
/// own; the console modes - <c>--console</c>, <c>--diagnose</c>, and the staff
/// console a config without <c>rigQrToken</c> runs - get one here, before the
/// first Console call caches its handles: the terminal the program was started
/// from if there is one, otherwise a new console window. Closing that window
/// or a Windows shutdown then reach the program as CTRL_CLOSE_EVENT and
/// CTRL_SHUTDOWN_EVENT, the same way they reach the console build.
/// </summary>
internal static class ConsoleWindow
{
    private const uint AttachParentProcess = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetConsoleWindow();

    /// <summary>True when the process now has a console.</summary>
    public static bool Ensure()
    {
        if (GetConsoleWindow() != IntPtr.Zero) return true;
        if (!AttachConsole(AttachParentProcess)) AllocConsole();
        return GetConsoleWindow() != IntPtr.Zero;
    }
}
