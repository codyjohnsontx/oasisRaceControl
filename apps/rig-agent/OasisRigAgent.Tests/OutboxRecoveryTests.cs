using Microsoft.Data.Sqlite;
using OasisRigAgent.Core;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>
/// A venue computer's lap queue after it lost power, was copied while running, or
/// was half-restored by a backup tool.
///
/// The failure these are written against is not the damaged file — it is what the
/// agent did with one. SQLite refuses the file, the agent could not start, and the
/// rig read on the staff dashboard exactly like a machine nobody had installed it
/// on. A restart is what people try, and a restart reproduced it, every time, for
/// the rest of that machine's life.
/// </summary>
public sealed class OutboxRecoveryTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"oasis-outbox-{Guid.NewGuid():N}");
    private string DbPath => Path.Combine(_dir, "outbox.db");

    public OutboxRecoveryTests() => Directory.CreateDirectory(_dir);

    private static LapCompleted Lap(string eventId) => new()
    {
        EventId = eventId,
        TrackName = "Spa-Francorchamps",
        TrackConfig = "Grand Prix Pits",
        CarName = "Porsche 911 GT3 R",
        LapNumber = 1,
        LapTimeMs = 138_000,
        IncidentDelta = 0,
        OffTrackSeen = false,
        CompletedAt = DateTimeOffset.UtcNow,
    };

    /// <summary>A file that is not a database at all: the shape a half-written or
    /// truncated queue takes after the power goes.</summary>
    private void WriteUnreadableQueue()
    {
        var bytes = new byte[16 * 1024];
        Random.Shared.NextBytes(bytes);
        "SQLite format 3\0"u8.ToArray().CopyTo(bytes, 0);
        File.WriteAllBytes(DbPath, bytes);
    }

    private string[] DamagedCopies() => Directory.GetFiles(_dir, "outbox.damaged-*.db");

    // ---- the failure itself -------------------------------------------------

    [Fact]
    public void A_rig_whose_lap_queue_cannot_be_read_still_starts_and_still_scores()
    {
        WriteUnreadableQueue();

        using var queue = new EventQueue(DbPath);

        Assert.NotNull(queue.Recovery);
        Assert.True(queue.Enqueue(Lap("evt-after-recovery")));
        Assert.Equal(1, queue.PendingCount());
        Assert.Single(queue.PendingBatch(10));
    }

    [Fact]
    public void The_unreadable_queue_is_kept_rather_than_deleted()
    {
        WriteUnreadableQueue();
        var original = File.ReadAllBytes(DbPath);

        using var queue = new EventQueue(DbPath);

        var preserved = Assert.Single(DamagedCopies());
        Assert.Equal(preserved, queue.Recovery!.PreservedPath);
        // Byte for byte: it is the only evidence of what this machine lost, and a
        // disk fault is diagnosed from the file rather than from our summary of it.
        Assert.Equal(original, File.ReadAllBytes(preserved));
    }

    [Fact]
    public void What_happened_is_said_in_full_because_laps_went_with_it()
    {
        WriteUnreadableQueue();

        using var queue = new EventQueue(DbPath);
        var told = queue.Recovery!.Describe();

        Assert.Contains(DbPath, told);                             // which queue
        Assert.Contains(queue.Recovery.PreservedPath, told);       // where to look
        Assert.Contains("not a database", told);                   // what was wrong
        Assert.Contains("not", told, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("delivered", told);                        // that laps were lost
    }

    /// <summary>The file that started this: 16 KB whose header survived and whose
    /// pages did not. The schema statement reads page one and is perfectly happy
    /// with it, so without an integrity check the agent starts, scores all evening,
    /// and discovers the damage at a flush hours later with a customer's laps in
    /// the queue.</summary>
    [Fact]
    public void Damage_past_the_first_page_is_found_at_startup_not_at_the_first_flush()
    {
        using (var seed = new EventQueue(DbPath))
        {
            for (var i = 0; i < 400; i++) seed.Enqueue(Lap($"evt-{i:D4}"));
            Assert.Null(seed.Recovery);
        }
        SqliteConnection.ClearAllPools();

        var bytes = File.ReadAllBytes(DbPath);
        Assert.True(bytes.Length > 8192, "need a file with pages past the first");
        Random.Shared.NextBytes(bytes.AsSpan(4096, bytes.Length - 4096));
        File.WriteAllBytes(DbPath, bytes);

        using var queue = new EventQueue(DbPath);

        Assert.NotNull(queue.Recovery);
        Assert.Single(DamagedCopies());
        Assert.True(queue.Enqueue(Lap("evt-after-recovery")));
    }

    // ---- what must NOT be replaced ------------------------------------------

    [Fact]
    public void A_healthy_queue_is_left_alone_and_keeps_its_laps_across_a_restart()
    {
        using (var first = new EventQueue(DbPath))
        {
            Assert.Null(first.Recovery);
            first.Enqueue(Lap("evt-kept"));
        }
        SqliteConnection.ClearAllPools();

        using var second = new EventQueue(DbPath);

        Assert.Null(second.Recovery);
        Assert.Equal(1, second.PendingCount());
        Assert.Empty(DamagedCopies());
    }

    /// <summary>An empty file is a valid empty database to SQLite, and it is what a
    /// first install looks like the instant before the tables exist. Replacing it
    /// would mean every fresh rig reported a damaged queue on its first start.</summary>
    [Fact]
    public void A_brand_new_rig_does_not_report_a_damaged_queue()
    {
        File.WriteAllBytes(DbPath, Array.Empty<byte>());

        using var queue = new EventQueue(DbPath);

        Assert.Null(queue.Recovery);
        Assert.Empty(DamagedCopies());
    }

    /// <summary>A queue the agent cannot *write* is a different fault with a
    /// different fix — a folder the rig's account does not own, a disk with nothing
    /// left on it — and replacing the file mends none of them. It is reported and
    /// the file is left exactly where it is, because a machine that renames its
    /// queue aside every night and still cannot start has turned one loud failure
    /// into a nightly silent one.
    ///
    /// The file here is perfectly movable, which is the point: the agent has to
    /// decline to move it, not fail while trying.</summary>
    [Fact]
    public void A_queue_the_agent_cannot_write_is_reported_rather_than_replaced()
    {
        File.WriteAllBytes(DbPath, Array.Empty<byte>()); // a valid, empty database
        MakeReadOnly(DbPath);

        var ex = Assert.Throws<OutboxUnusableException>(() => new EventQueue(DbPath));

        Assert.Contains("cannot open", ex.Message);
        Assert.Contains(DbPath, ex.Message);
        Assert.Empty(DamagedCopies());
        Assert.True(File.Exists(DbPath), "the queue must be left where it is");
    }

    /// <summary>Same rule for a path that is not a file at all. Asserted on the
    /// wording as well as the outcome, because "could not be moved aside" and
    /// "cannot open" are two different things to be told at a rig.</summary>
    [Fact]
    public void A_path_the_agent_cannot_open_is_reported_as_that_and_nothing_is_moved()
    {
        Directory.CreateDirectory(DbPath);

        var ex = Assert.Throws<OutboxUnusableException>(() => new EventQueue(DbPath));

        Assert.Contains("cannot open", ex.Message);
        Assert.DoesNotContain("move it aside", ex.Message);
        Assert.Empty(DamagedCopies());
        Assert.True(Directory.Exists(DbPath), "nothing at that path may be moved aside");
    }

    private static void MakeReadOnly(string path)
    {
        if (OperatingSystem.IsWindows()) File.SetAttributes(path, FileAttributes.ReadOnly);
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
    }

    private static void MakeWritable(string path)
    {
        if (!File.Exists(path)) return;
        if (OperatingSystem.IsWindows()) File.SetAttributes(path, FileAttributes.Normal);
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    // ---- the recovery must not create the next problem ----------------------

    /// <summary>A rollback journal belongs to the file it was written for. Left
    /// beside the fresh queue, SQLite replays a stranger's journal into it — which
    /// is how a recovery makes the second corrupt file.</summary>
    [Fact]
    public void A_journal_left_beside_the_damaged_queue_goes_with_it()
    {
        WriteUnreadableQueue();
        File.WriteAllBytes(DbPath + "-journal", new byte[512]);

        using var queue = new EventQueue(DbPath);

        Assert.False(File.Exists(DbPath + "-journal"), "the fresh queue must not inherit it");
        Assert.True(File.Exists(queue.Recovery!.PreservedPath + "-journal"), "and it must be kept with its own file");
    }

    /// <summary>Nobody visits twenty-plus rigs to clear a folder. A machine damaging
    /// its queue every night must not also fill its disk.</summary>
    [Fact]
    public void Only_the_most_recent_damaged_queues_are_kept()
    {
        for (var night = 0; night < 6; night++)
        {
            WriteUnreadableQueue();
            using var queue = new EventQueue(DbPath);
            Assert.NotNull(queue.Recovery);
            SqliteConnection.ClearAllPools();
        }

        Assert.Equal(3, DamagedCopies().Length);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { MakeWritable(DbPath); } catch { /* temp */ }
        try { Directory.Delete(_dir, recursive: true); } catch { /* temp */ }
    }
}
