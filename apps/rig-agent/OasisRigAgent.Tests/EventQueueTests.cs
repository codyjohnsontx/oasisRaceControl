using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

public sealed class EventQueueTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"oasis-test-{Guid.NewGuid():N}.db");

    private static LapCompleted Lap(string eventId, int lapTimeMs = 138_000) => new()
    {
        EventId = eventId,
        TrackName = "Spa-Francorchamps",
        TrackConfig = "Grand Prix Pits",
        CarName = "Porsche 911 GT3 R",
        LapNumber = 1,
        LapTimeMs = lapTimeMs,
        IncidentDelta = 0,
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

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
