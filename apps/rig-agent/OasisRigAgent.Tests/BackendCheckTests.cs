using System.Net;
using System.Net.Sockets;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// The <c>--check-backend</c> pre-flight and the verdict behind it.
///
/// It is read by two audiences with one answer each: an operator standing at a rig
/// during enrolment, and the installer, which refuses to report a machine done on a
/// token the backend will not accept. Both need the two failures kept apart, because
/// one of them is fixed by waiting and the other by walking back to this computer.
/// </summary>
public sealed class BackendCheckTests
{
    private static AgentConfig Config() => new()
    {
        BackendBaseUrl = "https://oasis.test",
        RigToken = "dev-rig-7-secret",
        RigNumber = 7,
    };

    /// <summary>What the backend answers a poll with: nobody checked in, and the
    /// rig it authenticated the token as.</summary>
    private static AssignmentPoll Poll(int? backendRigNumber) => new(
        null, backendRigNumber is { } n ? new BackendRigIdentity(n, $"Rig {n:D2}") : null);

    [Fact]
    public async Task An_accepted_rig_passes()
    {
        var result = await BackendCheck.RunAsync(Config(), _ => Task.FromResult(Poll(7)));

        Assert.Equal(BackendCheck.Pass, result.ExitCode);
        Assert.Contains("ACCEPTED", result.Message, StringComparison.Ordinal);
        // The two things the operator typed, echoed back: this is the moment to
        // notice that rig 7 was enrolled against the wrong venue's backend.
        Assert.Contains("07", result.Message, StringComparison.Ordinal);
        Assert.Contains("https://oasis.test", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_token_that_works_but_belongs_to_another_rig_is_its_own_answer()
    {
        // The one this check could not previously see. Everything about the install
        // is right except which machine it was run on, so ACCEPTED would have been a
        // true statement about the token and a lie about this computer.
        var result = await BackendCheck.RunAsync(Config(), _ => Task.FromResult(Poll(3)));

        Assert.Equal(BackendCheck.WrongRig, result.ExitCode);
        Assert.Contains("WRONG RIG", result.Message, StringComparison.Ordinal);
        Assert.Contains("Install-RigAgent.ps1", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_backend_that_does_not_report_the_rig_still_passes()
    {
        // A rig enrolled against a backend older than this agent must not be blocked
        // from being installed by a question that backend cannot answer.
        var result = await BackendCheck.RunAsync(Config(), _ => Task.FromResult(Poll(null)));

        Assert.Equal(BackendCheck.Pass, result.ExitCode);
    }

    [Fact]
    public async Task A_refused_token_is_its_own_answer()
    {
        var result = await BackendCheck.RunAsync(
            Config(), _ => throw new BackendRejectedException(HttpStatusCode.Unauthorized));

        Assert.Equal(BackendCheck.IdentityRefused, result.ExitCode);
        Assert.Contains("REFUSED", result.Message, StringComparison.Ordinal);
        Assert.Contains("Install-RigAgent.ps1", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_backend_that_cannot_be_reached_is_not_a_verdict_on_the_token()
    {
        // The distinction the whole check exists for. Reporting a token problem
        // for a venue whose network is down sends somebody round twenty machines
        // retyping secrets that were right all along.
        var result = await BackendCheck.RunAsync(
            Config(), _ => throw new HttpRequestException("No such host is known.", new SocketException(11001)));

        Assert.Equal(BackendCheck.Unreachable, result.ExitCode);
        Assert.Contains("UNREACHABLE", result.Message, StringComparison.Ordinal);
        Assert.Contains("not this rig's token", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_request_that_times_out_is_unreachable_rather_than_a_crash()
    {
        // HttpClient reports its own timeout as a cancellation, which is the same
        // type a caller uses to stop the check. A venue backend that is simply slow
        // must not come back as an unhandled failure or as a refused token.
        var result = await BackendCheck.RunAsync(
            Config(), _ => throw new TaskCanceledException("The request was canceled due to the configured HttpClient.Timeout"));

        Assert.Equal(BackendCheck.Unreachable, result.ExitCode);
    }

    [Fact]
    public async Task Cancelling_the_check_is_not_reported_as_a_failed_backend()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            BackendCheck.RunAsync(Config(), ct => Task.FromCanceled<AssignmentPoll>(ct), cts.Token));
    }

    [Fact]
    public async Task The_probe_only_reads()
    {
        // A check run at a rig with a customer on it must not heartbeat over a real
        // reading, end anybody's session, or put a lap anywhere - so the one call it
        // makes is pinned here rather than left to whoever wires up the host.
        var seen = new List<(HttpMethod Method, string Path)>();
        var handler = new RecordingHandler(seen);
        var client = new BackendClient(new HttpClient(handler), "https://oasis.test", "t");

        await BackendCheck.RunAsync(Config(), BackendCheck.ProbeWith(client));

        var call = Assert.Single(seen);
        Assert.Equal(HttpMethod.Get, call.Method);
        Assert.Equal("/api/agent/assignment", call.Path);
    }

    [Fact]
    public void The_two_failures_never_share_an_exit_code()
    {
        // An installer branches on these numbers, and 4 already means something
        // else on this executable (--check-sim's "no sim to read").
        var codes = new[]
        {
            BackendCheck.Pass, BackendCheck.Unreachable, BackendCheck.IdentityRefused,
            BackendCheck.WrongRig, BackendCheck.NotConfigured,
        };
        Assert.Equal(codes.Length, codes.Distinct().Count());
        Assert.DoesNotContain(BackendCheck.Unreachable, new[] { 2, 3, 4, 5, 6 });
        Assert.DoesNotContain(BackendCheck.IdentityRefused, new[] { 2, 3, 4, 5, 6 });
        Assert.DoesNotContain(BackendCheck.WrongRig, new[] { 2, 3, 4, 5, 6 });
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public void The_backend_refusing_this_rig_is_told_from_everything_else(HttpStatusCode status)
        => Assert.True(BackendReach.IsIdentityRefusal(status));

    [Theory]
    [InlineData(HttpStatusCode.OK)]
    [InlineData(HttpStatusCode.BadRequest)]         // one document it would not parse
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.RequestTimeout)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public void Everything_else_is_left_alone(HttpStatusCode status)
        => Assert.False(BackendReach.IsIdentityRefusal(status));

    [Fact]
    public void The_short_form_fits_the_rigs_status_line()
    {
        // It shares one line with the driver's name, the sim reading and the queue
        // depth, and that line is read across a room. Same bound as the simulator
        // verdicts it sits beside.
        Assert.True(
            BackendReach.Refused.Summary.Length <= 105,
            $"summary is {BackendReach.Refused.Summary.Length} characters: {BackendReach.Refused.Summary}");
        Assert.DoesNotContain('\n', BackendReach.Refused.Summary);
    }

    [Fact]
    public void The_long_form_says_what_the_short_one_cannot()
    {
        var instruction = BackendReach.Refused.Instruction;

        // Why the dashboard is no help: staff looking for this rig will not find a
        // red card, they will find nothing, and that has to be said out loud.
        Assert.Contains("staff dashboard", instruction, StringComparison.Ordinal);
        // That waiting is not the fix, which is the belief the word "offline" creates.
        Assert.Contains("waiting", instruction, StringComparison.Ordinal);
        // And that nothing already driven is lost.
        Assert.Contains("deliver themselves", instruction, StringComparison.Ordinal);
    }

    private sealed class RecordingHandler(List<(HttpMethod, string)> seen) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            seen.Add((request.Method, request.RequestUri!.AbsolutePath));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"assignment":null}""", System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }
}
