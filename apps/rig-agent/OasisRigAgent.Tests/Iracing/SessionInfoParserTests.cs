using Xunit;
using System.Text;
using OasisRigAgent.Core.Iracing;

namespace OasisRigAgent.Tests.Iracing;

public sealed class SessionInfoParserTests
{
    // Shaped like iRacing's own session string: one key per line, list items
    // as "- CarIdx: n" with indented fields, values sometimes quoted.
    private const string Cota = """
        ---
        WeekendInfo:
         TrackName: cota gp
         TrackID: 218
         TrackLength: 5.49 km
         TrackDisplayName: Circuit of the Americas
         TrackDisplayShortName: COTA
         TrackConfigName: Grand Prix
         TrackCity: Austin
        SessionInfo:
         Sessions:
         - SessionNum: 0
           SessionType: Practice
        DriverInfo:
         DriverCarIdx: 2
         DriverUserID: 12345
         Drivers:
         - CarIdx: 0
           UserName: Pace Car
           CarScreenName: safety pcfr500s
           CarID: 76
         - CarIdx: 2
           UserName: 'O''Brien, Cody'
           CarScreenName: FIA F4
           CarScreenNameShort: F4
           CarID: 137
         - CarIdx: 3
           UserName: Someone Else
           CarScreenName: Porsche 911 GT3 R
           CarID: 88
        ...
        """;

    [Fact]
    public void ReadsTheTrackLayoutAndThePlayersOwnCar()
    {
        var combo = SessionInfoParser.Parse(Cota);
        Assert.NotNull(combo);
        Assert.Equal("Circuit of the Americas", combo!.TrackDisplayName);
        Assert.Equal("Grand Prix", combo.TrackConfigName);
        Assert.Equal("FIA F4", combo.CarScreenName);
        Assert.Equal(2, combo.PlayerCarIdx);
        Assert.Equal("cota gp", combo.TrackName);
        Assert.Equal(218, combo.TrackId);
        Assert.Equal(137, combo.CarId);
    }

    [Fact]
    public void SingleLayoutTrackHasNoConfig()
    {
        var yaml = Cota.Replace("TrackConfigName: Grand Prix", "TrackConfigName: ");
        Assert.Null(SessionInfoParser.Parse(yaml)!.TrackConfigName);
    }

    [Fact]
    public void FallsBackToTelemetryCarIdxWhenDriverCarIdxIsMissing()
    {
        // No line ending in the search: a Windows checkout gives the fixture CRLF.
        var yaml = Cota.Replace(" DriverCarIdx: 2", "");
        Assert.DoesNotContain("DriverCarIdx", yaml);
        Assert.Equal("Porsche 911 GT3 R", SessionInfoParser.Parse(yaml, telemetryPlayerCarIdx: 3)!.CarScreenName);
        Assert.Null(SessionInfoParser.Parse(yaml));
    }

    [Fact]
    public void UnquotesYamlStrings()
    {
        var yaml = Cota.Replace("TrackDisplayName: Circuit of the Americas", "TrackDisplayName: 'Circuit of the Americas'")
            .Replace("CarScreenName: FIA F4", "CarScreenName: \"FIA F4\"");
        var combo = SessionInfoParser.Parse(yaml)!;
        Assert.Equal("Circuit of the Americas", combo.TrackDisplayName);
        Assert.Equal("FIA F4", combo.CarScreenName);
    }

    [Fact]
    public void ReturnsNullWhileTheDocumentIsStillLoading()
    {
        Assert.Null(SessionInfoParser.Parse("---\nWeekendInfo:\n TrackName: cota gp\n"));
        Assert.Null(SessionInfoParser.Parse(""));
        // A track but no entry for the player's car yet.
        Assert.Null(SessionInfoParser.Parse("WeekendInfo:\n TrackDisplayName: X\nDriverInfo:\n DriverCarIdx: 5\n Drivers:\n - CarIdx: 0\n   CarScreenName: Y\n"));
    }

    [Fact]
    public void DecodesUtf8AndFallsBackToLatin1()
    {
        Assert.Equal("Nürburgring", SessionInfoParser.Decode(Encoding.UTF8.GetBytes("Nürburgring")));
        Assert.Equal("Nürburgring", SessionInfoParser.Decode(Encoding.Latin1.GetBytes("Nürburgring")));
    }

    [Fact]
    public void DecodeStopsAtTheNulTerminator()
    {
        // The region is sized for the largest document; what follows the
        // terminator is padding or the tail of an older, longer one.
        var bytes = Encoding.UTF8.GetBytes("WeekendInfo:\n TrackDisplayName: X\n\0 TrackDisplayName: stale\n\0\0\0");
        Assert.Equal("WeekendInfo:\n TrackDisplayName: X\n", SessionInfoParser.Decode(bytes));
    }

    [Fact]
    public void DescribeFoundSaysHowFarTheScannerGot()
    {
        var found = SessionInfoParser.DescribeFound(
            "WeekendInfo:\n TrackDisplayName: Circuit of the Americas\nDriverInfo:\n DriverCarIdx: 5\n Drivers:\n - CarIdx: 0\n   CarScreenName: Y\n");
        Assert.Contains("TrackDisplayName=\"Circuit of the Americas\"", found);
        Assert.Contains("DriverCarIdx=5", found);
        Assert.Contains("drivers listed=1", found);
        Assert.Contains("player's CarScreenName=no entry", found);
    }

    // A hosted weekend as iRacing lays it out: each session a list item under
    // Sessions, carrying nested lists of its own whose keys sit further in.
    private const string Weekend = """
        ---
        WeekendInfo:
         TrackDisplayName: Circuit of the Americas
         SessionID: 0
        SessionInfo:
         Sessions:
         - SessionNum: 0
           SessionLaps: unlimited
           SessionTime: 600.0000 sec
           SessionType: Practice
           SessionName: PRACTICE
           ResultsPositions:
           - Position: 1
             CarIdx: 2
             FastestTime: 101.9000
           ResultsFastestLap:
           - CarIdx: 2
             FastestLap: 4
         - SessionNum: 1
           SessionType: Open Qualify
           ResultsPositions: 
         - SessionNum: 2
           SessionLaps: 12
           SessionType: Race
        CarSetup:
         SessionType: not a session
        DriverInfo:
         DriverCarIdx: 2
         Drivers:
         - CarIdx: 2
           CarScreenName: FIA F4
        ...
        """;

    [Fact]
    public void ReadsEachSessionsTypeBySessionNum()
    {
        var types = SessionInfoParser.ParseSessionTypes(Weekend);
        Assert.Equal(new Dictionary<int, string> { [0] = "Practice", [1] = "Open Qualify", [2] = "Race" }, types);
        // The combo is read from the same document unchanged.
        Assert.Equal("FIA F4", SessionInfoParser.Parse(Weekend)!.CarScreenName);
    }

    [Fact]
    public void ASessionTypeKeyInsideANestedListIsNotTheSessions()
    {
        const string yaml = """
            SessionInfo:
             Sessions:
             - SessionNum: 0
               ResultsPositions:
               - Position: 1
                 SessionType: Race
               SessionType: Practice
            """;
        Assert.Equal("Practice", SessionInfoParser.ParseSessionTypes(yaml)[0]);
    }

    [Fact]
    public void NoSessionsListedYetIsAnEmptyMap()
    {
        Assert.Empty(SessionInfoParser.ParseSessionTypes(Cota.Replace("SessionType: Practice", "")));
        Assert.Empty(SessionInfoParser.ParseSessionTypes("WeekendInfo:\n TrackName: test\n"));
        Assert.Equal("Practice", SessionInfoParser.ParseSessionTypes(Cota)[0]);
    }
}
