using System.Text;
using System.Text.Json;

namespace OasisSpike;

public sealed class LogLimitException : IOException
{
    public LogLimitException(string message) : base(message) { }
}

public sealed class LogBudget : IDisposable
{
    public const int MaximumSessionInfoFiles = 256;
    private static readonly HashSet<string> AppendOnlyFiles = new(StringComparer.Ordinal)
    {
        "events.jsonl", "telemetry.jsonl"
    };
    private static readonly HashSet<string> SingletonFiles = new(StringComparer.Ordinal)
    {
        "run-manifest.json", "telemetry-vars.txt"
    };

    private readonly string _runDirectory;
    private readonly long _maximumBytes;
    private readonly object _lock = new();
    private long _bytesWritten;
    private bool _disposed;

    public long BytesWritten => Interlocked.Read(ref _bytesWritten);

    public LogBudget(string runDirectory, long maximumBytes)
    {
        _runDirectory = Path.GetFullPath(runDirectory);
        _maximumBytes = maximumBytes > 0 ? maximumBytes : throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        Directory.CreateDirectory(_runDirectory);
    }

    public void WriteJsonLine(string fileName, object value)
    {
        if (!AppendOnlyFiles.Contains(fileName)) throw new IOException("The requested append-only filename is not approved.");
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + Environment.NewLine);
        lock (_lock)
        {
            ThrowIfDisposed();
            Reserve(bytes.Length);
            using var stream = OpenApproved(fileName, FileMode.Append);
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }
    }

    public void WriteTextFile(string fileName, string value) => WriteFile(fileName, Encoding.UTF8.GetBytes(value));

    public void WriteFile(string fileName, ReadOnlySpan<byte> value)
    {
        if (!IsApprovedSingleton(fileName)) throw new IOException("The requested output filename is not approved.");
        lock (_lock)
        {
            ThrowIfDisposed();
            Reserve(value.Length);
            using var stream = OpenApproved(fileName, FileMode.CreateNew);
            stream.Write(value);
            stream.Flush(flushToDisk: true);
        }
    }

    public void WriteManifest(object value)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine);
        lock (_lock)
        {
            ThrowIfDisposed();
            var path = ApprovedPath("run-manifest.json");
            var previousLength = File.Exists(path) ? new FileInfo(path).Length : 0;
            var manifestDelta = (long)bytes.Length - previousLength;
            if (manifestDelta > 0 && checked(_bytesWritten + manifestDelta) > _maximumBytes)
                throw new LogLimitException($"The {_maximumBytes / 1024 / 1024} MiB output limit was reached.");

            var temporaryPath = Path.Combine(_runDirectory, $"run-manifest-{Guid.NewGuid():N}.tmp");
            try
            {
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(bytes);
                    stream.Flush(flushToDisk: true);
                }

                if (File.Exists(path)) File.Replace(temporaryPath, path, null);
                else File.Move(temporaryPath, path);
                _bytesWritten = checked(_bytesWritten + manifestDelta);
            }
            finally
            {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
        }
    }

    public void Dispose()
    {
        lock (_lock) _disposed = true;
    }

    private bool IsApprovedSingleton(string fileName)
    {
        if (SingletonFiles.Contains(fileName)) return true;
        if (!fileName.StartsWith("sessioninfo-", StringComparison.Ordinal) || !fileName.EndsWith(".yaml", StringComparison.Ordinal)) return false;
        var digits = fileName[12..^5];
        return digits.Length == 3 && int.TryParse(digits, out var number) && number is >= 1 and <= MaximumSessionInfoFiles;
    }

    private FileStream OpenApproved(string fileName, FileMode mode) =>
        new(ApprovedPath(fileName), mode, FileAccess.Write, FileShare.Read);

    private string ApprovedPath(string fileName)
    {
        if (Path.GetFileName(fileName) != fileName) throw new IOException("Output filenames cannot contain a path.");
        var path = Path.GetFullPath(Path.Combine(_runDirectory, fileName));
        RunDirectory.EnsureChildOf(_runDirectory, path);
        return path;
    }

    private void Reserve(long bytes)
    {
        if (bytes < 0 || checked(_bytesWritten + bytes) > _maximumBytes)
            throw new LogLimitException($"The {_maximumBytes / 1024 / 1024} MiB output limit was reached.");
        _bytesWritten += bytes;
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LogBudget));
    }
}
