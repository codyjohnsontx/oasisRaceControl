using System.Globalization;
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
/// It also holds the one other scrap of agent state that must outlive the
/// process: a checkout the agent has already applied locally but has not yet
/// managed to deliver. See <see cref="ReadPendingCheckout"/> for why that has
/// to be on disk rather than in a field.
/// </summary>
public sealed class EventQueue : IDisposable
{
    // One SqliteConnection is shared by the telemetry thread (Enqueue), the
    // flush loop, and status snapshots — SqliteConnection is not thread-safe,
    // so every operation serializes on this lock.
    private readonly object _lock = new();
    private readonly SqliteConnection _connection;

    public EventQueue(string databasePath)
    {
        _connection = new SqliteConnection($"Data Source={databasePath}");
        _connection.Open();
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = """
            create table if not exists outbox (
              event_id   text primary key,
              payload    text not null,
              created_at text not null,
              resolved   integer not null default 1
            );
            create table if not exists pending_checkout (
              id            integer primary key check (id = 1),
              assignment_id text not null,
              ended_at      text not null
            );
            """;
        cmd.ExecuteNonQuery();
        AddResolvedColumnIfMissing();
    }

    /// <summary>An outbox written by an agent build that predates the unresolved
    /// state has no `resolved` column, and `create table if not exists` will not
    /// add one. The only builds that wrote such a file are pre-0.2, and their
    /// Enqueue wrote no `rigAssignmentId` key at all, so not one of the rows they
    /// left behind carries an owner. Flushing them as they stand would reach the
    /// backend with the key absent, which it reads as "this agent is too old to
    /// say" and stores unattributed - a checked-in driver's queued laps landing
    /// unclaimed on the very upgrade that was meant to stamp them.
    ///
    /// So the back-fill marks them UNRESOLVED, and the first successful poll
    /// stamps each one against its own completedAt through ResolveUnresolved,
    /// exactly like every other unresolved row. The column default only ever
    /// applies to the rows this ALTER back-fills: every Insert names `resolved`
    /// explicitly.
    ///
    /// This path is reasoned, not walked. The agent is still a Phase 2 skeleton
    /// on simulated telemetry, so no real rig has yet been upgraded holding a
    /// queued backlog.</summary>
    private void AddResolvedColumnIfMissing()
    {
        using var probe = _connection.CreateCommand();
        probe.CommandText =
            "select count(*) from pragma_table_info('outbox') where name = 'resolved'";
        if (Convert.ToInt32(probe.ExecuteScalar()) > 0) return;

        using var alter = _connection.CreateCommand();
        alter.CommandText = "alter table outbox add column resolved integer not null default 0";
        alter.ExecuteNonQuery();
    }

    /// <summary>Queue a lap whose owner is already known. Returns false if this
    /// event_id is already queued or was already queued (idempotent - safe to
    /// call on every detection).
    ///
    /// <paramref name="rigAssignmentId"/> is the assignment this rig had at the
    /// moment the lap was captured, or null if nobody was checked in. It is
    /// required, not optional, because the queued payload is what the backend
    /// attributes from - a caller that could omit it would be handing the
    /// backend a lap with no owner and no way to say so. A caller that does not
    /// yet KNOW the answer has EnqueueUnresolved instead, and must not pass null
    /// to mean "I cannot say".</summary>
    public bool Enqueue(LapCompleted lap, string? rigAssignmentId)
    {
        var payload = BuildPayload(lap);
        // Always written, null included. The backend reads an ABSENT key as
        // "this agent is too old to say who was driving" and stores the lap
        // unattributed; an explicit null is the different, answerable "nobody
        // was checked in". Same distinction as trackConfig: a null string lands
        // as a JSON null, not a missing property.
        payload["rigAssignmentId"] = rigAssignmentId;
        return Insert(lap.EventId, payload, resolved: true);
    }

    /// <summary>Queue a lap captured before the agent had ever reached the
    /// backend, so it has no assignment answer to stamp - not even "nobody was
    /// checked in", which is a claim it cannot make. The row is durable but
    /// UNSENDABLE (PendingBatch skips it) until ResolveUnresolved stamps it from
    /// the first poll that gets through; sending it as an explicit null would
    /// permanently unattribute a driver who was checked in the whole time.</summary>
    public bool EnqueueUnresolved(LapCompleted lap)
        => Insert(lap.EventId, BuildPayload(lap), resolved: false);

    /// <summary>Stamp every unresolved lap with the answer the agent's first
    /// successful assignment poll returned, and make them sendable. Returns how
    /// many rows it resolved. Laps already stamped at capture are untouched.
    ///
    /// The answer is decided PER ROW, against that lap's own `completedAt`. A
    /// lap only takes <paramref name="assignment"/>'s id if it was driven at or
    /// after that assignment started; a lap driven before the driver sat down
    /// takes an explicit null, because nobody owns it. Stamping the whole
    /// backlog with one id would credit a guest's warm-up laps to the first
    /// customer to check in afterwards, which is the misattribution the
    /// capture-time stamp exists to remove. A poll that finds nobody checked in
    /// resolves every row to an explicit null.</summary>
    public int ResolveUnresolved(Assignment? assignment, TimeSpan serverClockOffset)
    {
        lock (_lock)
        {
            using var tx = _connection.BeginTransaction();

            var pending = new List<(string EventId, JsonNode Payload)>();
            using (var read = _connection.CreateCommand())
            {
                read.Transaction = tx;
                read.CommandText = "select event_id, payload from outbox where resolved = 0";
                using var reader = read.ExecuteReader();
                while (reader.Read())
                    pending.Add((reader.GetString(0), JsonNode.Parse(reader.GetString(1))!));
            }

            foreach (var (eventId, payload) in pending)
            {
                payload["rigAssignmentId"] = OwnerOf(payload, assignment, serverClockOffset);
                using var update = _connection.CreateCommand();
                update.Transaction = tx;
                update.CommandText =
                    "update outbox set payload = $payload, resolved = 1 where event_id = $id";
                update.Parameters.AddWithValue("$payload", payload.ToJsonString());
                update.Parameters.AddWithValue("$id", eventId);
                update.ExecuteNonQuery();
            }

            tx.Commit();
            return pending.Count;
        }
    }

    /// <summary>Which assignment, if any, a queued lap belongs to given what the
    /// first successful poll reported. An unreadable `completedAt` cannot be
    /// shown to fall inside the assignment, so it resolves to null rather than
    /// blocking the whole backlog on one damaged row.</summary>
    private static string? OwnerOf(JsonNode payload, Assignment? assignment, TimeSpan serverClockOffset)
    {
        if (assignment is null) return null;

        var completedAt = payload["completedAt"]?.GetValue<string>();
        // completedAt is stamped by THIS machine and StartedAt by the server, so
        // comparing them raw would let a rig clock that runs a few minutes fast
        // decide a warm-up lap was driven after a check-in it actually preceded
        // - and credit that customer with someone else's laps, which is the
        // whole defect this path exists to prevent. serverClockOffset comes from
        // the same poll that produced the assignment and moves the rig timestamp
        // into server time, so both sides of the comparison share a clock.
        return DateTimeOffset.TryParse(
                   completedAt, CultureInfo.InvariantCulture,
                   DateTimeStyles.RoundtripKind, out var driven)
               && driven + serverClockOffset >= assignment.StartedAt
            ? assignment.Id
            : null;
    }

    /// <summary>The stint this agent has ended locally and still owes the
    /// backend, or null if it owes none.
    ///
    /// This lives on disk rather than in a field because the case it exists for
    /// is the one where the process does not survive: a rig PC that reboots
    /// during the same outage that swallowed the checkout. On the way back up
    /// the agent's first poll reports that assignment still open - the backend
    /// was never told - and an agent that had forgotten the checkout would adopt
    /// the departed driver again and stamp the next person's laps with them,
    /// which is the whole defect the local clear removes.
    ///
    /// At most one is outstanding. A second switch-driver before the first has
    /// been delivered replaces it: only the latest stint the agent ended is
    /// still owed, and every earlier one has already been closed by it.</summary>
    public string? ReadPendingCheckout()
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = "select assignment_id from pending_checkout where id = 1";
            return cmd.ExecuteScalar() as string;
        }
    }

    /// <summary>Record that <paramref name="assignmentId"/> has been ended here
    /// and the backend has yet to hear about it.</summary>
    public void SetPendingCheckout(string assignmentId)
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = """
                insert into pending_checkout (id, assignment_id, ended_at)
                values (1, $id, $ended)
                on conflict (id) do update
                  set assignment_id = excluded.assignment_id,
                      ended_at = excluded.ended_at;
                """;
            cmd.Parameters.AddWithValue("$id", assignmentId);
            cmd.Parameters.AddWithValue("$ended", DateTimeOffset.UtcNow.ToString("o"));
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>Forget a delivered checkout. Scoped to the assignment it
    /// settled, so a late acknowledgement cannot wipe a newer checkout that a
    /// second driver's sign-out recorded while the first was in flight - that
    /// one is still owed, and dropping it would leave a stint open forever.</summary>
    public void ClearPendingCheckout(string assignmentId)
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = "delete from pending_checkout where id = 1 and assignment_id = $id";
            cmd.Parameters.AddWithValue("$id", assignmentId);
            cmd.ExecuteNonQuery();
        }
    }

    private static JsonObject BuildPayload(LapCompleted lap)
    {
        // A blank id would defeat idempotency here and at the backend.
        if (string.IsNullOrWhiteSpace(lap.EventId))
            throw new ArgumentException("EventId must not be blank", nameof(lap));

        return new JsonObject
        {
            ["type"] = "LAP_COMPLETED",
            ["eventId"] = lap.EventId,
            ["trackName"] = lap.TrackName,
            ["trackConfig"] = lap.TrackConfig,
            ["carName"] = lap.CarName,
            ["lapNumber"] = lap.LapNumber,
            ["lapTimeMs"] = lap.LapTimeMs,
            ["incidentDelta"] = lap.IncidentDelta,
            ["completedAt"] = lap.CompletedAt.ToString("o"),
        };
    }

    private bool Insert(string eventId, JsonObject payload, bool resolved)
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText = """
                insert into outbox (event_id, payload, created_at, resolved)
                values ($id, $payload, $created, $resolved)
                on conflict (event_id) do nothing;
                """;
            cmd.Parameters.AddWithValue("$id", eventId);
            cmd.Parameters.AddWithValue("$payload", payload.ToJsonString());
            cmd.Parameters.AddWithValue("$created", DateTimeOffset.UtcNow.ToString("o"));
            cmd.Parameters.AddWithValue("$resolved", resolved ? 1 : 0);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    /// <summary>Oldest-first batch of queued payloads (as parsed JSON nodes).
    /// Unresolved laps are deliberately invisible here: transmitting one would
    /// reach the backend as "nobody was checked in", which is exactly the answer
    /// the agent does not have yet.</summary>
    public IReadOnlyList<QueuedEvent> PendingBatch(int limit)
    {
        lock (_lock)
        {
            using var cmd = _connection.CreateCommand();
            cmd.CommandText =
                "select event_id, payload from outbox where resolved = 1 order by created_at asc limit $limit";
            cmd.Parameters.AddWithValue("$limit", limit);

            var results = new List<QueuedEvent>();
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var id = reader.GetString(0);
                var node = JsonNode.Parse(reader.GetString(1))!;
                results.Add(new QueuedEvent(id, node));
            }
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

    /// <summary>Everything the outbox is still holding, unresolved laps
    /// included - they are queued and will be sent, just not yet.</summary>
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
