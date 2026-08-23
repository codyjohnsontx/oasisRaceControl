using System.Globalization;

namespace OasisRigAgent.Core;

/// <summary>
/// Where the agent says what happened.
///
/// On a rig the agent runs unattended, often with no window anybody looks at, so
/// anything written only to a console is written to nobody. With twenty-plus
/// machines the first question about a rig that stopped scoring laps is always
/// "what did it say at the time", and the answer has to still be on that machine
/// hours later.
/// </summary>
public interface IAgentLog
{
    void Write(string level, string message);

    void Info(string message) => Write("info", message);
    void Warn(string message) => Write("warn", message);
    void Error(string message) => Write("error", message);
}

/// <summary>Discards everything. The default for components that take a log so
/// tests and embedders need not supply one.</summary>
public sealed class NullLog : IAgentLog
{
    public static readonly NullLog Instance = new();
    public void Write(string level, string message) { }
}

/// <summary>Writes to the console the operator is looking at, if any. Warnings
/// and errors go to stderr so a redirected start-up keeps them separate.</summary>
public sealed class ConsoleLog : IAgentLog
{
    public void Write(string level, string message)
    {
        var writer = level is "warn" or "error" ? Console.Error : Console.Out;
        writer.WriteLine(message);
    }
}

/// <summary>Fans out to several logs. A sink that fails - a full disk, a folder
/// that lost its permissions - must not take down the agent or silence the
/// others, so each is called on its own.</summary>
public sealed class CompositeLog : IAgentLog, IDisposable
{
    private readonly IReadOnlyList<IAgentLog> _logs;

    public CompositeLog(params IAgentLog[] logs) => _logs = logs;

    public void Write(string level, string message)
    {
        foreach (var log in _logs)
        {
            try { log.Write(level, message); }
            catch { /* a log that cannot write is not worth an outage */ }
        }
    }

    public void Dispose()
    {
        foreach (var log in _logs)
        {
            if (log is IDisposable disposable)
            {
                try { disposable.Dispose(); } catch { }
            }
        }
    }
}

/// <summary>
/// An append-only log file with a bounded footprint.
///
/// A rig runs ten hours a day and is never tidied up by hand, so the log is
/// capped by size and by how many old files are kept - a fleet cannot afford a
/// machine whose disk fills up because nobody visited it. Every line is flushed
/// as it is written, because the interesting case is the agent that was killed
/// or lost power, and a line still sitting in a buffer is a line that was never
/// written.
/// </summary>
public sealed class RotatingFileLog : IAgentLog, IDisposable
{
    private const string ActiveFileName = "agent.log";

    private readonly object _lock = new();
    private readonly string _directory;
    private readonly long _maxBytes;
    private readonly int _keepFiles;
    private StreamWriter? _writer;
    private int _rotation;

    public RotatingFileLog(string directory, long maxBytes = 2 * 1024 * 1024, int keepFiles = 5)
    {
        if (maxBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        if (keepFiles < 0) throw new ArgumentOutOfRangeException(nameof(keepFiles));
        _directory = directory;
        _maxBytes = maxBytes;
        _keepFiles = keepFiles;
        Directory.CreateDirectory(directory);
        ActivePath = Path.Combine(directory, ActiveFileName);
        _writer = Open();
    }

    public string ActivePath { get; }

    public void Write(string level, string message)
    {
        var line = string.Create(CultureInfo.InvariantCulture,
            $"{DateTimeOffset.UtcNow:yyyy-MM-dd'T'HH:mm:ss.fff'Z'}  {level,-5}  {message}");

        lock (_lock)
        {
            if (_writer is null) return;
            _writer.WriteLine(line);
            _writer.Flush();
            if (_writer.BaseStream.Length >= _maxBytes) Rotate();
        }
    }

    /// <summary>Retire the active file under a timestamped name and prune the
    /// oldest so the folder stays bounded.</summary>
    private void Rotate()
    {
        try
        {
            _writer?.Dispose();
            _writer = null;

            // Timestamp plus a sequence: a burst can rotate twice inside one
            // millisecond, and two archives with the same name means the older
            // one is silently overwritten. The pair also sorts oldest-first as
            // plain text, which is what the prune below relies on.
            var archive = Path.Combine(
                _directory,
                string.Create(CultureInfo.InvariantCulture,
                    $"agent-{DateTimeOffset.UtcNow:yyyyMMdd'T'HHmmssfff}-{unchecked(_rotation++) & 0xFFF:D4}.log"));
            File.Move(ActivePath, archive, overwrite: true);

            var stale = Directory.GetFiles(_directory, "agent-*.log")
                .OrderByDescending(f => f, StringComparer.Ordinal)
                .Skip(_keepFiles);
            foreach (var file in stale)
            {
                try { File.Delete(file); } catch (IOException) { }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Keep logging into whatever we can still open rather than losing
            // the log entirely because a rotation failed.
        }
        finally
        {
            try { _writer = Open(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    private StreamWriter Open()
    {
        var stream = new FileStream(ActivePath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        return new StreamWriter(stream) { AutoFlush = false };
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _writer?.Dispose();
            _writer = null;
        }
    }
}
