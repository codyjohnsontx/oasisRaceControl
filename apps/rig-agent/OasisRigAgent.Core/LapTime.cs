namespace OasisRigAgent.Core;

public static class LapTime
{
    /// <summary>A lap time as the sim shows it: 2:17.217.</summary>
    public static string Format(int ms) => $"{ms / 60_000}:{ms % 60_000 / 1000:00}.{ms % 1000:000}";
}
