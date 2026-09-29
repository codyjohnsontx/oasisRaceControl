using OasisRigAgent.Core;

namespace OasisRigAgent.Tests;

internal static class TestSignIn
{
    /// <summary>Seat a name the way a confirmed sign-in does: log it in, or
    /// register it when it matches nobody, then check in.</summary>
    public static async Task<DriverCheckIn> CheckInAsync(DriverCheckInClient client, string name, string pin)
    {
        using var signIn = client.StartSignIn();
        if (!await signIn.LogInAsync(name, pin, CancellationToken.None) && !await signIn.RegisterAsync(name, pin, CancellationToken.None))
            throw new InvalidOperationException($"\"{name}\" could neither log in nor register");
        return await signIn.CheckInAsync(CancellationToken.None);
    }
}
