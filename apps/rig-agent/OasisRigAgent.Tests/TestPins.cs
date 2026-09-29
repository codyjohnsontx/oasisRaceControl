namespace OasisRigAgent.Tests;

internal static class TestPins
{
    /// <summary>The person at the rig confirms a new name's PIN by typing it again.</summary>
    public static Func<CancellationToken, Task<string?>> SamePinAgain(string pin) => _ => Task.FromResult<string?>(pin);
}
