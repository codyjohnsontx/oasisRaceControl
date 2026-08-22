using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

public sealed class EventQueueTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-test-{Guid.NewGuid():N}.db");

    private const string AssignmentId = "3f1b0c8e-3a1c-4f6d-9c2f-1a2b3c4d5e6f";

    private static LapCompleted Lap(
        string eventId, int lapTimeMs = 138_000, DateTimeOffset? completedAt = null) => new()
        {
            EventId = eventId,
            TrackName = "Spa-Francorchamps",
            TrackConfig = "Grand Prix Pits",
            CarName = "Porsche 911 GT3 R",
            LapNumber = 1,
            LapTimeMs = lapTimeMs,
            IncidentDelta = 0,
            CompletedAt = completedAt ?? DateTimeOffset.UtcNow,
        };

    /// <summary>The assignment a first successful poll would report, checked in
    /// at <paramref name="startedAt"/>.</summary>
    private static Assignment CheckedInAt(DateTimeOffset startedAt) =>
        new(AssignmentId, "driver-1", "AuditDriver", startedAt);

    [Fact]
    public void Enqueue_is_idempotent_on_event_id()
    {
        using var queue = new EventQueue(_dbPath);
        Assert.True(queue.Enqueue(Lap("evt-1"), AssignmentId));
        Assert.False(queue.Enqueue(Lap("evt-1"), AssignmentId)); // same id → no-op
        Assert.Equal(1, queue.PendingCount());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Enqueue_rejects_blank_event_ids(string eventId)
    {
        using var queue = new EventQueue(_dbPath);
        Assert.Throws<ArgumentException>(() => queue.Enqueue(Lap(eventId), AssignmentId));
        Assert.Equal(0, queue.PendingCount());
    }

    [Fact]
    public void PendingBatch_returns_oldest_first_and_respects_limit()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), AssignmentId);
        Thread.Sleep(5);
        queue.Enqueue(Lap("evt-2"), AssignmentId);
        Thread.Sleep(5);
        queue.Enqueue(Lap("evt-3"), AssignmentId);

        var batch = queue.PendingBatch(2);
        Assert.Equal(2, batch.Count);
        Assert.Equal("evt-1", batch[0].EventId);
        Assert.Equal("evt-2", batch[1].EventId);
    }

    [Fact]
    public void Remove_deletes_only_the_named_events()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), AssignmentId);
        queue.Enqueue(Lap("evt-2"), AssignmentId);

        queue.Remove(new[] { "evt-1" });

        Assert.Equal(1, queue.PendingCount());
        Assert.Equal("evt-2", queue.PendingBatch(10).Single().EventId);
    }

    [Fact]
    public void Queue_survives_a_restart()
    {
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-1"), AssignmentId);
            queue.Enqueue(Lap("evt-2"), AssignmentId);
        }
        // New instance on the same file = process restart.
        using var reopened = new EventQueue(_dbPath);
        Assert.Equal(2, reopened.PendingCount());
    }

    [Fact]
    public void Payload_round_trips_lap_fields()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1", lapTimeMs: 137_842), AssignmentId);

        var payload = queue.PendingBatch(1).Single().Payload;
        Assert.Equal("LAP_COMPLETED", payload["type"]!.GetValue<string>());
        Assert.Equal("evt-1", payload["eventId"]!.GetValue<string>());
        Assert.Equal(137_842, payload["lapTimeMs"]!.GetValue<int>());
        Assert.Equal(AssignmentId, payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>The backend tells "nobody was checked in" from "this agent is
    /// too old to say" by whether the key is there at all, so an unassigned lap
    /// must serialize the property as an explicit null - never omit it.</summary>
    [Fact]
    public void Payload_carries_an_explicit_null_when_nobody_was_checked_in()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), rigAssignmentId: null);

        var payload = queue.PendingBatch(1).Single().Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
        Assert.Contains("\"rigAssignmentId\":null", payload.ToJsonString());
    }

    /// <summary>A lap stamped before a restart keeps its owner: the stamp lives
    /// in the durable payload, not in agent memory.</summary>
    [Fact]
    public void Stamp_survives_a_restart()
    {
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-1"), AssignmentId);
            queue.Enqueue(Lap("evt-2"), rigAssignmentId: null);
        }

        using var reopened = new EventQueue(_dbPath);
        var batch = reopened.PendingBatch(10);
        Assert.Equal(AssignmentId, batch.Single(e => e.EventId == "evt-1").Payload["rigAssignmentId"]!.GetValue<string>());
        Assert.Null(batch.Single(e => e.EventId == "evt-2").Payload["rigAssignmentId"]);
    }

    /// <summary>The safety property behind the unresolved state: a lap captured
    /// before the agent ever reached the backend must be impossible to
    /// transmit. On the wire it would be an explicit null, which the backend
    /// reads as the authoritative "nobody was checked in".</summary>
    [Fact]
    public void PendingBatch_never_returns_an_unresolved_lap()
    {
        using var queue = new EventQueue(_dbPath);
        Assert.True(queue.EnqueueUnresolved(Lap("evt-1")));
        queue.Enqueue(Lap("evt-2"), AssignmentId);

        // Held, not lost - it is still in the outbox, just not sendable.
        Assert.Equal(2, queue.PendingCount());
        Assert.Equal("evt-2", queue.PendingBatch(10).Single().EventId);
    }

    /// <summary>Unresolved is a persisted state, so a SIGKILL mid-outage leaves
    /// the lap resolvable on the next run rather than stamped with a guess.</summary>
    [Fact]
    public void Unresolved_laps_survive_a_restart_and_are_still_resolvable()
    {
        using (var queue = new EventQueue(_dbPath))
        {
            queue.EnqueueUnresolved(Lap("evt-1"));
        }

        using var reopened = new EventQueue(_dbPath);
        Assert.Equal(1, reopened.PendingCount());
        Assert.Empty(reopened.PendingBatch(10));

        Assert.Equal(1, reopened.ResolveUnresolved(CheckedInAt(DateTimeOffset.UtcNow.AddHours(-1))));
        Assert.Equal(
            AssignmentId,
            reopened.PendingBatch(10).Single().Payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>A first poll that finds nobody checked in is a real answer, and
    /// it is stamped the same way an ordinary unassigned lap is.</summary>
    [Fact]
    public void Resolving_to_nobody_checked_in_stamps_an_explicit_null()
    {
        using var queue = new EventQueue(_dbPath);
        queue.EnqueueUnresolved(Lap("evt-1"));

        queue.ResolveUnresolved(null);

        var payload = queue.PendingBatch(10).Single().Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
    }

    /// <summary>Resolution is decided per row, against each lap's own
    /// completedAt. A backlog straddling a check-in splits: the laps driven
    /// after the driver sat down are theirs, the ones driven before belong to
    /// nobody. Stamping the whole backlog with one id would credit a walk-up
    /// guest's laps to the next customer through the door.</summary>
    [Fact]
    public void ResolveUnresolved_splits_a_backlog_that_straddles_the_check_in()
    {
        var checkIn = DateTimeOffset.Parse("2026-08-22T09:12:00Z");
        using var queue = new EventQueue(_dbPath);
        queue.EnqueueUnresolved(Lap("evt-before", completedAt: checkIn.AddMinutes(-7)));
        queue.EnqueueUnresolved(Lap("evt-after", completedAt: checkIn.AddMinutes(3)));

        Assert.Equal(2, queue.ResolveUnresolved(CheckedInAt(checkIn)));

        var batch = queue.PendingBatch(10);
        Assert.Null(batch.Single(e => e.EventId == "evt-before").Payload["rigAssignmentId"]);
        Assert.Equal(
            AssignmentId,
            batch.Single(e => e.EventId == "evt-after").Payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>A lap driven at the very moment of check-in is the driver's.</summary>
    [Fact]
    public void ResolveUnresolved_treats_the_check_in_instant_as_inside_the_stint()
    {
        var checkIn = DateTimeOffset.Parse("2026-08-22T09:12:00Z");
        using var queue = new EventQueue(_dbPath);
        queue.EnqueueUnresolved(Lap("evt-1", completedAt: checkIn));

        queue.ResolveUnresolved(CheckedInAt(checkIn));

        Assert.Equal(
            AssignmentId,
            queue.PendingBatch(10).Single().Payload["rigAssignmentId"]!.GetValue<string>());
    }

    [Fact]
    public void ResolveUnresolved_leaves_laps_stamped_at_capture_alone()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), AssignmentId);
        queue.EnqueueUnresolved(Lap("evt-2"));

        Assert.Equal(1, queue.ResolveUnresolved(null));

        var batch = queue.PendingBatch(10);
        Assert.Equal(
            AssignmentId,
            batch.Single(e => e.EventId == "evt-1").Payload["rigAssignmentId"]!.GetValue<string>());
        Assert.Null(batch.Single(e => e.EventId == "evt-2").Payload["rigAssignmentId"]);
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
