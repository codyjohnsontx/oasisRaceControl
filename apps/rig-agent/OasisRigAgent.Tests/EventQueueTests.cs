using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

public sealed class EventQueueTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-test-{Guid.NewGuid():N}.db");

    private static LapCompleted Lap(string eventId, int lapTimeMs = 138_000, bool offTrackSeen = false) => new()
    {
        EventId = eventId,
        TrackName = "Spa-Francorchamps",
        TrackConfig = "Grand Prix Pits",
        CarName = "Porsche 911 GT3 R",
        LapNumber = 1,
        LapTimeMs = lapTimeMs,
        IncidentDelta = 0,
        OffTrackSeen = offTrackSeen,
        CompletedAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public void Enqueue_is_idempotent_on_event_id()
    {
        using var queue = new EventQueue(_dbPath);
        Assert.True(queue.Enqueue(Lap("evt-1")));
        Assert.False(queue.Enqueue(Lap("evt-1"))); // same id → no-op
        Assert.Equal(1, queue.PendingCount());
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Enqueue_rejects_blank_event_ids(string eventId)
    {
        using var queue = new EventQueue(_dbPath);
        Assert.Throws<ArgumentException>(() => queue.Enqueue(Lap(eventId)));
        Assert.Equal(0, queue.PendingCount());
    }

    [Fact]
    public void PendingBatch_returns_oldest_first_and_respects_limit()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"));
        Thread.Sleep(5);
        queue.Enqueue(Lap("evt-2"));
        Thread.Sleep(5);
        queue.Enqueue(Lap("evt-3"));

        var batch = queue.PendingBatch(2);
        Assert.Equal(2, batch.Count);
        Assert.Equal("evt-1", batch[0].EventId);
        Assert.Equal("evt-2", batch[1].EventId);
    }

    [Fact]
    public void Remove_deletes_only_the_named_events()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"));
        queue.Enqueue(Lap("evt-2"));

        queue.Remove(new[] { "evt-1" });

        Assert.Equal(1, queue.PendingCount());
        Assert.Equal("evt-2", queue.PendingBatch(10).Single().EventId);
    }

    [Fact]
    public void Queue_survives_a_restart()
    {
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-1"));
            queue.Enqueue(Lap("evt-2"));
        }
        // New instance on the same file = process restart.
        using var reopened = new EventQueue(_dbPath);
        Assert.Equal(2, reopened.PendingCount());
    }

    [Fact]
    public void Payload_round_trips_lap_fields()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1", lapTimeMs: 137_842));

        var payload = queue.PendingBatch(1).Single().Payload;
        Assert.Equal("LAP_COMPLETED", payload["type"]!.GetValue<string>());
        Assert.Equal("evt-1", payload["eventId"]!.GetValue<string>());
        Assert.Equal(137_842, payload["lapTimeMs"]!.GetValue<int>());
    }

    [Fact]
    public void A_queued_lap_keeps_the_identity_it_was_minted_with_across_a_restart()
    {
        // This is what actually makes a resubmission idempotent, and it is worth
        // pinning because the lap detector used to derive an id that would come out
        // the same on a second agent run - which made two customers' laps collide
        // (LapDetectorTests). Uniqueness moved into the detector; unchanged-across-a-
        // restart lives here, in the file that survives the restart.
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("lap-r7-s42-n0-l6-tabc123x2"));

        using var reopened = new EventQueue(_dbPath);
        var queued = Assert.Single(reopened.PendingBatch(10));

        Assert.Equal("lap-r7-s42-n0-l6-tabc123x2", queued.EventId);
        Assert.Equal("lap-r7-s42-n0-l6-tabc123x2", queued.Payload["eventId"]!.GetValue<string>());
    }

    [Fact]
    public void Payload_carries_whether_the_lap_went_off_the_road()
    {
        // The outbox is what survives a crash, a restart and an outage, so a lap
        // that lost this on the way in would be delivered days later as a clean
        // one. It has to be in the stored payload, not only in memory.
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-wide", offTrackSeen: true));
        queue.Enqueue(Lap("evt-clean", offTrackSeen: false));

        using var reopened = new EventQueue(_dbPath);
        var byId = reopened.PendingBatch(10).ToDictionary(b => b.EventId, b => b.Payload);

        Assert.True(byId["evt-wide"]["offTrackSeen"]!.GetValue<bool>());
        Assert.False(byId["evt-clean"]["offTrackSeen"]!.GetValue<bool>());
    }

    [Fact]
    public void Payload_carries_the_assignment_the_lap_was_driven_under()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), "6d1f7c2e-0b1a-4c3d-9e5f-0a1b2c3d4e5f");

        var payload = queue.PendingBatch(1).Single().Payload;
        Assert.Equal("6d1f7c2e-0b1a-4c3d-9e5f-0a1b2c3d4e5f", payload["rigAssignmentId"]!.GetValue<string>());
    }

    [Fact]
    public void Payload_carries_a_null_assignment_when_nobody_was_checked_in()
    {
        // Explicitly null rather than absent, so the backend sees "the rig knew
        // of no driver" instead of a field it has to guess the meaning of.
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"));

        var payload = queue.PendingBatch(1).Single().Payload;
        Assert.True(payload.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(payload["rigAssignmentId"]);
    }

    [Fact]
    public void Payload_treats_a_blank_assignment_as_none()
    {
        // A blank string would fail the backend's uuid check and 400 the whole
        // batch, wedging every lap queued behind it.
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), "   ");

        Assert.Null(queue.PendingBatch(1).Single().Payload["rigAssignmentId"]);
    }

    [Fact]
    public void An_assignment_stamped_on_a_lap_survives_a_restart()
    {
        // The whole point of capture-time binding: the outbox outlives the
        // agent, so the driver it names has to outlive it too.
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-1"), "6d1f7c2e-0b1a-4c3d-9e5f-0a1b2c3d4e5f");
        }

        using var reopened = new EventQueue(_dbPath);
        Assert.Equal(
            "6d1f7c2e-0b1a-4c3d-9e5f-0a1b2c3d4e5f",
            reopened.PendingBatch(1).Single().Payload["rigAssignmentId"]!.GetValue<string>());
    }

    [Fact]
    public void Quarantine_moves_a_lap_out_of_the_queue_but_keeps_it()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"));
        queue.Enqueue(Lap("evt-poison"));

        queue.Quarantine(new[] { "evt-poison" }, "invalid_input: lapTimeMs");

        Assert.Equal(1, queue.PendingCount());
        Assert.Equal(1, queue.QuarantinedCount());
        Assert.Equal("evt-1", queue.PendingBatch(50).Single().EventId);
    }

    [Fact]
    public void A_quarantined_lap_stays_quarantined_across_a_restart()
    {
        // The number staff see on a rig has to be the truth about that machine,
        // not about this run of the agent — a rig that quietly forgets it gave
        // up on a lap looks healthy while laps go missing.
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-poison"));
            queue.Quarantine(new[] { "evt-poison" }, "invalid_input");
        }

        using var reopened = new EventQueue(_dbPath);
        Assert.Equal(0, reopened.PendingCount());
        Assert.Equal(1, reopened.QuarantinedCount());
    }

    [Fact]
    public void Quarantining_the_same_lap_twice_does_not_multiply_it()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-poison"));

        queue.Quarantine(new[] { "evt-poison" }, "first reason");
        queue.Quarantine(new[] { "evt-poison" }, "second reason");

        Assert.Equal(1, queue.QuarantinedCount());
    }

    [Fact]
    public void An_unreadable_row_is_set_aside_instead_of_failing_the_whole_read()
    {
        // A torn write or a half-flushed file leaves a row nothing can parse. It
        // sits at the head of the queue, so throwing here would take down every
        // flush for the life of the machine and no lap behind it would ever be
        // seen again.
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-corrupt"));
            queue.Enqueue(Lap("evt-good"));
        }
        Corrupt("evt-corrupt", "{not json at all");

        using var reopened = new EventQueue(_dbPath);
        var batch = reopened.PendingBatch(50);

        Assert.Equal("evt-good", Assert.Single(batch).EventId);
        Assert.Equal(1, reopened.QuarantinedCount());
        Assert.Equal(1, reopened.PendingCount());
    }

    [Fact]
    public void The_quarantine_cannot_grow_without_bound()
    {
        // Nobody visits twenty-plus rigs to clear a database. A rig that starts
        // rejecting every lap must not slowly fill its own disk.
        using var queue = new EventQueue(_dbPath);
        for (var i = 0; i < 260; i++)
        {
            queue.Enqueue(Lap($"evt-{i:D4}"));
            queue.Quarantine(new[] { $"evt-{i:D4}" }, "invalid_input");
        }

        Assert.InRange(queue.QuarantinedCount(), 1, 200);
        Assert.Equal(0, queue.PendingCount());
    }

    /// <summary>Writes a payload straight into the outbox row, standing in for a
    /// file damaged outside this process.</summary>
    private void Corrupt(string eventId, string payload)
    {
        using var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={_dbPath}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "update outbox set payload = $p where event_id = $id";
        cmd.Parameters.AddWithValue("$p", payload);
        cmd.Parameters.AddWithValue("$id", eventId);
        cmd.ExecuteNonQuery();
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
