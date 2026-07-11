using OasisSpike;

// Oasis Race Control — Phase 1 spike telemetry recorder.
// Run this on a venue rig, drive the scenarios in docs/spike-checklist.md,
// then copy the spike-logs/ folder back for analysis.

var runDir = Path.Combine(AppContext.BaseDirectory, "spike-logs", DateTime.Now.ToString("yyyyMMdd-HHmmss"));
Directory.CreateDirectory(runDir);

Console.WriteLine("Oasis Race Control — spike telemetry recorder");
Console.WriteLine($"Logging to: {runDir}");
Console.WriteLine("Waiting for iRacing... press M + Enter to drop a marker note, Ctrl+C or Q + Enter to quit.");
Console.WriteLine();

var recorder = new Recorder(runDir);
recorder.Start();

Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    recorder.Stop();
};

// Marker notes let the on-site driver stamp "starting scenario 4 now" into the event log
// so wall-clock notes line up with telemetry during offline analysis.
while (!recorder.Stopped)
{
    var line = Console.ReadLine();
    if (line is null) { recorder.WaitForStop(); break; }
    if (line.Trim().Equals("q", StringComparison.OrdinalIgnoreCase))
    {
        recorder.Stop();
        break;
    }
    if (line.Trim().Equals("m", StringComparison.OrdinalIgnoreCase))
    {
        Console.Write("marker note> ");
        var note = Console.ReadLine() ?? "";
        recorder.Marker(note);
    }
}

recorder.WaitForStop();
Console.WriteLine("Recorder stopped. Logs are in: " + runDir);
