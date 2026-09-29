import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RigTile } from "@/lib/monitor/rig-health";
import type { RigHealthAlert } from "./staff-rig-health";

/**
 * The Rig health page as served. The colours themselves are decided in
 * lib/monitor/rig-health.ts from the rules (its tests); here what must hold is
 * that each tile carries the colour it was given, an old agent is badged, and
 * an alert shows whether it is still open and links its GitHub issue.
 *
 * `next/navigation` is stubbed: the server render here has no app router, and
 * the page only uses it to refresh.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const { StaffRigHealth } = await import("./staff-rig-health");

function tile(n: number, overrides: Partial<RigTile>): RigTile {
  return {
    id: `rig-${n}`,
    label: `R0${n}`,
    colour: "green",
    status: "online",
    problems: [],
    driver: null,
    iracing: "iRacing idle",
    lastLap: "no laps today",
    queue: "queue 0 · parked 0",
    agent: "agent 0.4-monitor",
    footprint: null,
    clockSkew: null,
    heartbeat: "heartbeat 12 s ago",
    oldAgent: false,
    ...overrides,
  };
}

const ALERTS: RigHealthAlert[] = [
  {
    id: "2",
    severity: "urgent",
    rule: "Rule 15",
    where: "Rig 03",
    headline: "Rig 03: lap reading stopped",
    opened: "3:40 PM",
    recovered: null,
    githubIssueNumber: 57,
  },
  {
    id: "1",
    severity: "warning",
    rule: "Rule 18",
    where: "Rig 02",
    headline: "Rig 02: the rig agent is using 200 MB",
    opened: "Oct 3 9:12 PM",
    recovered: "Oct 3 9:30 PM",
    githubIssueNumber: null,
  },
];

function render(tiles: RigTile[], alerts: RigHealthAlert[] = ALERTS): string {
  return renderToStaticMarkup(
    <StaffRigHealth
      staffName="Cody"
      tiles={tiles}
      venueProblems={[{ severity: "urgent", headline: "No featured car and track for Oct 4" }]}
      event={{ on: true, line: "started by Cody until midnight", override: "on" }}
      boards={[{ id: "b1", name: "Event board (Cadillac)", state: "live", detail: "feed ok" }]}
      checks="Checks last ran 12 s ago"
      alerts={alerts}
    />,
  );
}

describe("StaffRigHealth", () => {
  const html = render([
    tile(1, { colour: "green", driver: "Matt G · 18 min" }),
    tile(2, { colour: "yellow", problems: [{ severity: "warning", headline: "Rig 02: 200 MB" }] }),
    tile(3, { colour: "red", problems: [{ severity: "urgent", headline: "Rig 03: lap reading stopped" }] }),
    tile(4, { colour: "grey", status: "never seen" }),
    tile(5, { oldAgent: true, agent: "agent 0.3-event", iracing: "iRacing: agent too old to report" }),
  ]);

  it("gives every tile the colour it was handed", () => {
    const colours = [...html.matchAll(/data-colour="(\w+)"[^>]*>.*?font-black">(R\d+)</g)].map(
      ([, colour, label]) => `${label} ${colour}`,
    );
    expect(colours).toEqual(["R01 green", "R02 yellow", "R03 red", "R04 grey", "R05 green"]);
    expect(html).toContain("border-invalid");
    expect(html).toContain("border-gold");
  });

  it("badges an agent too old to report", () => {
    expect(html).toContain("old agent");
    expect(html).toContain("iRacing: agent too old to report");
  });

  it("shows venue problems, event mode with the active override pressed, and the checks", () => {
    expect(html).toContain("No featured car and track for Oct 4");
    expect(html).toContain("started by Cody until midnight");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Start event</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Auto</);
    expect(html).toContain("Checks last ran 12 s ago");
    expect(html).toContain("Run checks now");
    expect(html).toContain("Send test message to Discord");
  });

  it("marks open alerts, times recovered ones, and links a GitHub issue", () => {
    expect(html).toContain("Rule 15 · Rig 03 · opened 3:40 PM");
    expect(html).toMatch(/opened 3:40 PM · <span[^>]*>open<\/span>/);
    expect(html).toContain("recovered Oct 3 9:30 PM");
    expect(html).toContain('href="https://github.com/codyjohnsontx/oasisRaceControl/issues/57"');
  });

  it("says so when there are no rigs and no alerts", () => {
    const empty = render([], []);
    expect(empty).toContain("No rigs registered.");
    expect(empty).toContain("No alerts yet.");
  });
});
