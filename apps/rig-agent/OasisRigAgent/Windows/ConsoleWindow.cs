using System.Runtime.InteropServices;

namespace OasisRigAgent.Windows;

/// <summary>
/// The rig build is a windowed program (WinExe), so it has no console of its
/// own. Both calls run before the first Console call caches its handles.
///
/// Every console mode reads the keyboard - <c>--console</c>, the staff console
/// a config without <c>rigQrToken</c> runs, and <c>--diagnose</c>'s Enter to
/// stop - so each <see cref="Open"/>s a console window of its own: a shell
/// does not wait for a windowed program, and a console shared with it would
/// split what is typed between the shell and the program (a PIN read as a
/// command and left on screen). Closing that window or a Windows shutdown
/// reach the program as CTRL_CLOSE_EVENT and CTRL_SHUTDOWN_EVENT, the same way
/// they reach the console build.
/// </summary>
internal static class ConsoleWindow
{
    private const uint AttachParentProcess = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    /// <summary>A console window of the program's own, for a mode that reads input.</summary>
    public static void Open() => AllocConsole();

    /// <summary>The terminal the program was started from, for output only;
    /// false when there is none (started from a shortcut or Explorer).</summary>
    public static bool AttachToParent() => AttachConsole(AttachParentProcess);
}
