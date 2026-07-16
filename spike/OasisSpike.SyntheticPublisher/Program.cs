using System.Buffers.Binary;
using System.IO.MemoryMappedFiles;
using System.Text;
using OasisSpike;

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("The synthetic named-map publisher runs only on Windows.");
    return 3;
}

var corrupt = args.SequenceEqual(["--scenario", "corrupt"]);
if (args.Length != 0 && !corrupt)
{
    Console.Error.WriteLine("Usage: OasisSpike.SyntheticPublisher.exe [--scenario corrupt]");
    return 2;
}

const int capacity = 64 * 1024;
using var map = MemoryMappedFile.CreateOrOpen("Local\\IRSDKMemMapFileName", capacity, MemoryMappedFileAccess.ReadWrite);
using var view = map.CreateViewAccessor(0, capacity, MemoryMappedFileAccess.ReadWrite);
using var dataEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\IRSDKDataValidEvent");

var image = SyntheticImage.Build(corrupt);
view.WriteArray(0, image, 0, image.Length);
view.Flush();
Console.WriteLine(corrupt ? "Publishing deliberately malformed frames." : "Publishing valid synthetic iRacing frames. Press Q + Enter to stop.");

var tick = 0;
using var stop = new ManualResetEventSlim(false);
var input = new Thread(() =>
{
    while (Console.ReadLine() is { } line)
    {
        if (line.Trim().Equals("q", StringComparison.OrdinalIgnoreCase))
        {
            stop.Set();
            return;
        }
    }
})
{ IsBackground = true };
input.Start();

while (!stop.IsSet)
{
    if (!corrupt)
    {
        view.Write(48, ++tick);
        view.Write(SyntheticImage.BufferOffset + SyntheticImage.SessionTickOffset, tick);
        view.Write(SyntheticImage.BufferOffset + SyntheticImage.SessionTimeOffset, tick / 10d);
        view.Flush();
    }
    dataEvent.Set();
    Thread.Sleep(100);
}

return 0;

internal static class SyntheticImage
{
    internal const int VariableHeaderOffset = 1024;
    internal const int SessionInfoOffset = 4096;
    internal const int BufferOffset = 8192;
    internal const int BufferLength = 4096;
    internal const int SessionTickOffset = 0;
    internal const int SessionTimeOffset = 8;
    private const int Capacity = 64 * 1024;

    internal static byte[] Build(bool corrupt)
    {
        var bytes = new byte[Capacity];
        WriteInt(bytes, 0, 2);
        WriteInt(bytes, 4, 1);
        WriteInt(bytes, 8, 60);
        WriteInt(bytes, 12, 1);
        var yaml = Encoding.UTF8.GetBytes("WeekendInfo:\n  TrackName: synthetic\n  TrackConfigName: test\n");
        yaml.CopyTo(bytes.AsSpan(SessionInfoOffset));
        WriteInt(bytes, 16, yaml.Length);
        WriteInt(bytes, 20, SessionInfoOffset);
        WriteInt(bytes, 24, corrupt ? 5000 : 8);
        WriteInt(bytes, 28, VariableHeaderOffset);
        WriteInt(bytes, 32, 1);
        WriteInt(bytes, 36, BufferLength);
        WriteInt(bytes, 48, 1);
        WriteInt(bytes, 52, BufferOffset);

        if (!corrupt)
        {
            AddVariable(bytes, 0, "SessionTick", IrracingVariableType.Int, SessionTickOffset);
            AddVariable(bytes, 1, "SessionTime", IrracingVariableType.Double, SessionTimeOffset);
            AddVariable(bytes, 2, "Lap", IrracingVariableType.Int, 16);
            AddVariable(bytes, 3, "LapCompleted", IrracingVariableType.Int, 20);
            AddVariable(bytes, 4, "PlayerCarMyIncidentCount", IrracingVariableType.Int, 24);
            AddVariable(bytes, 5, "LapLastLapTime", IrracingVariableType.Float, 28);
            AddVariable(bytes, 6, "PlayerTrackSurface", IrracingVariableType.Int, 32);
            AddVariable(bytes, 7, "IsOnTrack", IrracingVariableType.Bool, 36);
            WriteInt(bytes, BufferOffset + 32, 3);
            bytes[BufferOffset + 36] = 1;
        }
        return bytes;
    }

    private static void AddVariable(byte[] bytes, int index, string name, IrracingVariableType type, int valueOffset)
    {
        var offset = VariableHeaderOffset + index * IrracingMemoryParser.VariableHeaderSize;
        WriteInt(bytes, offset, (int)type);
        WriteInt(bytes, offset + 4, valueOffset);
        WriteInt(bytes, offset + 8, 1);
        Encoding.Latin1.GetBytes(name).CopyTo(bytes.AsSpan(offset + 16, 32));
    }

    private static void WriteInt(byte[] bytes, int offset, int value) =>
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(offset, 4), value);
}
