import { beforeEach, describe, expect, it, vi } from "vitest";
import { TONIGHT_FEED_DEFAULT_ROWS, TONIGHT_FEED_MAX_ROWS } from "@/lib/leaderboards";

/**
 * The feed's row cap, without a database: the default when nobody asks, the
 * ceiling the event view of `/tv` asks for, and a refusal for anything past it.
 * The SQL itself is exercised against a real database by the integration suite
 * and by every wall that has ever polled this route. The one thing pinned
 * about it here is that it reads the shown lap's incident count off `laps`,
 * because the view does not carry it and the wall marks a time on it.
 */

const query = vi.fn(async (): Promise<unknown[]> => []);
const queryOne = vi.fn(async () => null);

vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => query(...(args as [])),
  queryOne: (...args: unknown[]) => queryOne(...(args as [])),
}));

const { GET } = await import("./route");

const get = (search = "") => GET(new Request(`http://tv.local/api/leaderboard/tonight${search}`));

/** The `limit` the ranking query was run with. */
const limitUsed = () => (query.mock.calls[0] as unknown[])[1] as unknown[];

beforeEach(() => {
  query.mockClear();
  queryOne.mockClear();
});

describe("GET /api/leaderboard/tonight", () => {
  it("keeps the cap it has always had when no limit is asked for", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(limitUsed()).toEqual([TONIGHT_FEED_DEFAULT_ROWS]);
  });

  it("returns up to the ceiling when asked", async () => {
    const res = await get(`?limit=${TONIGHT_FEED_MAX_ROWS}`);
    expect(res.status).toBe(200);
    expect(limitUsed()).toEqual([TONIGHT_FEED_MAX_ROWS]);
  });

  it.each([`${TONIGHT_FEED_MAX_ROWS + 1}`, "0", "-5", "2.5", "all"])(
    "refuses limit=%s instead of clamping it",
    async (limit) => {
      const res = await get(`?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("carries each shown lap's incident count, read off laps rather than the view", async () => {
    query.mockResolvedValueOnce([
      { driver_id: "a", display_name: "A", lap_time_ms: 1, car_name: "c", incident_delta: 2 },
      { driver_id: "b", display_name: "B", lap_time_ms: 2, car_name: "c", incident_delta: null },
    ]);
    const res = await get();
    const body = await res.json();
    expect(body.rows.map((r: { incident_delta: number | null }) => r.incident_delta)).toEqual([2, null]);
    const sql = (query.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toMatch(/from v_fastest_tonight/);
    expect(sql).toMatch(/lateral[\s\S]*from laps[\s\S]*incident_delta/);
  });
});
