using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Xunit;
using OasisRigAgent.Core;

namespace OasisRigAgent.Tests;

/// <summary>
/// The walk-up loop against a real backend: name in, a lap credited to that
/// name, done, next name - the sequence the owner described. It runs only
/// when OASIS_TEST_BACKEND_URL names a local backend seeded with the demo data
/// (rig token dev-rig-1-secret, QR token demo-rig-1), because it creates
/// drivers and assignments there. Run it against the SERVED commit of the web
/// app, not only main, since the rig talks to whatever is deployed:
///
///   git worktree add /tmp/served 695e080 && (cd /tmp/served/apps/web && npm ci && npm run db:migrate && npm run db:seed && npm run dev -- -p 3200)
///   OASIS_TEST_BACKEND_URL=http://localhost:3200 dotnet test --filter NameLoop
///
/// Without the variable it passes as a no-op and says so, like the web repo's
/// database-backed suites.
/// </summary>
public sealed class NameLoopIntegrationTests
{
    private const string RigToken = "dev-rig-1-secret";
    private const string QrToken = "demo-rig-1";

    [Fact]
    public async Task NameLapsDoneNextNameAgainstTheServedBackend()
    {
        var baseUrl = Environment.GetEnvironmentVariable("OASIS_TEST_BACKEND_URL");
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            Console.WriteLine("NameLoopIntegrationTests: OASIS_TEST_BACKEND_URL not set - skipped");
            return;
        }

        var tag = Guid.NewGuid().ToString("N")[..6];
        var checkIn = new DriverCheckInClient(baseUrl, QrToken);
        using var http = new HttpClient();
        var backend = new BackendClient(http, baseUrl, RigToken);

        // Person one types their name: the rig's seat is theirs.
        var first = await checkIn.CheckInAsync($"Loop A {tag}", CancellationToken.None);
        Assert.False(first.Renamed);
        var seat = (await backend.GetAssignmentAsync(CancellationToken.None)).Assignment;
        Assert.NotNull(seat);
        Assert.Equal(first.AssignmentId, seat!.Id);
        Assert.Equal($"Loop A {tag}", seat.DriverDisplayName);

        // A lap stamped with that stint is accepted and credited to them.
        var lap = new JsonObject
        {
            ["type"] = "LAP_COMPLETED",
            ["eventId"] = $"loop-{tag}-1",
            ["rigAssignmentId"] = first.AssignmentId,
            ["trackName"] = "Circuit of the Americas",
            ["trackConfig"] = "Grand Prix",
            ["carName"] = "FIA F4",
            ["lapNumber"] = 2,
            ["lapTimeMs"] = 137217,
            ["incidentDelta"] = 0,
            ["completedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var outcome = await backend.SendLapsAsync([new QueuedEvent($"loop-{tag}-1", lap)], CancellationToken.None);
        Assert.Equal([$"loop-{tag}-1"], outcome.Settled);
        Assert.Empty(outcome.Rejected);

        // Done: the stint ends, and the same name typed again is a new person
        // tonight, so the backend renames them rather than reusing the row.
        Assert.True(await backend.CheckoutAsync(first.AssignmentId, CancellationToken.None));
        Assert.Null((await backend.GetAssignmentAsync(CancellationToken.None)).Assignment);

        var again = await checkIn.CheckInAsync($"Loop A {tag}", CancellationToken.None);
        Assert.True(again.Renamed);
        Assert.StartsWith($"Loop A {tag} ", again.DisplayName);
        Assert.NotEqual(first.DriverId, again.DriverId);

        // Next name without a sign-out in between: the takeover is confirmed
        // automatically and the seat moves.
        var next = await checkIn.CheckInAsync($"Loop B {tag}", CancellationToken.None);
        seat = (await backend.GetAssignmentAsync(CancellationToken.None)).Assignment;
        Assert.Equal(next.AssignmentId, seat!.Id);
        Assert.Equal($"Loop B {tag}", seat.DriverDisplayName);
        Assert.False(await backend.CheckoutAsync(again.AssignmentId, CancellationToken.None)); // already taken over
        Assert.True(await backend.CheckoutAsync(next.AssignmentId, CancellationToken.None));
    }
}
