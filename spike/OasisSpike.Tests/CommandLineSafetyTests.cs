using OasisSpike;

namespace OasisSpike.Tests;

public sealed class CommandLineSafetyTests
{
    [Fact]
    public void NoArgumentsDoesNotSelectARecordingMode()
    {
        Assert.Equal((int)RecorderExitCode.InvalidArguments, ProgramEntry.Run([]));
    }

    [Fact]
    public void SafetyLimitsAreFixedForEachMode()
    {
        Assert.Equal(TimeSpan.FromMinutes(10), SafetyLimits.For(RecorderMode.Canary).MaxDuration);
        Assert.Equal(25L * 1024 * 1024, SafetyLimits.For(RecorderMode.Canary).MaxOutputBytes);
        Assert.Equal(TimeSpan.FromMinutes(120), SafetyLimits.For(RecorderMode.Full).MaxDuration);
        Assert.Equal(100L * 1024 * 1024, SafetyLimits.For(RecorderMode.Full).MaxOutputBytes);
    }

    [Theory]
    [InlineData("CANARY", RecorderMode.Canary)]
    [InlineData("full", RecorderMode.Full)]
    public void OnlyNamedModesParse(string value, RecorderMode expected)
    {
        Assert.True(RecorderModeExtensions.TryParse(value, out var actual));
        Assert.Equal(expected, actual);
        Assert.False(RecorderModeExtensions.TryParse("unsafe", out _));
    }

    [Fact]
    public async Task DuplicateInstanceCannotAcquireTheSameMutex()
    {
        var name = $"OasisRaceControl.OasisSpike.Tests.{Guid.NewGuid():N}";
        using var first = SingleInstanceGuard.TryAcquire(name);
        var secondWasBlocked = await Task.Run(() =>
        {
            using var second = SingleInstanceGuard.TryAcquire(name);
            return second is null;
        });
        Assert.NotNull(first);
        Assert.True(secondWasBlocked);
    }
}
