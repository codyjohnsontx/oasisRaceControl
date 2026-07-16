namespace OasisSpike;

public enum IrracingVariableType
{
    Char = 0,
    Bool = 1,
    Int = 2,
    BitField = 3,
    Float = 4,
    Double = 5
}

public sealed record TelemetryVariable(
    IrracingVariableType Type,
    int Offset,
    int Count,
    bool CountAsTime,
    string Name,
    string Description,
    string Unit);

public sealed record TelemetrySnapshot(
    int TickCount,
    int TickRate,
    int SessionInfoUpdate,
    IReadOnlyDictionary<string, TelemetryVariable> Variables,
    IReadOnlyDictionary<string, object?> Values);

public sealed record SessionInfoSnapshot(int UpdateNumber, byte[] RawBytes);

public interface IIrracingTelemetrySource : IDisposable
{
    event Action? Connected;
    event Action? Disconnected;
    event Action<TelemetrySnapshot>? Telemetry;
    event Action<SessionInfoSnapshot>? SessionInfo;
    event Action<Exception>? Faulted;

    void Start();
    void Stop();
}

public sealed class MalformedTelemetryException : Exception
{
    public MalformedTelemetryException(string message) : base(message) { }
    public MalformedTelemetryException(string message, Exception innerException) : base(message, innerException) { }
}
