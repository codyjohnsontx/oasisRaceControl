using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace OasisRigAgent.Core;

/// <summary>
/// Durable, idempotent outbox for lap events. Laps are written here the instant
/// they are detected and only removed once the backend has accepted (or
/// deduplicated) them, so a network outage or agent restart never loses a lap.
/// The event_id primary key makes re-enqueuing the same lap a no-op.
/// </summary>
public sealed class EventQueue : IDisposable
{
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
              created_at text not null
            );
            """;
        cmd.ExecuteNonQuery();
    }

    /// <summary>Queue a lap. Returns false if this event_id is already queued or
    /// was already queued (idempotent — safe to call on every detection).</summary>
    public bool Enqueue(LapCompleted lap)
    {
        var payload = new JsonObject
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
        }.ToJsonString();

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

    /// <summary>Oldest-first batch of queued payloads (as parsed JSON nodes).</summary>
    public IReadOnlyList<QueuedEvent> PendingBatch(int limit)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "select event_id, payload from outbox order by created_at asc limit $limit";
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

    /// <summary>Remove events the backend has accepted or deduplicated.</summary>
    public void Remove(IEnumerable<string> eventIds)
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

    public int PendingCount()
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "select count(*) from outbox";
        return Convert.ToInt32(cmd.ExecuteScalar());
    }

    public void Dispose() => _connection.Dispose();
}

public sealed record QueuedEvent(string EventId, JsonNode Payload);
