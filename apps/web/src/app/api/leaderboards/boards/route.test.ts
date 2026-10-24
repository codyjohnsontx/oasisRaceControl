import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shape of the rotation's list, without a database: the tracks with laps
 * and the tracks the rigs are on right now, as two lists, from the two
 * queries. What the live query returns against real heartbeats, and the
 * window it reads, is `src/lib/leaderboards-live.integration.test.ts`.
 */

const boards = [{ track_name: "Spa-Francorchamps", track_config: null, driver_count: 3, lap_count: 9 }];
const live = [{ track_name: "Monza", track_config: null, car_names: ["BMW M4 GT3"], rig_count: 1 }];

const listBoards = vi.fn(async () => boards);
const listLiveTracks = vi.fn(async () => live);

vi.mock("@/lib/leaderboards-queries", () => ({
  listBoards: () => listBoards(),
  listLiveTracks: () => listLiveTracks(),
}));

const { GET } = await import("./route");

beforeEach(() => {
  listBoards.mockClear();
  listLiveTracks.mockClear();
});

describe("GET /api/leaderboards/boards", () => {
  it("answers the tracks with laps and the tracks the rigs are on as two lists", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ boards, live });
  });

  it("answers 500 when either list cannot be read", async () => {
    listLiveTracks.mockRejectedValueOnce(new Error("down"));
    expect((await GET()).status).toBe(500);
    listBoards.mockRejectedValueOnce(new Error("down"));
    expect((await GET()).status).toBe(500);
  });
});
