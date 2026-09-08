import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The simulator's shutdown drain. A worker killed between the backend storing
 * a lap and the metrics line being written leaves scripts/soak.ts holding a lap
 * no rig recorded sending - a stray, which is the shape of the one defect the
 * venue actually fears, manufactured by the harness. The metrics JSONL is the
 * contract between this script and the soak's reader, so the assertion is on
 * the line that lands in it.
 */

const SCRIPT = fileURLToPath(new URL("./fake-rig.ts", import.meta.url));

let child: ChildProcess | undefined;
let server: Server | undefined;
let workDir: string | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  server?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  child = undefined;
  server = undefined;
  workDir = undefined;
});

/**
 * A stand-in backend that answers the assignment poll and heartbeats at once
 * but holds the lap post open, so the stop signal below lands while the request
 * is genuinely in flight rather than by luck of timing.
 */
function stubBackend(onLapReceived: () => void, lapDelayMs: number): Promise<number> {
  const assignmentId = "11111111-2222-3333-4444-555555555555";
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/agent/assignment")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ assignment: { id: assignmentId } }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const events = (JSON.parse(raw) as { events: Array<{ type: string; eventId?: string }> })
        .events;
      const laps = events.filter((e) => e.type === "LAP_COMPLETED");
      const answer = (): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            results: laps.map((lap) => ({ eventId: lap.eventId, status: "accepted" })),
          }),
        );
      };
      if (laps.length === 0) return answer();
      onLapReceived();
      setTimeout(answer, lapDelayMs);
    });
  });
  return new Promise((done) => {
    server!.listen(0, "127.0.0.1", () => {
      done((server!.address() as { port: number }).port);
    });
  });
}

function metricLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("fake-rig shutdown", () => {
  it("records the lap post it was mid-way through when it is told to stop", async () => {
    workDir = mkdtempSync(join(tmpdir(), "fake-rig-drain-"));
    const metrics = join(workDir, "rig.jsonl");

    let lapSeen: () => void = () => {};
    const lapReceived = new Promise<void>((seen) => (lapSeen = seen));
    const port = await stubBackend(() => lapSeen(), 300);

    child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        SCRIPT,
        "--base", `http://127.0.0.1:${port}`,
        "--interval", "1",
        "--metrics", metrics,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const exited = new Promise<void>((done) => child!.once("exit", () => done()));

    await lapReceived;
    child.kill("SIGINT");
    await exited;

    const lapPosts = metricLines(metrics).filter((line) => line.kind === "lap");
    expect(lapPosts).toHaveLength(1);
    expect(lapPosts[0]!.sent).toHaveLength(1);
    expect(lapPosts[0]!.results).toHaveLength(1);
  }, 30_000);
});
