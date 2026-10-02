using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The console host as a person at the rig ends it: the real agent process in
/// walk-up mode. Shutting down must end cleanly with exit code 0 - an
/// unattended event PC that prints a stack trace (or raises an error-reporting
/// dialog) at every exit is a crash - and every way out must deliver the
/// driver's sign-out before the process is gone, or the stint stays open. The
/// goodbye heartbeat goes out on every one of them too, in both console modes,
/// or the monitor reads a rig that was closed as one that lost power.
/// </summary>
public sealed class ConsoleShutdownTests
{
    private const string DepartedAssignmentId = "7c2e4a10-5b3d-4e8f-a1c2-0d9e8f7a6b5c";
    private const string MikeAssignmentId = "3f1b0c8e-3a1c-4f6d-9c2f-1a2b3c4d5e6f";

    [Fact]
    public async Task WalkUpModeExitsCleanlyWhenItsInputClosesAndTheBackendIsUnreachable()
    {
        using var agent = StartAgent("http://127.0.0.1:9", out var output);
        agent.StandardInput.Close();

        await WaitForExit(agent);

        Assert.Contains("Walk-up mode", output.ToString());
        Assert.Contains("Shutting down", output.ToString());
        Assert.DoesNotContain("Unhandled exception", output.ToString());
        Assert.Equal(0, agent.ExitCode);
    }

    /// <summary>A driver is seated when the program is ended, by each of the
    /// ways it can end. The previous run's stint is ended before the name
    /// prompt, and the seated driver's checkout reaches the backend before the
    /// process exits.</summary>
    [Theory]
    [InlineData(null)]
    [InlineData("INT")]
    [InlineData("HUP")]
    [InlineData("TERM")]
    public async Task EveryWayOutSignsTheSeatedDriverOutBeforeTheProcessEnds(string? signal)
    {
        if (signal is not null && OperatingSystem.IsWindows()) return;

        using var backend = new FakeBackend(openAssignmentId: DepartedAssignmentId);
        using var agent = StartAgent(backend.BaseUrl, out var output);

        await agent.StandardInput.WriteLineAsync("Mike");
        await agent.StandardInput.WriteLineAsync("1234");
        await agent.StandardInput.FlushAsync();
        await WaitUntil(() => output.ToString().Contains("Press Enter to log out"));

        if (signal is null) agent.StandardInput.Close();
        else Process.Start("kill", $"-{signal} {agent.Id}")!.WaitForExit();

        await WaitForExit(agent);

        var log = backend.Log;
        var emptied = log.IndexOf("checkout:");
        var login = log.IndexOf("login");
        Assert.True(emptied >= 0 && emptied < login, string.Join(", ", log));
        Assert.Contains($"checkout:{MikeAssignmentId}", log);
        Assert.Contains("goodbye", log);
        Assert.Null(backend.OpenAssignmentId);
        Assert.DoesNotContain("Unhandled exception", output.ToString());
        Assert.Equal(0, agent.ExitCode);
    }

    /// <summary>The staff console (no rig QR token): q, Ctrl+C, the close
    /// button and a shutdown each send the goodbye before the process
    /// ends - after the heartbeat that said it was running.</summary>
    [Theory]
    [InlineData(null)]
    [InlineData("INT")]
    [InlineData("HUP")]
    [InlineData("TERM")]
    public async Task EveryWayOutOfTheStaffConsoleSaysGoodbye(string? signal)
    {
        if (signal is not null && OperatingSystem.IsWindows()) return;

        using var backend = new FakeBackend(openAssignmentId: null);
        using var agent = StartAgent(backend.BaseUrl, out var output, walkUp: false);
        await WaitUntil(() => backend.Log.Contains("heartbeat") && output.ToString().Contains("Commands:"));

        if (signal is null)
        {
            await agent.StandardInput.WriteLineAsync("q");
            await agent.StandardInput.FlushAsync();
        }
        else Process.Start("kill", $"-{signal} {agent.Id}")!.WaitForExit();

        await WaitForExit(agent);

        var log = backend.Log;
        Assert.True(log.LastIndexOf("heartbeat") < log.IndexOf("goodbye"), string.Join(", ", log));
        Assert.Contains("Priority: below normal", output.ToString());
        Assert.DoesNotContain("Unhandled exception", output.ToString());
        Assert.Equal(0, agent.ExitCode);
    }

    private static Process StartAgent(string backendUrl, out StringBuilder output, bool walkUp = true)
    {
        foreach (var outbox in Directory.GetFiles(AppContext.BaseDirectory, "outbox.db*"))
            File.Delete(outbox);

        var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ?? "dotnet")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "OasisRigAgent.dll"));
        start.Environment["OASIS_BACKEND_URL"] = backendUrl;
        start.Environment["OASIS_RIG_TOKEN"] = "test-rig-token";
        start.Environment["OASIS_RIG_NUMBER"] = "1";
        start.Environment["OASIS_TELEMETRY"] = "none";
        if (walkUp) start.Environment["OASIS_RIG_QR_TOKEN"] = "test-qr";
        else start.Environment.Remove("OASIS_RIG_QR_TOKEN");
        start.Environment.Remove("OASIS_SIMULATE");

        var agent = Process.Start(start)!;
        var sink = new StringBuilder();
        void Append(object _, DataReceivedEventArgs e)
        {
            if (e.Data is null) return;
            lock (sink) sink.AppendLine(e.Data);
        }
        agent.OutputDataReceived += Append;
        agent.ErrorDataReceived += Append;
        agent.BeginOutputReadLine();
        agent.BeginErrorReadLine();
        output = sink;
        return agent;
    }

    private static async Task WaitForExit(Process agent)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        try { await agent.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { agent.Kill(entireProcessTree: true); throw; }
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) throw new TimeoutException("the agent never got there");
            await Task.Delay(50);
        }
    }

    /// <summary>The deployed routes the walk-up agent calls, answering the way
    /// they do: one rig whose open stint the checkout and check-in routes
    /// change, a login that knows Mike, and a log of what arrived in order
    /// (a checkout is logged by the assignment it named, empty for "whatever
    /// is open"; a heartbeat as "heartbeat", or "goodbye" when it says the
    /// agent is shutting down).</summary>
    private sealed class FakeBackend : IDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly List<string> _log = new();
        private readonly object _lock = new();
        private string? _open;

        public FakeBackend(string? openAssignmentId)
        {
            _open = openAssignmentId;
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            BaseUrl = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add(BaseUrl + "/");
            _listener.Start();
            _ = Serve();
        }

        public string BaseUrl { get; }

        public List<string> Log { get { lock (_lock) return _log.ToList(); } }

        public string? OpenAssignmentId { get { lock (_lock) return _open; } }

        private async Task Serve()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try { context = await _listener.GetContextAsync(); }
                catch { return; }
                using var reader = new StreamReader(context.Request.InputStream);
                var text = await reader.ReadToEndAsync();
                var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
                var (status, answer) = Answer(context, body);
                var bytes = Encoding.UTF8.GetBytes(answer);
                context.Response.StatusCode = status;
                context.Response.ContentType = "application/json";
                await context.Response.OutputStream.WriteAsync(bytes);
                context.Response.Close();
            }
        }

        private (int, string) Answer(HttpListenerContext context, JsonNode? body)
        {
            lock (_lock)
            {
                switch (context.Request.Url!.AbsolutePath)
                {
                    case "/api/agent/checkout":
                        var target = body?["assignmentId"]?.GetValue<string>();
                        _log.Add($"checkout:{target}");
                        var ends = _open is not null && (target is null || target == _open);
                        if (ends) _open = null;
                        return (200, ends ? """{"ended":true}""" : """{"ended":false}""");
                    case "/api/agent/assignment":
                        return (200, _open is null
                            ? """{"assignment":null}"""
                            : """{"assignment":{"id":""" + $"\"{_open}\"" + ""","startedAt":"2026-09-27T17:00:00.000Z","driver":{"id":"d-mike","displayName":"Mike"}}}""");
                    case "/api/auth/name":
                        _log.Add("lookup");
                        return (200, """{"taken":true}""");
                    case "/api/auth/login":
                        _log.Add("login");
                        context.Response.AppendHeader("Set-Cookie", "oasis_driver=jwt-mike; Path=/");
                        return (200, """{"driverId":"d-mike","displayName":"Mike"}""");
                    case "/api/checkin":
                        _log.Add("checkin");
                        _open = MikeAssignmentId;
                        return (200, $$"""{"status":"checked_in","assignmentId":"{{MikeAssignmentId}}"}""");
                    case "/api/agent/events":
                        foreach (var e in body?["events"]?.AsArray() ?? [])
                            if (e?["type"]?.GetValue<string>() == "RIG_HEARTBEAT")
                                _log.Add(e["shuttingDown"]?.GetValue<bool>() == true ? "goodbye" : "heartbeat");
                        return (200, """{"results":[]}""");
                    default:
                        return (200, """{"results":[]}""");
                }
            }
        }

        public void Dispose() => _listener.Close();
    }
}
