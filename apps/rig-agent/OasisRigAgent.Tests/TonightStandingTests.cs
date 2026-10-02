using System.Text.Json.Nodes;
using OasisRigAgent.Core.WalkUp;
using Xunit;

namespace OasisRigAgent.Tests;

/// <summary>The driving screen's place and best lap, read off the same feed
/// the wall's tonight board polls, so the two never disagree.</summary>
public sealed class TonightStandingTests
{
    private const string Feed = """
        {"rows":[
          {"driver_id":"d-ana","display_name":"Ana","lap_time_ms":131004,"car_name":"FIA F4","incident_delta":0},
          {"driver_id":"d-mike","display_name":"Mike","lap_time_ms":132217,"car_name":"FIA F4","incident_delta":1},
          {"driver_id":"d-chuy","display_name":"chuy","lap_time_ms":140000,"car_name":"FIA F4","incident_delta":null}
        ],"combo":{"track_name":"Circuit of the Americas","track_config":"Grand Prix","car_name":"FIA F4"}}
        """;

    [Fact]
    public void ParsesTheFeedAsTheRouteWritesIt()
    {
        var board = TonightBoard.Parse(JsonNode.Parse(Feed));

        Assert.Equal(new[] { "Ana", "Mike", "chuy" }, board.Rows.Select(r => r.DisplayName));
        Assert.Equal("Circuit of the Americas · Grand Prix · FIA F4", board.Combo);
    }

    [Fact]
    public void ASingleLayoutTrackAndNoComboBothRead()
    {
        Assert.Equal("Daytona · FIA F4",
            TonightBoard.Parse(JsonNode.Parse("""{"rows":[],"combo":{"track_name":"Daytona","track_config":null,"car_name":"FIA F4"}}""")).Combo);
        Assert.Null(TonightBoard.Parse(JsonNode.Parse("""{"rows":[],"combo":null}""")).Combo);
    }

    [Fact]
    public void AFeedWithoutRowsIsMalformedNotEmpty()
    {
        Assert.Throws<FormatException>(() => TonightBoard.Parse(JsonNode.Parse("""{"error":"server_error"}""")));
        Assert.Throws<FormatException>(() => TonightBoard.Parse(JsonNode.Parse("""{"rows":[{"display_name":"x"}]}""")));
    }

    [Fact]
    public void PlaceIsTheRowsPositionAndDriversTheRowCount()
    {
        var board = TonightBoard.Parse(JsonNode.Parse(Feed));

        var mike = TonightStanding.For(board.Rows, "d-mike", board.Combo);
        Assert.Equal((2, 3, 132217, false), (mike.Place, mike.Drivers, mike.BestLapMs, mike.Leading));
        Assert.Equal(board.Combo, mike.Combo);

        var ana = TonightStanding.For(board.Rows, "d-ana", board.Combo);
        Assert.True(ana.Leading);
        Assert.Equal(1, ana.Place);
    }

    /// <summary>No valid lap tonight yet - warming up, the wrong car, over
    /// the incident limit - is no place and no time, with the field's size
    /// still shown.</summary>
    [Fact]
    public void ADriverNotOnTheBoardHasNoPlaceAndNoBestLap()
    {
        var board = TonightBoard.Parse(JsonNode.Parse(Feed));

        var standing = TonightStanding.For(board.Rows, "d-new", board.Combo);

        Assert.Null(standing.Place);
        Assert.Null(standing.BestLapMs);
        Assert.Equal(3, standing.Drivers);
        Assert.False(standing.Leading);
    }
}
