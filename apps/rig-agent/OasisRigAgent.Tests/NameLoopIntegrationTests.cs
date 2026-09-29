using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Xunit;
using static OasisRigAgent.Tests.TestPins;
using OasisRigAgent.Core;

namespace OasisRigAgent.Tests;

/// <summary>
/// The walk-up loop against a real backend: name and PIN in, a lap credited to
/// that driver, done, the same name and PIN back to the same driver, next
/// name - the sequence the owner described. It runs only
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

        // Person one types a new name and picks a PIN: registered, and the
        // rig's seat is theirs.
        var first = await checkIn.CheckInAsync($"Loop A {tag}", "4821", SamePinAgain("4821"), CancellationToken.None);
        Assert.False(first.Returning);
        var seat = (await backend.GetAssignmentAsync(CancellationToken.None)).Assignment;
        Assert.NotNull(seat);
        Assert.Equal(first.AssignmentId, seat!.Id);
        Assert.Equal($"Loop A {tag}", seat.DriverDisplayName);
        await AssertLapCredited(backend, first.AssignmentId, $"loop-{tag}-1");

        // Done: the stint ends.
        Assert.True(await backend.CheckoutAsync(first.AssignmentId, CancellationToken.None));
        Assert.Null((await backend.GetAssignmentAsync(CancellationToken.None)).Assignment);

        // They come back for another go: the same name and PIN log the SAME
        // driver back in, so their laps stay on one leaderboard row.
        var again = await checkIn.CheckInAsync($"Loop A {tag}", "4821", SamePinAgain("4821"), CancellationToken.None);
        Assert.True(again.Returning);
        Assert.Equal(first.DriverId, again.DriverId);
        Assert.NotEqual(first.AssignmentId, again.AssignmentId);
        await AssertLapCredited(backend, again.AssignmentId, $"loop-{tag}-2");

        // Somebody else typing that name with the wrong PIN is refused, and the
        // seat stays with the driver who is in it.
        var wrong = await Assert.ThrowsAsync<CheckInRefusedException>(
            () => checkIn.CheckInAsync($"Loop A {tag}", "0000", SamePinAgain("0000"), CancellationToken.None));
        Assert.Contains("is already registered and that PIN does not match it", wrong.Message);
        Assert.Equal(again.AssignmentId, (await backend.GetAssignmentAsync(CancellationToken.None)).Assignment!.Id);

        // A different name registers separately, and the takeover is confirmed
        // automatically, so the seat moves without a sign-out in between.
        var next = await checkIn.CheckInAsync($"Loop B {tag}", "4821", SamePinAgain("4821"), CancellationToken.None);
        Assert.False(next.Returning);
        Assert.NotEqual(first.DriverId, next.DriverId);
        seat = (await backend.GetAssignmentAsync(CancellationToken.None)).Assignment;
        Assert.Equal(next.AssignmentId, seat!.Id);
        Assert.Equal($"Loop B {tag}", seat.DriverDisplayName);
        Assert.False(await backend.CheckoutAsync(again.AssignmentId, CancellationToken.None)); // already taken over
        Assert.True(await backend.CheckoutAsync(next.AssignmentId, CancellationToken.None));
    }

    /// <summary>A lap stamped with the stint is accepted and credited.</summary>
    private static async Task AssertLapCredited(BackendClient backend, string assignmentId, string eventId)
    {
        var lap = new JsonObject
        {
            ["type"] = "LAP_COMPLETED",
            ["eventId"] = eventId,
            ["rigAssignmentId"] = assignmentId,
            ["trackName"] = "Circuit of the Americas",
            ["trackConfig"] = "Grand Prix",
            ["carName"] = "FIA F4",
            ["lapNumber"] = 2,
            ["lapTimeMs"] = 137217,
            ["incidentDelta"] = 0,
            ["completedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var outcome = await backend.SendLapsAsync([new QueuedEvent(eventId, lap)], CancellationToken.None);
        Assert.Equal([eventId], outcome.Settled);
        Assert.Empty(outcome.Rejected);
    }
}
