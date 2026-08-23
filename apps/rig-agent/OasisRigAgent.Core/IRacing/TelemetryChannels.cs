using System.Text;

namespace OasisRigAgent.Core.IRacing;

/// <summary>What the agent loses when the sim does not publish a channel it reads.</summary>
public enum ChannelRole
{
    /// <summary>Without it no lap can be built at all: the rig scores nothing.</summary>
    LapTiming,

    /// <summary>Without it an invalid lap cannot be told from a clean one. Every rule
    /// that keeps junk off the leaderboard - the pits, the garage, a tow, a replay, the
    /// incident count - is a condition that has to be *seen*, so a channel that is not
    /// there reads exactly like a lap where it never happened. The venue's rule is clean
    /// laps only, so a missing one of these is not a degraded score; it is a wrong one.</summary>
    LapValidity,

    /// <summary>Without it laps are still honest, just described less precisely.</summary>
    Degrades,
}

/// <summary>One channel the agent reads, and what it is for.</summary>
public sealed record TelemetryChannel(string Name, IrsdkVariableType Type, ChannelRole Role, string Purpose)
{
    /// <summary>Whether a lap may be published when this channel is not usable.</summary>
    public bool Required => Role != ChannelRole.Degrades;
}

/// <summary>How one declared channel turned out in the sim actually running.</summary>
public enum ChannelStatus
{
    Present,

    /// <summary>The sim publishes no channel by this name. A different iRacing build,
    /// or a name the agent got wrong.</summary>
    Missing,

    /// <summary>Published, but as a type the agent does not read it as - which decodes
    /// to nothing rather than to a wrong value, so it behaves exactly like missing.</summary>
    WrongType,
}

/// <summary>One channel's verdict, with what the sim actually published.</summary>
public sealed record TelemetryChannelResult(TelemetryChannel Channel, ChannelStatus Status, IrsdkVariableType? Published)
{
    public bool Usable => Status == ChannelStatus.Present;

    /// <summary>One line for a person reading a wall of them. A channel this rig still
    /// scores without says so on its own line, because otherwise a PASS listing a
    /// missing channel sends somebody looking for a problem that is not there.</summary>
    public string Describe()
    {
        if (Status == ChannelStatus.Present) return $"{Channel.Name}: ok ({Channel.Type})";

        var what = Status == ChannelStatus.Missing
            ? "NOT PUBLISHED by this sim"
            : $"published as {Published}, which the agent cannot read as {Channel.Type}";
        var weight = Channel.Required ? "STOPS THIS RIG SCORING" : "this rig still scores";
        return $"{Channel.Name}: {what} [{weight}] - {Channel.Purpose}";
    }
}

/// <summary>
/// The result of checking one running simulator against the contract.
/// </summary>
public sealed record TelemetryChannelReport
{
    public required IReadOnlyList<TelemetryChannelResult> Results { get; init; }

    /// <summary>Channels a lap cannot honestly be published without, that this sim does
    /// not usably publish.</summary>
    public IReadOnlyList<TelemetryChannelResult> Blocking =>
        Results.Where(r => !r.Usable && r.Channel.Required).ToList();

    /// <summary>Channels whose absence costs precision but not honesty.</summary>
    public IReadOnlyList<TelemetryChannelResult> Degraded =>
        Results.Where(r => !r.Usable && !r.Channel.Required).ToList();

    /// <summary>True when every channel a lap's validity turns on is readable, which is
    /// the condition for this rig scoring at all.</summary>
    public bool CanScore => Blocking.Count == 0;

    /// <summary>One line for the rig's status display and the staff dashboard, or null
    /// when there is nothing wrong. Deliberately names the channels: this is the
    /// difference between "why is rig 7 not scoring" taking a minute and taking a night.</summary>
    public string? BlockingSummary => CanScore
        ? null
        : $"the simulator does not publish {string.Join(", ", Blocking.Select(r => r.Channel.Name))}";

    /// <summary>The whole verdict, for the log and for <c>--check-sim</c>.</summary>
    public string Describe()
    {
        var text = new StringBuilder();
        text.AppendLine(CanScore
            ? "Simulator telemetry check: PASS - every channel a lap's validity turns on is readable."
            : $"Simulator telemetry check: FAIL - {BlockingSummary}. This rig will not score.");
        foreach (var result in Results) text.AppendLine($"  {result.Describe()}");
        return text.ToString().TrimEnd();
    }
}

/// <summary>
/// The contract between the agent and the simulator: every telemetry channel the
/// lap rules read, the type they read it as, and what is lost without it.
///
/// This exists because the agent addresses the sim's channels <i>by name</i>, and a
/// name that is not there does not fail - it decodes to null, and every rule that
/// reads it quietly stands down. That is the shape of the worst failure this fleet
/// has: with <c>LapCompleted</c> absent the rig heartbeats all night, shows the sim
/// running, and scores nothing, reporting no error because nothing went wrong from
/// its own point of view. With <c>OnPitRoad</c> absent it is worse - it scores an
/// in-lap through the pits as a real time on the public leaderboard.
///
/// Neither is hypothetical across twenty-plus machines: iRacing updates every season,
/// these names have never been confirmed against a live install
/// (<c>docs/spike-findings.md</c>), and a rig is a machine nobody watches. So the
/// agent checks what the sim actually publishes against this list on every attach and
/// says so, rather than finding out from a leaderboard that looks wrong.
/// </summary>
public static class TelemetryChannels
{
    public static readonly IReadOnlyList<TelemetryChannel> All =
    [
        new("LapCompleted", IrsdkVariableType.Int, ChannelRole.LapTiming,
            "the lap counter every lap boundary is detected from"),
        new("LapLastLapTime", IrsdkVariableType.Float, ChannelRole.LapTiming,
            "the lap time itself"),

        new("OnPitRoad", IrsdkVariableType.Bool, ChannelRole.LapValidity,
            "drops out laps and in laps; without it a lap through the pits scores as a real time"),
        new("IsInGarage", IrsdkVariableType.Bool, ChannelRole.LapValidity,
            "drops laps the driver spent in the garage"),
        new("IsOnTrack", IrsdkVariableType.Bool, ChannelRole.LapValidity,
            "drops laps the driver was not in the car for"),
        new("IsReplayPlaying", IrsdkVariableType.Bool, ChannelRole.LapValidity,
            "stops the sim replaying old telemetry into the leaderboard"),
        new("PlayerTrackSurface", IrsdkVariableType.Int, ChannelRole.LapValidity,
            "drops laps interrupted by a tow or a reset to pits"),
        new("PlayerCarMyIncidentCount", IrsdkVariableType.Int, ChannelRole.LapValidity,
            "charges incidents to the lap; without it every lap scores as clean"),

        new("Lap", IrsdkVariableType.Int, ChannelRole.Degrades,
            "second signal for a session rewind, also covered by PlayerTrackSurface"),
        new("SessionNum", IrsdkVariableType.Int, ChannelRole.Degrades,
            "separates practice from qualifying in the lap's identity"),
        new("SessionUniqueID", IrsdkVariableType.Int, ChannelRole.Degrades,
            "names the sim session in the lap's id; the agent falls back to its own"),
    ];

    /// <summary>The names to read out of each frame. One owner, so a channel cannot be
    /// read without being declared here - or declared here and never checked.</summary>
    public static readonly IReadOnlySet<string> Names =
        new HashSet<string>(All.Select(c => c.Name), StringComparer.Ordinal);

    /// <summary>
    /// Checks one running simulator's published variable header against the contract.
    /// </summary>
    /// <param name="published">The channels this sim declares, from a decoded frame.</param>
    public static TelemetryChannelReport Check(IReadOnlyDictionary<string, IrsdkVariable> published)
    {
        var results = new List<TelemetryChannelResult>(All.Count);
        foreach (var channel in All)
        {
            if (!published.TryGetValue(channel.Name, out var variable))
            {
                results.Add(new TelemetryChannelResult(channel, ChannelStatus.Missing, null));
                continue;
            }

            results.Add(variable.Type == channel.Type
                ? new TelemetryChannelResult(channel, ChannelStatus.Present, variable.Type)
                : new TelemetryChannelResult(channel, ChannelStatus.WrongType, variable.Type));
        }

        return new TelemetryChannelReport { Results = results };
    }
}
