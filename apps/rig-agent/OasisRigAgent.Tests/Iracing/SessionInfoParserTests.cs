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
}
