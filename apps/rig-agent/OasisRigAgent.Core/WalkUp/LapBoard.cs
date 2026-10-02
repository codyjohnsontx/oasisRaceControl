namespace OasisRigAgent.Core.WalkUp;

public enum LapRowState
{
    /// <summary>Nobody was signed in when the lap was read; the backend keeps
    /// it unclaimed and it never ranks.</summary>
    NotCounted,
    /// <summary>Stamped with a driver's stint and waiting in the outbox.</summary>
    Queued,
    /// <summary>The backend has it.</summary>
    Posted,
}

/// <summary>One lap as the driver sees it: what the sim reported, whose stint
/// it was stamped with, and how far it has got.</summary>
public sealed record LapRow(string EventId, int? LapNumber, int LapTimeMs, int? IncidentDelta, string? Stamp, LapRowState State)
{
    public string Label => $"Lap {LapNumber?.ToString() ?? "-"}  {LapTime.Format(LapTimeMs)}  incidents {IncidentDelta?.ToString() ?? "n/a"}";

    /// <summary>The row as one console line.</summary>
    public string Describe() => State switch
    {
        LapRowState.NotCounted => $"{Label} - lap not counted - sign in first",
        LapRowState.Queued => $"{Label} - queued",
        _ => $"{Label} - posted",
    };
}

/// <summary>
/// The laps of this run as rows, from <see cref="AgentService.LapQueued"/> and
/// <see cref="AgentService.LapsPosted"/>: the console prints each change as a
/// line, the window shows the current stint's rows. Thread-safe; the agent
/// raises both events off its own loops.
/// </summary>
public sealed class LapBoard
{
    private const int KeptRows = 200;
    private readonly object _lock = new();
    private readonly List<LapRow> _rows = new();

    /// <summary>A lap the agent queued (or, with a null stamp, read with nobody
    /// signed in). Returns the new row.</summary>
    public LapRow Queued(LapCompleted lap, string? stamp)
    {
        var row = new LapRow(lap.EventId, lap.LapNumber, lap.LapTimeMs, lap.IncidentDelta, stamp,
            stamp is null ? LapRowState.NotCounted : LapRowState.Queued);
        lock (_lock)
        {
            _rows.Add(row);
            if (_rows.Count > KeptRows) _rows.RemoveAt(0);
        }
        return row;
    }

    /// <summary>The backend has these event ids now. Returns the rows that were
    /// queued here and are posted now; ids this board never queued (a heartbeat,
    /// a lap from before this run) are not rows and are ignored.</summary>
    public IReadOnlyList<LapRow> Posted(IReadOnlyList<string> eventIds)
    {
        var posted = new List<LapRow>();
        lock (_lock)
        {
            foreach (var eventId in eventIds)
            {
                var i = _rows.FindIndex(r => r.EventId == eventId && r.State == LapRowState.Queued);
                if (i < 0) continue;
                _rows[i] = _rows[i] with { State = LapRowState.Posted };
                posted.Add(_rows[i]);
            }
        }
        return posted;
    }

    /// <summary>Every row, oldest first.</summary>
    public IReadOnlyList<LapRow> Rows
    {
        get { lock (_lock) return _rows.ToList(); }
    }

    /// <summary>The rows stamped with one stint, oldest first: what the driving
    /// screen shows under a driver's name.</summary>
    public IReadOnlyList<LapRow> RowsFor(string assignmentId)
    {
        lock (_lock) return _rows.Where(r => r.Stamp == assignmentId).ToList();
    }
}
