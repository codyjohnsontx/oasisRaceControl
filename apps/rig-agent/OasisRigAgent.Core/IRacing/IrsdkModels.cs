namespace OasisRigAgent.Core.IRacing;

/// <summary>Scalar types the iRacing shared-memory telemetry header can declare.</summary>
public enum IrsdkVariableType
{
    Char = 0,
    Bool = 1,
    Int = 2,
    BitField = 3,
    Float = 4,
    Double = 5,
}

/// <summary>One telemetry channel as declared by the sim's variable header.</summary>
public sealed record IrsdkVariable(
    IrsdkVariableType Type,
    int Offset,
    int Count,
    bool CountAsTime,
    string Name,
    string Description,
    string Unit);

/// <summary>One decoded frame: the watched channel values plus the session-metadata payload.</summary>
public sealed record IrsdkFrame(
    bool IsConnected,
    int TickCount,
    int TickRate,
    int SessionInfoUpdate,
    IReadOnlyDictionary<string, IrsdkVariable> Variables,
    IReadOnlyDictionary<string, object?> Values,
    byte[]? SessionInfoBytes);

/// <summary>
/// Read-only window onto the sim's shared memory. The agent never holds a
/// writable handle: the only production implementation opens the mapping with
/// read rights, and tests substitute a byte array.
/// </summary>
public interface IReadOnlyMemoryReader
{
    long Capacity { get; }
    void Read(long offset, Span<byte> destination);
}

/// <summary>
/// The shared memory did not describe itself safely. Always a stop-and-inspect
/// result, never something to parse around: the producer is another process we
/// do not control and the bytes can change while we read them.
/// </summary>
public class MalformedTelemetryException : Exception
{
    public MalformedTelemetryException(string message) : base(message) { }
    public MalformedTelemetryException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>
/// The simulator publishes its telemetry in a layout version this agent was not
/// written to read.
///
/// A distinct type because it is the one decode failure that is certain rather than
/// possible, arrives on every rig at once, and is fixed by updating the agent rather
/// than by looking at the machine. iRacing stamps the layout version in the first
/// four bytes of its header and has published version
/// <see cref="IrsdkMemoryParser.SupportedLayoutVersion"/> for years; a build that
/// changes it moves every field this parser reads. Every other check in the parser
/// would then be reporting a nonsense reason for a real cause it never looked for.
/// </summary>
public sealed class UnsupportedTelemetryFormatException : MalformedTelemetryException
{
    public UnsupportedTelemetryFormatException(int publishedVersion, int supportedVersion)
        : base($"iRacing published telemetry layout version {publishedVersion}; "
            + $"this agent reads version {supportedVersion}.")
    {
        PublishedVersion = publishedVersion;
        SupportedVersion = supportedVersion;
    }

    /// <summary>The version the simulator on this rig stamped on its telemetry.</summary>
    public int PublishedVersion { get; }

    /// <summary>The version this agent's parser was written against.</summary>
    public int SupportedVersion { get; }
}
