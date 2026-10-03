import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LeagueRound } from "./league-round";
import type { LeagueRound as Round, RoundLap, RoundResult } from "@/lib/league";

/**
 * The round page a customer reads on a phone. Its right-hand column is the gap
 * to the round's fastest lap, which a raced round does not order by - so the
 * fastest-lap holder must not read as the race's leader.
 */

const round: Round = {
  id: "round-1",
  season_id: "season-1",
  season_name: "October",
  league_name: "Oasis League",
  round_number: 1,
  name: null,
  round_date: "2026-10-07",
  track_name: "Spa",
  track_config: null,
  car_name: "Ferrari 296 GT3",
  incident_limit: 0,
  opened_at: "2026-10-07T18:00:00Z",
  closed_at: null,
};

function result(name: string, change: Partial<RoundResult>): RoundResult {
  return {
    round_id: round.id,
    round_number: 1,
    driver_id: `driver-${name}`,
    display_name: name,
    position: 1,
    best_lap_ms: 136_000,
    lap_count: 10,
    valid_lap_count: 10,
    raced: false,
    qualifying_lap_ms: null,
    qualifying_position: null,
    finish_source: null,
    ...change,
  };
}

function lap(driverId: string, lapTimeMs: number): RoundLap {
  return {
    id: `${driverId}-${lapTimeMs}`,
    driver_id: driverId,
    lap_number: 1,
    lap_time_ms: lapTimeMs,
    incident_delta: 0,
    is_valid: true,
    invalid_reason: null,
    completed_at: "2026-10-07T19:00:00Z",
  };
}

function render(field: RoundResult[], viewer: string): string {
  const laps = Object.fromEntries(
    field.map((row) => [row.driver_id, row.best_lap_ms === null ? [] : [lap(row.driver_id, row.best_lap_ms)]]),
  );
  return renderToStaticMarkup(
    <LeagueRound
      round={round}
      initialField={field}
      initialLaps={laps}
      initialTruncated={false}
      viewerDriverId={viewer}
    />,
  );
}

describe("LeagueRound", () => {
  it("calls the fastest lap in a raced round 'fastest lap', not the leader", () => {
    // Ana won the race; Ben, second, set the round's fastest lap.
    const html = render(
      [
        result("Ana", { raced: true, position: 1, best_lap_ms: 136_000, finish_source: "flag" }),
        result("Ben", { raced: true, position: 2, best_lap_ms: 134_000, finish_source: "flag" }),
      ],
      "driver-Ben",
    );
    expect(html).toContain("fastest lap");
    expect(html).not.toMatch(/>leader</);
  });

  it("keeps 'leader' in a round ranked by lap time", () => {
    const html = render(
      [
        result("Ben", { position: 1, best_lap_ms: 134_000 }),
        result("Ana", { position: 2, best_lap_ms: 136_000 }),
      ],
      "driver-Ben",
    );
    expect(html).toMatch(/>leader</);
    expect(html).not.toContain("fastest lap");
  });
});
