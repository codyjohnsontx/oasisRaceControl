using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
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

        Assert.Equal(1, reopened.ResolveUnresolved(CheckedInAt(DateTimeOffset.UtcNow.AddHours(-1)), TimeSpan.Zero));
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

        queue.ResolveUnresolved(null, TimeSpan.Zero);

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

        Assert.Equal(2, queue.ResolveUnresolved(CheckedInAt(checkIn), TimeSpan.Zero));

        var batch = queue.PendingBatch(10);
        Assert.Null(batch.Single(e => e.EventId == "evt-before").Payload["rigAssignmentId"]);
        Assert.Equal(
            AssignmentId,
            batch.Single(e => e.EventId == "evt-after").Payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>completedAt comes from the rig and StartedAt from the server, so
    /// a rig clock running FAST would otherwise date a warm-up lap after a
    /// check-in it actually preceded - and hand a walk-up guest's laps to the
    /// next customer, which is the defect this whole path exists to prevent.
    /// The offset taken from the poll response puts both sides in server
    /// time.</summary>
    [Fact]
    public void ResolveUnresolved_does_not_credit_a_pre_check_in_lap_on_a_fast_rig_clock()
    {
        var checkIn = DateTimeOffset.Parse("2026-08-22T09:12:00Z");
        // The rig's clock is ten minutes fast, so a lap really driven at 09:07 -
        // five minutes BEFORE the check-in - is stamped 09:17 locally.
        var rigIsFastBy = TimeSpan.FromMinutes(10);
        using var queue = new EventQueue(_dbPath);
        queue.EnqueueUnresolved(Lap("evt-warmup", completedAt: checkIn.AddMinutes(-5) + rigIsFastBy));

        queue.ResolveUnresolved(CheckedInAt(checkIn), serverClockOffset: -rigIsFastBy);

        Assert.Null(queue.PendingBatch(10).Single().Payload["rigAssignmentId"]);
    }

    /// <summary>The same correction the other way: a rig clock running SLOW must
    /// not send a lap the driver really did drive to the unclaimed pile.</summary>
    [Fact]
    public void ResolveUnresolved_still_credits_a_post_check_in_lap_on_a_slow_rig_clock()
    {
        var checkIn = DateTimeOffset.Parse("2026-08-22T09:12:00Z");
        var rigIsSlowBy = TimeSpan.FromMinutes(10);
        // Really driven at 09:15, three minutes AFTER check-in, stamped 09:05.
        using var queue = new EventQueue(_dbPath);
        queue.EnqueueUnresolved(Lap("evt-theirs", completedAt: checkIn.AddMinutes(3) - rigIsSlowBy));

        queue.ResolveUnresolved(CheckedInAt(checkIn), serverClockOffset: rigIsSlowBy);

        Assert.Equal(
            AssignmentId,
            queue.PendingBatch(10).Single().Payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>A lap driven at the very moment of check-in is the driver's.</summary>
    [Fact]
    public void ResolveUnresolved_treats_the_check_in_instant_as_inside_the_stint()
    {
        var checkIn = DateTimeOffset.Parse("2026-08-22T09:12:00Z");
        using var queue = new EventQueue(_dbPath);
        queue.EnqueueUnresolved(Lap("evt-1", completedAt: checkIn));

        queue.ResolveUnresolved(CheckedInAt(checkIn), TimeSpan.Zero);

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

        Assert.Equal(1, queue.ResolveUnresolved(null, TimeSpan.Zero));

        var batch = queue.PendingBatch(10);
        Assert.Equal(
            AssignmentId,
            batch.Single(e => e.EventId == "evt-1").Payload["rigAssignmentId"]!.GetValue<string>());
        Assert.Null(batch.Single(e => e.EventId == "evt-2").Payload["rigAssignmentId"]);
    }

    /// <summary>The wedge, at the outbox. A lap the backend has refused stops
    /// being offered, and the laps queued behind it - which failed only because
    /// the batch is validated whole - go out on the very next flush.</summary>
    [Fact]
    public void A_rejected_lap_stops_being_offered_and_unblocks_the_rest()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), AssignmentId);
        Thread.Sleep(5);
        queue.Enqueue(Lap("evt-pit-in", lapTimeMs: 2_190_000), AssignmentId);
        Thread.Sleep(5);
        queue.Enqueue(Lap("evt-3"), AssignmentId);

        queue.Reject(new[] { new RejectedEvent("evt-pit-in", "lapTimeMs: Too big") });

        Assert.Equal(new[] { "evt-1", "evt-3" }, queue.PendingBatch(10).Select(e => e.EventId));
    }

    /// <summary>Refused is not deleted. The outbox holds the only copy of that
    /// lap there has ever been, and a bound that lives in a redeployable backend
    /// is not a reason to destroy it - so it stays, with the reason it was
    /// parked, for a person to work.</summary>
    [Fact]
    public void A_rejected_lap_is_kept_with_the_reason_it_was_rejected()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-pit-in", lapTimeMs: 2_190_000), AssignmentId);

        queue.Reject(new[] { new RejectedEvent("evt-pit-in", "lapTimeMs: Too big") });

        var parked = Assert.Single(queue.RejectedEvents());
        Assert.Equal("evt-pit-in", parked.EventId);
        Assert.Equal("lapTimeMs: Too big", parked.Reason);
        Assert.Equal(1, queue.RejectedCount());
    }

    /// <summary>A parked lap is not "queued". Counting it as one would leave the
    /// rig's status line reading the same thing it read all the while that lap
    /// was blocking the outbox, which is the symptom staff were told to watch
    /// for.</summary>
    [Fact]
    public void A_rejected_lap_no_longer_counts_as_queued()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-1"), AssignmentId);
        queue.Enqueue(Lap("evt-pit-in", lapTimeMs: 2_190_000), AssignmentId);

        queue.Reject(new[] { new RejectedEvent("evt-pit-in", "lapTimeMs: Too big") });

        Assert.Equal(1, queue.PendingCount());
        Assert.Equal(1, queue.RejectedCount());
    }

    /// <summary>The quarantine outlives the process. A rig PC that reboots must
    /// not go back to offering the lap the backend already refused - that would
    /// re-wedge the outbox on every restart.</summary>
    [Fact]
    public void A_rejected_lap_stays_rejected_across_a_restart()
    {
        using (var queue = new EventQueue(_dbPath))
        {
            queue.Enqueue(Lap("evt-pit-in", lapTimeMs: 2_190_000), AssignmentId);
            queue.Enqueue(Lap("evt-2"), AssignmentId);
            queue.Reject(new[] { new RejectedEvent("evt-pit-in", "lapTimeMs: Too big") });
        }

        using var reopened = new EventQueue(_dbPath);

        Assert.Equal("evt-2", reopened.PendingBatch(10).Single().EventId);
        Assert.Equal("lapTimeMs: Too big", reopened.RejectedEvents().Single().Reason);
    }

    /// <summary>Only the first parking of a lap comes back, which is what makes
    /// the agent's log line exactly-once per lap rather than once per flush.</summary>
    [Fact]
    public void Rejecting_a_lap_twice_reports_it_once()
    {
        using var queue = new EventQueue(_dbPath);
        queue.Enqueue(Lap("evt-pit-in", lapTimeMs: 2_190_000), AssignmentId);

        Assert.Single(queue.Reject(new[] { new RejectedEvent("evt-pit-in", "lapTimeMs: Too big") }));
        Assert.Empty(queue.Reject(new[] { new RejectedEvent("evt-pit-in", "lapTimeMs: Too big") }));
    }

    /// <summary>An outbox from a build before the quarantine column: nothing in
    /// it was ever refused - that build could not tell a refusal from an outage
    /// and re-sent everything forever - so every row upgrades still
    /// sendable.</summary>
    [Fact]
    public void An_outbox_without_the_quarantine_column_upgrades_with_every_lap_still_sendable()
    {
        WriteLegacyOutbox(("evt-legacy", DateTimeOffset.Parse("2026-08-22T09:05:00Z")));

        using var upgraded = new EventQueue(_dbPath);
        upgraded.ResolveUnresolved(CheckedInAt(DateTimeOffset.Parse("2026-08-22T09:00:00Z")), TimeSpan.Zero);

        Assert.Equal("evt-legacy", upgraded.PendingBatch(10).Single().EventId);
        Assert.Equal(0, upgraded.RejectedCount());
    }

    /// <summary>The in-place upgrade of an outbox left behind by a pre-0.2
    /// build: no `resolved` column, and no `rigAssignmentId` in any payload
    /// because that build's Enqueue never wrote one. Back-filling those rows as
    /// resolved would flush them with the key absent, which the backend reads as
    /// "this agent is too old to say" - a checked-in driver's queued laps landing
    /// unclaimed on the upgrade that was supposed to stamp them. They arrive
    /// unresolved instead, and the first successful poll settles them per row
    /// against their own completedAt, exactly like any other unresolved row.</summary>
    [Fact]
    public void A_pre_0_2_outbox_upgrades_with_its_backlog_unresolved()
    {
        var checkIn = DateTimeOffset.Parse("2026-08-22T09:12:00Z");
        WriteLegacyOutbox(
            ("evt-before", checkIn.AddMinutes(-7)),
            ("evt-after", checkIn.AddMinutes(3)));

        using var upgraded = new EventQueue(_dbPath);

        // Held, not lost, and above all not sendable: a flush landing before the
        // first poll must not hand these to the backend.
        Assert.Equal(2, upgraded.PendingCount());
        Assert.Empty(upgraded.PendingBatch(10));

        Assert.Equal(2, upgraded.ResolveUnresolved(CheckedInAt(checkIn), TimeSpan.Zero));

        var batch = upgraded.PendingBatch(10);
        Assert.Equal(2, batch.Count);
        var before = batch.Single(e => e.EventId == "evt-before").Payload;
        Assert.True(before.AsObject().ContainsKey("rigAssignmentId"));
        Assert.Null(before["rigAssignmentId"]);
        Assert.Equal(
            AssignmentId,
            batch.Single(e => e.EventId == "evt-after").Payload["rigAssignmentId"]!.GetValue<string>());
    }

    /// <summary>The back-fill only ever reaches the rows the ALTER touches -
    /// every Insert names `resolved` itself - so a lap stamped after the upgrade
    /// is sendable straight away, legacy backlog or not.</summary>
    [Fact]
    public void Upgrading_a_legacy_outbox_does_not_hold_back_newly_stamped_laps()
    {
        WriteLegacyOutbox(("evt-legacy", DateTimeOffset.Parse("2026-08-22T09:05:00Z")));

        using var upgraded = new EventQueue(_dbPath);
        Assert.True(upgraded.Enqueue(Lap("evt-new"), AssignmentId));

        Assert.Equal("evt-new", upgraded.PendingBatch(10).Single().EventId);
    }

    /// <summary>An outbox in the exact shape a pre-0.2 build left it: the table
    /// has no `resolved` column, and the payloads carry no `rigAssignmentId`
    /// key at all.</summary>
    private void WriteLegacyOutbox(params (string EventId, DateTimeOffset CompletedAt)[] laps)
    {
        using var connection = new SqliteConnection($"Data Source={_dbPath}");
        connection.Open();

        using (var create = connection.CreateCommand())
        {
            create.CommandText = """
                create table outbox (
                  event_id   text primary key,
                  payload    text not null,
                  created_at text not null
                );
                """;
            create.ExecuteNonQuery();
        }

        foreach (var (eventId, completedAt) in laps)
        {
            var payload = new JsonObject
            {
                ["type"] = "LAP_COMPLETED",
                ["eventId"] = eventId,
                ["trackName"] = "Spa-Francorchamps",
                ["trackConfig"] = "Grand Prix Pits",
                ["carName"] = "Porsche 911 GT3 R",
                ["lapNumber"] = 1,
                ["lapTimeMs"] = 138_000,
                ["incidentDelta"] = 0,
                ["completedAt"] = completedAt.ToString("o"),
            };

            using var insert = connection.CreateCommand();
            insert.CommandText = """
                insert into outbox (event_id, payload, created_at)
                values ($id, $payload, $created);
                """;
            insert.Parameters.AddWithValue("$id", eventId);
            insert.Parameters.AddWithValue("$payload", payload.ToJsonString());
            insert.Parameters.AddWithValue("$created", completedAt.ToString("o"));
            insert.ExecuteNonQuery();
        }
    }

    public void Dispose()
    {
        if (File.Exists(_dbPath)) File.Delete(_dbPath);
    }
}
