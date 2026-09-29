using System.Net;

namespace OasisRigAgent.Core;

/// <summary>
/// Counts walk-up sign-ins the backend did not let through, for the heartbeat,
/// by watching the answers <see cref="DriverCheckInClient"/> gets rather than
/// the exceptions it throws: the check-in client and the prompt stay exactly
/// as they are, and a refusal is classified from the one thing every version
/// of them shares - the route and the status code.
///
/// One failed sign-in is one count. A login answering 401 is not a failure on
/// its own: it is the same answer for a new name as for a wrong PIN, and the
/// register call after it is what decides which. A request that never gets an
/// answer counts as <see cref="SignInFailureKind.Unreachable"/>, and the
/// exception still reaches the caller unchanged.
/// </summary>
public sealed class SignInFailureWatch : DelegatingHandler
{
    private readonly Action<SignInFailureKind> _record;

    public SignInFailureWatch(Action<SignInFailureKind> record, HttpMessageHandler inner) : base(inner)
        => _record = record;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        HttpResponseMessage response;
        try
        {
            response = await base.SendAsync(request, ct);
        }
        // A timeout reaches here as a cancellation, the same as the program
        // closing mid-request; the one spurious count the second can add is
        // not worth telling them apart.
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            _record(SignInFailureKind.Unreachable);
            throw;
        }

        if (Classify(request.RequestUri?.AbsolutePath ?? "", response.StatusCode) is { } kind) _record(kind);
        return response;
    }

    /// <summary>What an answer from one of the sign-in routes says about the
    /// sign-in, or null when it is not a failure (or not a sign-in route).</summary>
    public static SignInFailureKind? Classify(string path, HttpStatusCode status)
    {
        if ((int)status < 400) return null;
        var route = path.TrimEnd('/');
        var code = (int)status;
        if (route.EndsWith("/api/auth/login", StringComparison.Ordinal))
            return code switch
            {
                401 => null,
                429 => SignInFailureKind.Locked,
                400 => SignInFailureKind.WrongPinOrName,
                _ => SignInFailureKind.Other,
            };
        if (route.EndsWith("/api/auth/register", StringComparison.Ordinal))
            return code switch
            {
                409 or 400 => SignInFailureKind.WrongPinOrName,
                429 => SignInFailureKind.RateLimited,
                _ => SignInFailureKind.Other,
            };
        if (route.EndsWith("/api/checkin", StringComparison.Ordinal))
            return code == 429 ? SignInFailureKind.RateLimited : SignInFailureKind.Other;
        return null;
    }
}
