using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace OasisRigAgent.Core;

/// <summary>
/// Durable, idempotent outbox for lap events. Laps are written here the instant
/// they are detected and only removed once the backend has accepted (or
/// deduplicated) them, so a network outage or agent restart never loses a lap.
/// The event_id primary key makes re-enqueuing the same lap a no-op.
///
/// A second table holds the laps that can never leave: a payload the backend
/// refuses to parse, or a row this agent can no longer read. Those are moved
/// aside rather than deleted, because the alternative — leaving them at the head
/// of the queue — stops every lap behind them and reads to staff as a rig that
/// has been offline since lunchtime. The quarantined rows keep their payload and
/// a reason so a rig can be diagnosed after the fact.
/// </summary>
public sealed class EventQueue : IDisposable
{
    // One SqliteConnection is shared by the telemetry thread (Enqueue), the
    // flush loop, and status snapshots — SqliteConnection is not thread-safe,
    // so every operation serializes on this lock.
    private readonly object _lock = new();
    private readonly SqliteConnection _connection;

    /// <summary>Set when this rig's previous lap queue could not be read and was
    /// replaced. Null on every ordinary start. See <see cref="OutboxRecovery"/>
    /// for why a damaged queue does not stop the rig.</summary>
    public OutboxRecovery? Recovery { get; }

    public EventQueue(string databasePath)
    {
        (_connection, Recovery) = OpenOrReplace(databasePath);
    }

    /// <summary>
    /// Open the rig's queue, replacing a database file this machine can no
    /// longer read.
    ///
    /// A venue computer loses power mid-write, has its folder copied while the
    /// agent is running, or is handed a file some backup tool half-restored, and
    /// SQLite then refuses the file outright. Left alone that is the worst
    /// failure shape this agent has: the agent cannot start, so the rig scores
    /// nothing, shows no driver, and reads on the staff dashboard exactly like a
    /// machine nobody ever installed it on — every restart, for the rest of its
    /// life, because a restart is what people try.
    ///
    /// So a queue that cannot be read is moved aside and a fresh one opened. It
    /// is moved rather than deleted, the same posture as
    /// <see cref="Quarantine"/>, because it is the only evidence of what the
    /// machine lost. What it costs is the laps still waiting in it — normally
    /// none, because the flush loop empties it every few seconds — and what it
    /// buys is every lap driven from that seat afterwards.
    ///
    /// Only a file SQLite says is not readable as a database is replaced. A path
    /// the agent may not write, a disk with nothing left on it, or a file
    /// another process is holding are all reported as themselves and stop the
    /// start, because replacing the file would not fix any of them and would
    /// turn a loud failure into a nightly, silent one.
    /// </summary>
    private static (SqliteConnection, OutboxRecovery?) OpenOrReplace(string databasePath)
    {
        if (TryOpen(databasePath, out var connection, out var damage))
            return (connection!, null);

        var preserved = MoveAside(databasePath, damage!);

        // Second failure on a file that is now new: nothing about it is a damaged
        // queue any more, so it is reported as itself rather than replaced again.
        if (!TryOpen(databasePath, out var fresh, out var stillBroken))
        {
            throw new OutboxUnusableException(
                $"The agent replaced this rig's unreadable lap queue \"{databasePath}\" "
                + $"(kept as \"{preserved}\") and still cannot open a new one: {stillBroken}.");
        }

        return (fresh!, new OutboxRecovery(databasePath, preserved, damage!));
    }

    /// <summary>Open the queue and prove it can actually be read, or say what is
    /// wrong with it. The schema statement alone reads only page one, so a file
    /// whose header survived a power cut and whose pages did not opens happily
    /// and fails hours later at the first flush; <c>quick_check</c> is what makes
    /// the damage a startup fact instead.</summary>
    private static bool TryOpen(string databasePath, out SqliteConnection? opened, out string? damage)
    {
        opened = null;
        damage = null;
        var connection = new SqliteConnection($"Data Source={databasePath}");
        try
        {
            connection.Open();
            using (var schema = connection.CreateCommand())
            {
                schema.CommandText = """
                    create table if not exists outbox (
                      event_id   text primary key,
                      payload    text not null,
                      created_at text not null
                    );
                    create table if not exists quarantine (
                      event_id       text primary key,
                      payload        text not null,
                      created_at     text not null,
                      quarantined_at text not null,
                      reason         text not null
                    );
                    """;
                schema.ExecuteNonQuery();
            }

            using (var check = connection.CreateCommand())
            {
                check.CommandText = "pragma quick_check(1)";
                var verdict = check.ExecuteScalar() as string;
                if (!string.Equals(verdict, "ok", StringComparison.OrdinalIgnoreCase))
                {
                    Discard(connection);
                    damage = Truncate(verdict is null or "" ? "the database did not answer an integrity check" : verdict, 200);
                    return false;
                }
            }
        }
        catch (SqliteException ex) when (IsUnreadableDatabase(ex))
        {
            Discard(connection);
            damage = Truncate(ex.Message, 200);
            return false;
        }
        catch (Exception ex)
        {
            // Not a damaged file: a folder the rig may not write, a full disk, a
            // handle somebody else holds. Replacing the file fixes none of them.
            Discard(connection);
            throw new OutboxUnusableException(
                $"The agent cannot open this rig's lap queue \"{databasePath}\": {Sentence(ex.Message)}", ex);
        }

        opened = connection;
        return true;
    }

    /// <summary>The SQLite results that mean "this file is not a queue I can
    /// read", as opposed to "I could not get at this file". Only these are
    /// replaced.</summary>
    private static bool IsUnreadableDatabase(SqliteException ex) =>
        (ex.SqliteErrorCode is SqliteCorrupt or SqliteNotADatabase)
        // Microsoft.Data.Sqlite reports the primary code on SqliteErrorCode and
        // the extended one (SQLITE_CORRUPT_VTAB = 267, …) on SqliteExtendedErrorCode.
        || (ex.SqliteExtendedErrorCode & 0xFF) is SqliteCorrupt or SqliteNotADatabase;

    private const int SqliteCorrupt = 11;      // SQLITE_CORRUPT
    private const int SqliteNotADatabase = 26; // SQLITE_NOTADB

    /// <summary>Close a connection and let go of the file. Microsoft.Data.Sqlite
    /// pools connections, so disposing one keeps the handle open — and on
    /// Windows an open handle is what makes the rename below fail. Clearing the
    /// pool is not optional here, and it is invisible on a developer's Mac.</summary>
    private static void Discard(SqliteConnection connection)
    {
        try
        {
            SqliteConnection.ClearPool(connection);
            connection.Dispose();
        }
        catch
        {
            // Nothing left to do with a connection we are abandoning.
        }
    }

    /// <summary>Keep the damaged queue under a dated name and clear the sidecar
    /// files with it, then leave only the most recent few behind.</summary>
    private static string MoveAside(string databasePath, string damage)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(databasePath)) ?? ".";
        var stem = Path.GetFileNameWithoutExtension(databasePath);
        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'");
        var preserved = Path.Combine(directory, $"{stem}.damaged-{stamp}{Path.GetExtension(databasePath)}");
        // Two replacements inside one second on one machine is only reachable from
        // a test, but a name collision there would throw and read as a second bug.
        for (var n = 2; File.Exists(preserved); n++)
            preserved = Path.Combine(directory, $"{stem}.damaged-{stamp}-{n}{Path.GetExtension(databasePath)}");

        try
        {
            File.Move(databasePath, preserved);
            // A rollback journal or WAL left beside the damaged file belongs to
            // it. Leaving them behind would have SQLite replay a stranger's
            // journal into the fresh queue, which is how a recovery makes a
            // second corrupt file.
            foreach (var sidecar in new[] { "-journal", "-wal", "-shm" })
            {
                var path = databasePath + sidecar;
                if (File.Exists(path)) File.Move(path, preserved + sidecar, overwrite: true);
            }
        }
        catch (Exception ex)
        {
            throw new OutboxUnusableException(
                $"This rig's lap queue \"{databasePath}\" cannot be read ({damage}) and the agent "
                + $"could not move it aside to start a new one: {ex.Message}. "
                + "Close anything holding that file, or delete it, and start the agent again.", ex);
        }

        PruneDamagedCopies(directory, stem, Path.GetExtension(databasePath));
        return preserved;
    }

    /// <summary>Nobody visits twenty-plus rigs to clear a folder, so the kept
    /// copies are capped like the log and the quarantine are. A machine damaging
    /// its queue nightly must not also fill its disk.</summary>
    private static void PruneDamagedCopies(string directory, string stem, string extension)
    {
        try
        {
            var kept = Directory.GetFiles(directory, $"{stem}.damaged-*{extension}")
                .OrderByDescending(f => f, StringComparer.Ordinal)
                .Skip(DamagedCopyLimit);
            foreach (var old in kept)
            {
                try { File.Delete(old); } catch { /* evidence, not correctness */ }
                foreach (var sidecar in new[] { "-journal", "-wal", "-shm" })
                {
                    try { File.Delete(old + sidecar); } catch { /* as above */ }
                }
            }
        }
        catch
        {
            // Housekeeping. A rig that cannot tidy up still has a working queue.
        }
    }

    private const int DamagedCopyLimit = 3;

    /// <summary>Queue a lap. Returns false if this event_id is already queued or
    /// was already queued (idempotent — safe to call on every detection).
    ///
    /// <paramref name="rigAssignmentId"/> is the assignment the agent believed
    /// was open when the lap was driven, captured here rather than at flush
    /// time: a lap that waits out a network outage must still land on the
    /// driver who drove it, not on whoever is checked in when it finally
    /// carries. Null means the agent knew of no check-in, and the backend
    /// falls back to the rig's open assignment guarded by the lap's own
    /// completion time.</summary>
    public bool Enqueue(LapCompleted lap, string? rigAssignmentId = null)
    {
        // A blank id would defeat idempotency here and at the backend.
        if (string.IsNullOrWhiteSpace(lap.EventId))
            throw new ArgumentException("EventId must not be blank", nameof(lap));

        var payload = new JsonObject
        {
            ["type"] = "LAP_COMPLETED",
            ["eventId"] = lap.EventId,
            ["rigAssignmentId"] = string.IsNullOrWhiteSpace(rigAssignmentId) ? null : rigAssignmentId,
            ["trackName"] = lap.TrackName,
            ["trackConfig"] = lap.TrackConfig,
            ["carName"] = lap.CarName,
            ["lapNumber"] = lap.LapNumber,
            ["lapTimeMs"] = lap.LapTimeMs,
            ["incidentDelta"] = lap.IncidentDelta,
            ["offTrackSeen"] = lap.OffTrackSeen,
            ["completedAt"] = lap.CompletedAt.ToString("o"),
        }.ToJsonString();

        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = """
                insert into outbox (event_id, payload, created_at)
                values ($id, $payload, $created)
                on conflict (event_id) do nothing;
                """;
            cmd.Parameters.AddWithValue("$id", lap.EventId);
            cmd.Parameters.AddWithValue("$payload", payload);
            cmd.Parameters.AddWithValue("$created", DateTimeOffset.UtcNow.ToString("o"));
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Oldest-first batch of queued payloads (as parsed JSON nodes).
    ///
    /// A row whose payload no longer parses is quarantined instead of throwing.
    /// Letting the read fail would take the whole flush down every five seconds
    /// for the rest of the machine's life, because the unreadable row is at the
    /// head of the queue and nothing behind it is ever reached.</summary>
    public IReadOnlyList<QueuedEvent> PendingBatch(int limit)
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = "select event_id, payload from outbox order by created_at asc limit $limit";
            cmd.Parameters.AddWithValue("$limit", limit);

            var results = new List<QueuedEvent>();
            var unreadable = new List<string>();
            using (var reader = cmd.ExecuteReader())
            {
                while (reader.Read())
                {
                    var id = reader.GetString(0);
                    JsonNode? node;
                    try
                    {
                        node = JsonNode.Parse(reader.GetString(1));
                    }
                    catch (JsonException)
                    {
                        node = null;
                    }

                    if (node is null) unreadable.Add(id);
                    else results.Add(new QueuedEvent(id, node));
                }
            }

            if (unreadable.Count > 0) QuarantineLocked(unreadable, "payload is not readable JSON");
            return results;
        }
    }

    /// <summary>Remove events the backend has accepted or deduplicated.</summary>
    public void Remove(IEnumerable<string> eventIds)
    {
        lock (_lock)
        {
            using var tx = _connection.BeginTransaction();
            foreach (var id in eventIds)
            {
                using var cmd = _connection.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = "delete from outbox where event_id = $id";
                cmd.Parameters.AddWithValue("$id", id);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }

    /// <summary>Move events aside that the backend will never accept, keeping
    /// their payload and the reason. Called when the backend refuses an event
    /// outright (HTTP 400) rather than judging it — retrying such an event is
    /// not "eventually consistent", it is a queue that never drains again.</summary>
    public void Quarantine(IEnumerable<string> eventIds, string reason)
    {
        lock (_lock) QuarantineLocked(eventIds, reason);
    }

    private void QuarantineLocked(IEnumerable<string> eventIds, string reason)
    {
        var now = DateTimeOffset.UtcNow.ToString("o");
        using var tx = _connection.BeginTransaction();
        foreach (var id in eventIds)
        {
            using var move = _connection.CreateCommand();
            move.Transaction = tx;
            move.CommandText = """
                insert into quarantine (event_id, payload, created_at, quarantined_at, reason)
                select event_id, payload, created_at, $at, $reason from outbox where event_id = $id
                on conflict (event_id) do update set quarantined_at = $at, reason = $reason;
                delete from outbox where event_id = $id;
                """;
            move.Parameters.AddWithValue("$id", id);
            move.Parameters.AddWithValue("$at", now);
            move.Parameters.AddWithValue("$reason", Truncate(reason, 500));
            move.ExecuteNonQuery();
        }

        // Nobody visits twenty-plus rigs to clear a database, so the evidence
        // is capped the same way the log is: the newest failures are the ones
        // worth keeping.
        using var prune = _connection.CreateCommand();
        prune.Transaction = tx;
        prune.CommandText = """
            delete from quarantine where event_id not in (
              select event_id from quarantine order by quarantined_at desc, event_id desc limit $keep
            );
            """;
        prune.Parameters.AddWithValue("$keep", QuarantineLimit);
        prune.ExecuteNonQuery();

        tx.Commit();
    }

    /// <summary>How many quarantined laps this rig is holding — the number that
    /// says "this machine needs looking at" rather than "this machine is busy".</summary>
    public int QuarantinedCount()
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = "select count(*) from quarantine";
            return Convert.ToInt32(cmd.ExecuteScalar());
        }
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    /// <summary>SQLite's messages already end in a full stop; a second one reads
    /// like a typo on the one line an operator is going to retype into a search.</summary>
    private static string Sentence(string value)
    {
        var trimmed = value.TrimEnd();
        return trimmed.EndsWith('.') ? trimmed : trimmed + ".";
    }

    private const int QuarantineLimit = 200;

    public int PendingCount()
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = "select count(*) from outbox";
            return Convert.ToInt32(cmd.ExecuteScalar());
        }
    }

    public void Dispose() => _connection.Dispose();
}

public sealed record QueuedEvent(string EventId, JsonNode Payload);

/// <summary>What happened when this rig's previous lap queue could not be read:
/// the file that was replaced, where it was kept, and what SQLite said was wrong
/// with it. Held so the agent can say it out loud at startup — a queue that was
/// thrown away is the one thing about a recovered rig that a person has to know,
/// because whatever was still in it was never delivered.</summary>
public sealed record OutboxRecovery(string DamagedPath, string PreservedPath, string Damage)
{
    /// <summary>The whole story in one line, in the order somebody reading a rig's
    /// log needs it: what was lost, why, and where to look.</summary>
    public string Describe() =>
        $"This rig's lap queue \"{DamagedPath}\" could not be read ({Damage}), so it was replaced "
        + $"and the unreadable one kept as \"{PreservedPath}\". Any lap still waiting in it was not "
        + "delivered. The rig is scoring again from now; have the machine's disk looked at, because "
        + "a queue does not damage itself.";
}

/// <summary>This rig cannot keep a lap. Raised only for a queue the agent could
/// not open and could not replace — a folder it may not write, a full disk, a
/// file something else is holding — so the start stops with the real reason
/// rather than pointing at the config file, which is what a rig with a damaged
/// queue used to be told to fix.</summary>
public sealed class OutboxUnusableException : Exception
{
    public OutboxUnusableException(string message, Exception? inner = null) : base(message, inner) { }
}
