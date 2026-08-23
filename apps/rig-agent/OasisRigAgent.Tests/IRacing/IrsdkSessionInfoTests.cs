using System.Text;
using OasisRigAgent.Core.IRacing;
using Xunit;

namespace OasisRigAgent.Tests.IRacing;

/// <summary>
/// These are the names customers read on the leaderboard, so a wrong answer here
/// is a visibly wrong result rather than a silent one. The rule under test is that
/// the reader either knows the combo or says it does not - it never half-labels a
/// lap from a payload it did not understand.
/// </summary>
public sealed class IrsdkSessionInfoTests
{
    /// <summary>Shaped like the sim's own payload: single-space indentation, a nested
    /// options block under the same section, and a driver list the player is one entry
    /// of.</summary>
    private const string RealisticPayload = """
        ---
        WeekendInfo:
         TrackName: spa gp
         TrackID: 341
         TrackLength: 7.00 km
         TrackDisplayName: Circuit de Spa-Francorchamps
         TrackDisplayShortName: Spa
         TrackConfigName: Grand Prix Pits
         TrackCity: Francorchamps
         WeekendOptions:
          NumStarters: 0
          StartingGrid: single file
          QualifyScoring: best lap
        SessionInfo:
         Sessions:
         - SessionNum: 0
           SessionLaps: unlimited
           SessionType: Offline Testing
        DriverInfo:
         DriverCarIdx: 1
         DriverUserID: 654321
         PaceCarIdx: -1
         Drivers:
         - CarIdx: 0
           UserName: Pace Car
           CarScreenName: Pace Car
           CarID: 0
         - CarIdx: 1
           UserName: Cody J
           CarScreenName: Porsche 911 GT3 R
           CarID: 173
           CarClassShortName: GT3
        ...
        """;

    [Fact]
    public void ReadsTheComboFromTheSimsOwnPayload()
    {
        var identity = IrsdkSessionInfo.Parse(RealisticPayload);

        Assert.NotNull(identity);
        Assert.Equal("Circuit de Spa-Francorchamps", identity!.TrackName);
        Assert.Equal("Grand Prix Pits", identity.TrackConfig);
        Assert.Equal("Porsche 911 GT3 R", identity.CarName);
        Assert.Equal(341, identity.TrackId);
        Assert.Equal(173, identity.CarId);
    }

    [Fact]
    public void TakesTheCarOfTheDriverAtThisRigRatherThanTheFirstInTheList()
    {
        // The player is index 1; index 0 is the pace car and would be the wrong answer.
        Assert.Equal("Porsche 911 GT3 R", IrsdkSessionInfo.Parse(RealisticPayload)!.CarName);
    }

    [Fact]
    public void FallsBackToTheInternalTrackNameOnlyWhenThereIsNoDisplayName()
    {
        var payload = RealisticPayload.Replace(" TrackDisplayName: Circuit de Spa-Francorchamps\n", "");

        Assert.Equal("spa gp", IrsdkSessionInfo.Parse(payload)!.TrackName);
    }

    [Fact]
    public void ReportsNoConfigurationForATrackThatHasOnlyOne()
    {
        var payload = RealisticPayload.Replace("TrackConfigName: Grand Prix Pits", "TrackConfigName:");

        Assert.Null(IrsdkSessionInfo.Parse(payload)!.TrackConfig);
    }

    [Fact]
    public void UnwrapsValuesTheSimQuoted()
    {
        var payload = RealisticPayload.Replace("CarScreenName: Porsche 911 GT3 R", "CarScreenName: \"Dallara P217: LMP2\"");

        Assert.Equal("Dallara P217: LMP2", IrsdkSessionInfo.Parse(payload)!.CarName);
    }

    [Fact]
    public void StopsAtTheTerminatorRatherThanReadingTheRestOfTheRegion()
    {
        var region = new byte[8192];
        Encoding.UTF8.GetBytes(RealisticPayload).CopyTo(region, 0);
        // Whatever the producer left behind after the payload must not be read as content.
        Encoding.UTF8.GetBytes("WeekendInfo:\n TrackDisplayName: stale\n").CopyTo(region, 6000);

        Assert.Equal("Circuit de Spa-Francorchamps", IrsdkSessionInfo.Parse(region)!.TrackName);
    }

    [Fact]
    public void KeepsNonAsciiDriverAndCarNamesIntact()
    {
        var payload = RealisticPayload.Replace("CarScreenName: Porsche 911 GT3 R", "CarScreenName: Citroën C3 WRC");

        Assert.Equal("Citroën C3 WRC", IrsdkSessionInfo.Parse(Encoding.UTF8.GetBytes(payload))!.CarName);
    }

    [Fact]
    public void TruncatesANameLongerThanTheBackendAccepts()
    {
        var payload = RealisticPayload.Replace("Circuit de Spa-Francorchamps", new string('x', 400));

        Assert.Equal(120, IrsdkSessionInfo.Parse(payload)!.TrackName.Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not yaml at all")]
    [InlineData("WeekendInfo:\n TrackDisplayName: Spa\n")]                       // no driver information
    [InlineData("DriverInfo:\n DriverCarIdx: 0\n Drivers:\n - CarIdx: 0\n   CarScreenName: Skip Barber\n")] // no track
    public void SaysItDoesNotKnowTheComboRatherThanGuessing(string payload)
    {
        Assert.Null(IrsdkSessionInfo.Parse(payload));
    }

    [Fact]
    public void SaysItDoesNotKnowTheComboWhenThePlayersEntryIsMissingFromTheDriverList()
    {
        var payload = RealisticPayload.Replace(" DriverCarIdx: 1", " DriverCarIdx: 7");

        Assert.Null(IrsdkSessionInfo.Parse(payload));
    }

    [Fact]
    public void SurvivesATruncatedPayloadWithoutFailing()
    {
        for (var length = 0; length < RealisticPayload.Length; length += 7)
            IrsdkSessionInfo.Parse(RealisticPayload[..length]);
    }

    [Fact]
    public void ChangingTheCarOrTheTrackChangesTheComboKey()
    {
        var spa = IrsdkSessionInfo.Parse(RealisticPayload)!;
        var otherCar = IrsdkSessionInfo.Parse(RealisticPayload.Replace("Porsche 911 GT3 R", "Ferrari 296 GT3"))!;
        var otherConfig = IrsdkSessionInfo.Parse(RealisticPayload.Replace("Grand Prix Pits", "Endurance"))!;

        Assert.NotEqual(spa.ComboKey, otherCar.ComboKey);
        Assert.NotEqual(spa.ComboKey, otherConfig.ComboKey);
    }
}
