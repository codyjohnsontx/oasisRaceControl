using OasisRigAgent.Core;
using OasisRigAgent.Core.WalkUp;
using Xunit;

namespace OasisRigAgent.Tests;

public sealed class LapBoardTests
{
    private static LapCompleted Lap(string eventId, int lapNumber, int? incidents = 0) => new()
    {
        EventId = eventId,
        TrackName = "Circuit of the Americas",
        TrackConfig = "Grand Prix",
        CarName = "FIA F4",
        LapNumber = lapNumber,
        LapTimeMs = 137_217,
        IncidentDelta = incidents,
        CompletedAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public void ALapIsQueuedThenPostedAndSaysSoInTheConsolesWords()
    {
        var board = new LapBoard();
        var queued = board.Queued(Lap("evt-1", 2), "a-mike");
        Assert.Equal("Lap 2  2:17.217  incidents 0 - queued", queued.Describe());
        Assert.Equal(LapRowState.Queued, queued.State);

        var posted = board.Posted(["evt-heartbeat", "evt-1"]);
        var row = Assert.Single(posted);
        Assert.Equal("Lap 2  2:17.217  incidents 0 - posted", row.Describe());
        Assert.Equal(LapRowState.Posted, Assert.Single(board.Rows).State);

        // Posting it again changes nothing and reports nothing.
        Assert.Empty(board.Posted(["evt-1"]));
    }

    [Fact]
    public void ALapWithNobodySignedInIsNotCountedAndNeverPosts()
    {
        var board = new LapBoard();
        var row = board.Queued(Lap("evt-nobody", 1, incidents: null), null);
        Assert.Equal("Lap 1  2:17.217  incidents n/a - lap not counted - sign in first", row.Describe());
        Assert.Empty(board.Posted(["evt-nobody"]));
        Assert.Equal(LapRowState.NotCounted, Assert.Single(board.Rows).State);
    }

    [Fact]
    public void TheDrivingScreenShowsOnlyTheSeatedStintsLaps()
    {
        var board = new LapBoard();
        board.Queued(Lap("evt-nobody", 1), null);
        board.Queued(Lap("evt-mike", 2), "a-mike");
        board.Queued(Lap("evt-alex", 3), "a-alex");
        Assert.Equal(["evt-mike"], board.RowsFor("a-mike").Select(r => r.EventId));
        Assert.Equal(3, board.Rows.Count);
    }

    [Fact]
    public void AnUnnumberedLapShowsADash()
    {
        var row = new LapBoard().Queued(Lap("evt-x", 0) with { LapNumber = null }, "a");
        Assert.StartsWith("Lap -  2:17.217", row.Label);
    }
}
