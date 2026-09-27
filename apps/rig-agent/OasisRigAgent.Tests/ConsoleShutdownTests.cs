using System.Diagnostics;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The console host as a person at the rig ends it: the real agent process in
/// walk-up mode, against a backend that is not there, with its input closed.
/// Shutting down must end cleanly with exit code 0 - an unattended event PC
/// that prints a stack trace (or raises an error-reporting dialog) at every
/// exit is a crash, even when the sign-out already ran.
/// </summary>
public sealed class ConsoleShutdownTests
{
    [Fact]
    public async Task WalkUpModeExitsCleanlyWhenItsInputCloses()
    {
        var agentDll = Path.Combine(AppContext.BaseDirectory, "OasisRigAgent.dll");
        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(agentDll);
        start.Environment["OASIS_BACKEND_URL"] = "http://127.0.0.1:9";
        start.Environment["OASIS_RIG_TOKEN"] = "test-rig-token";
        start.Environment["OASIS_RIG_NUMBER"] = "1";
        start.Environment["OASIS_TELEMETRY"] = "none";
        start.Environment["OASIS_RIG_QR_TOKEN"] = "test-qr";
        start.Environment.Remove("OASIS_SIMULATE");

        using var agent = Process.Start(start)!;
        var stdout = agent.StandardOutput.ReadToEndAsync();
        var stderr = agent.StandardError.ReadToEndAsync();
        agent.StandardInput.Close();

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try { await agent.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { agent.Kill(entireProcessTree: true); throw; }

        var output = await stdout + await stderr;
        Assert.Contains("Walk-up mode", output);
        Assert.Contains("Shutting down", output);
        Assert.DoesNotContain("Unhandled exception", output);
        Assert.Equal(0, agent.ExitCode);
    }
}
