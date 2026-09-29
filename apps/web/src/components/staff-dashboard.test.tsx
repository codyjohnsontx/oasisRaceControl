import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RigStatusRow } from "./staff-dashboard";

/**
 * Whether a rig tile reads online, on the page as served. The window is tied
 * to the agent's 60 s heartbeat and the monitor's 120 s rig-silent rule, so a
 * rig two heartbeats late is still online and one well past that is not.
 *
 * `next/navigation` is stubbed: the server render here has no app router, and
 * the dashboard only uses it to refresh.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const { StaffDashboard } = await import("./staff-dashboard");

const NOW = new Date("2026-09-28T20:00:00.000Z");

function rig(rigNumber: number, secondsAgo: number): RigStatusRow {
  return {
    rig_id: `rig-${rigNumber}`,
    rig_number: rigNumber,
    display_name: `Rig ${rigNumber}`,
    agent_version: "rig-agent/0.4-monitor",
    last_seen_at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString(),
    assignment_id: null,
    assignment_started_at: null,
    driver_id: null,
    driver_name: null,
  };
}

/** The status label on the tile for rig `rigNumber`. */
function tileStatus(html: string, rigNumber: number): string | null {
  const label = `R${rigNumber.toString().padStart(2, "0")}`;
  const match = html.match(
    new RegExp(`<span class="font-black">${label}</span><span class="[^"]*">([^<]*)</span>`),
  );
  return match?.[1] ?? null;
}

function render(rigs: RigStatusRow[]): string {
  return renderToStaticMarkup(
    <StaffDashboard
      staffName="Staff"
      rigs={rigs}
      laps={[]}
      unattributedLaps={[]}
      unattributedLapTotal={0}
      league={{
        seasonName: null,
        nextSeasonName: "September",
        openRound: null,
        openRoundDrivers: 0,
        recentRounds: [],
        comboOptions: [],
        todaysCombo: null,
      }}
    />,
  );
}

describe("StaffDashboard rig tiles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a rig last seen 120 s ago online, two missed heartbeats in", () => {
    expect(tileStatus(render([rig(1, 120)]), 1)).toBe("online");
  });

  it("shows a rig last seen 160 s ago as agent offline", () => {
    expect(tileStatus(render([rig(2, 160)]), 2)).toBe("agent offline");
  });
});
