import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * How the simulator behaves when it is stopped, which is what decides whether
 * scripts/soak.ts can be believed. A worker killed between the backend storing
 * a lap and its outcome line being written would leave the soak holding a lap
 * no rig recorded sending - a stray, the shape of the one defect the venue
 * actually fears, manufactured by the harness. Two answers to that, one test
 * each: a stop drains the request in flight, and a kill it cannot survive still
 * leaves the lap NAMED, so the soak can report it as one it cannot account for.
 * The metrics JSONL is the contract between this script and the soak's reader,
 * so both assertions are on the lines that land in it.
 *
 * Nothing here counts scheduled laps: how many the interval fires before the
 * signal arrives is wall-clock luck on a loaded machine. What is asserted are
 * properties of the shutdown path and of nothing else.
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

type Stub = {
  port: number;
  /** Every lap event id the backend has taken delivery of, in arrival order. */
  lapsReceived: string[];
  /** The first of them, resolved while its response is still being held. */
  firstLap: Promise<string>;
};

/**
 * A stand-in backend that answers the assignment poll and heartbeats at once
 * but holds every lap post open - for `lapDelayMs`, or forever with "never" -
 * so the stop signal below always lands while a request is genuinely in flight
 * rather than by luck of timing.
 */
function stubBackend(lapDelayMs: number | "never"): Promise<Stub> {
  const assignmentId = "11111111-2222-3333-4444-555555555555";
  const lapsReceived: string[] = [];
  let announce: (id: string) => void = () => {};
  const firstLap = new Promise<string>((resolve) => (announce = resolve));

  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/agent/assignment")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ assignment: { id: assignmentId } }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const { events } = JSON.parse(raw) as {
        events: Array<{ type: string; eventId?: string }>;
      };
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
      for (const lap of laps) {
        lapsReceived.push(lap.eventId!);
        announce(lap.eventId!);
      }
      if (lapDelayMs !== "never") setTimeout(answer, lapDelayMs);
    });
  });

  return new Promise((listening) => {
    server!.listen(0, "127.0.0.1", () => {
      listening({
        port: (server!.address() as { port: number }).port,
        lapsReceived,
        firstLap,
      });
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
    const stub = await stubBackend(300);

    child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        SCRIPT,
        "--base", `http://127.0.0.1:${stub.port}`,
        "--interval", "1",
        "--metrics", metrics,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const exited = new Promise<void>((done) => child!.once("exit", () => done()));

    // Signalled while this lap's response is still held open, so its line
    // cannot already have been written when the signal is delivered.
    const inFlight = await stub.firstLap;
    child.kill("SIGINT");
    await exited;

    const lapPosts = metricLines(metrics).filter((line) => line.kind === "lap");
    const recorded = lapPosts.flatMap((line) => line.sent as string[]);

    expect(recorded).toContain(inFlight);
    expect(recorded).toEqual(expect.arrayContaining(stub.lapsReceived));

    const inFlightLine = lapPosts.find((line) =>
      (line.sent as string[]).includes(inFlight),
    )!;
    expect(inFlightLine.results).toHaveLength(1);
    expect(inFlightLine.status).toBe(200);
  }, 30_000);

  it("names the lap it was sending even when it is killed outright", async () => {
    workDir = mkdtempSync(join(tmpdir(), "fake-rig-killed-"));
    const metrics = join(workDir, "rig.jsonl");
    // Never answered: SIGKILL then lands with the request unanswerable, which
    // is what the drain deadline and the soak's SIGKILL escalation both reach.
    const stub = await stubBackend("never");

    child = spawn(
      process.execPath,
      [
        "--import", "tsx",
        SCRIPT,
        "--base", `http://127.0.0.1:${stub.port}`,
        "--interval", "1",
        "--metrics", metrics,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const exited = new Promise<void>((done) => child!.once("exit", () => done()));

    const abandoned = await stub.firstLap;
    child.kill("SIGKILL");
    await exited;

    const lines = metricLines(metrics);
    const announced = lines
      .filter((line) => line.kind === "attempt")
      .flatMap((line) => line.sent as string[]);
    const outcomes = lines
      .filter((line) => line.kind === "lap")
      .flatMap((line) => line.sent as string[]);

    // Announced but never answered for: the soak reads exactly this difference
    // and reports the lap as indeterminate instead of as a stray.
    expect(announced).toContain(abandoned);
    expect(outcomes).not.toContain(abandoned);
  }, 30_000);
});
