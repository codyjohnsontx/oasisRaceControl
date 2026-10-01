import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RigTile } from "@/lib/monitor/rig-health";
import type { RigHealthAlert } from "./staff-rig-health";

/**
 * The Rig health page as served. The colours themselves are decided in
 * lib/monitor/rig-health.ts from the rules (its tests); here what must hold is
 * that each tile carries the colour it was given - and only the broken tile
 * carries the flash - an old agent is badged, and an alert shows whether it
 * is still open and links its GitHub issue.
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
    outdated: false,
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
    muted: false,
    issue: { number: 57, href: "https://github.com/codyjohnsontx/oasisRaceControl/issues/57" },
  },
  {
    id: "1",
    severity: "warning",
    rule: "Rule 18",
    where: "Rig 02",
    headline: "Rig 02: the rig agent is using 200 MB",
    opened: "Oct 3 9:12 PM",
    recovered: "Oct 3 9:30 PM",
    muted: true,
    issue: null,
  },
];

function render(tiles: RigTile[], alerts: RigHealthAlert[] = ALERTS): string {
  return renderToStaticMarkup(
    <StaffRigHealth
      staffName="Cody"
      flow={null}
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
    tile(2, { colour: "red", problems: [{ severity: "warning", headline: "Rig 02: 200 MB" }] }),
    tile(3, { colour: "red-flashing", problems: [{ severity: "urgent", headline: "Rig 03: lap reading stopped" }] }),
    tile(4, { colour: "grey", status: "never seen" }),
    tile(5, {
      colour: "red",
      oldAgent: true,
      outdated: true,
      agent: "agent 0.3-event",
      iracing: "iRacing: agent too old to report",
      footprint: "CPU and MB: agent too old to report",
      clockSkew: "clock: agent too old to report",
    }),
    tile(6, { colour: "red", outdated: true, agent: "agent 0.4-monitor" }),
    tile(7, { colour: "yellow" }),
  ]);

  /** Each tile's data-colour and the class list of that same element. */
  const tileClasses = [...html.matchAll(/data-colour="([\w-]+)" class="([^"]*)"[^>]*>.*?font-black">(R\d+)</g)].map(
    ([, colour, classes, label]) => ({ label, colour, classes }),
  );

  it("gives every tile the colour it was handed", () => {
    expect(tileClasses.map((t) => `${t.label} ${t.colour}`)).toEqual([
      "R01 green",
      "R02 red",
      "R03 red-flashing",
      "R04 grey",
      "R05 red",
      "R06 red",
      "R07 yellow",
    ]);
    expect(tileClasses.map((t) => t.classes.match(/border-\w+/)![0])).toEqual([
      "border-valid",
      "border-invalid",
      "border-invalid",
      "border-edge",
      "border-invalid",
      "border-invalid",
      "border-gold",
    ]);
  });

  it("flashes only the broken tile: a warning is the same red, held still", () => {
    const flashing = tileClasses.filter((t) => t.classes.includes("rig-tile-broken"));
    expect(flashing.map((t) => t.label)).toEqual(["R03"]);
    expect(flashing[0]!.colour).toBe("red-flashing");
  });

  it("colours the status line with its tile and keys the colours under the grid", () => {
    expect(html).toMatch(/data-colour="red-flashing".*?text-invalid">online</);
    expect(html).toMatch(/data-colour="yellow".*?text-gold">online</);
    expect(html).toMatch(/data-colour="grey".*?text-muted">never seen</);
    const key = html.match(/<ul aria-label="Tile colours".*?<\/ul>/)![0];
    expect(key.match(/<li/g)).toHaveLength(5);
    expect(key).toContain("rig-tile-broken");
    for (const meaning of ["broken now", "warning", "available", "driver signed in", "off"]) {
      expect(key).toContain(meaning);
    }
    // Gold means available here, so a warning's headline is not gold.
    expect(html).not.toMatch(/text-gold">Rig 02: 200 MB/);
    expect(html).toMatch(/text-sunset">Rig 02: 200 MB/);
  });

  it("badges an agent too old to report, and an outdated build once", () => {
    expect(html).toContain("old agent");
    // R05 is both: the stronger badge alone. R06 is outdated only.
    expect(html.match(/>outdated</g)).toHaveLength(1);
    expect(html).toMatch(/text-sunset">old agent</);
    expect(html).toMatch(/text-sunset">outdated</);
    expect(html).toContain("iRacing: agent too old to report");
    expect(html).toContain("CPU and MB: agent too old to report");
    expect(html).toContain("clock: agent too old to report");
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
    expect(html).toContain("muted (flapping)");
    expect(html).toContain('href="https://github.com/codyjohnsontx/oasisRaceControl/issues/57"');
  });

  it("says so when there are no rigs and no alerts", () => {
    const empty = render([], []);
    expect(empty).toContain("No rigs registered.");
    expect(empty).not.toContain("Tile colours");
    expect(empty).toContain("No alerts yet.");
  });
});
