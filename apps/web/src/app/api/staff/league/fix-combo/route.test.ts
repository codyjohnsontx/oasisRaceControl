import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Repointing tonight's round at what the rigs are running.
 *
 * The recovery for a combo typed one character off iRacing's own name, which
 * leaves the round with no field and every board in the venue empty while
 * nothing anywhere reports a fault.
 */

const repointOpenRound = vi.fn();
vi.mock("@/lib/league-queries", () => ({
  repointOpenRound: (input: unknown) => repointOpenRound(input),
}));

const getStaffUser = vi.fn();
const writeAudit = vi.fn();
vi.mock("@/lib/staff", () => ({
  getStaffUser: () => getStaffUser(),
  writeAudit: (entry: unknown) => writeAudit(entry),
}));

const { POST } = await import("./route");

const STAFF = { userId: "staff-uuid", displayName: "Cody" };
const ROUND = {
  id: "round-uuid",
  roundNumber: 3,
  trackName: "Watkins Glen International",
  trackConfig: "Boot",
  carName: "Dallara IR-18",
};

function post(body: unknown) {
  return new Request("http://localhost/api/staff/league/fix-combo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getStaffUser.mockResolvedValue(STAFF);
  repointOpenRound.mockResolvedValue(ROUND);
});

describe("POST /api/staff/league/fix-combo", () => {
  it("points the open round at the names the rigs report", async () => {
    const res = await POST(
      post({
        trackName: "Watkins Glen International",
        trackConfig: "Boot",
        carName: "Dallara IR-18",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ roundId: ROUND.id, roundNumber: 3 });
    expect(repointOpenRound).toHaveBeenCalledWith({
      trackName: "Watkins Glen International",
      trackConfig: "Boot",
      carName: "Dallara IR-18",
    });
  });

  it("records who repointed the night and onto what", async () => {
    // A round's combo decides who won. Changing it mid-night has to be
    // answerable afterwards.
    await POST(post({ trackName: "Monza", carName: "Mazda MX-5" }));
    expect(writeAudit).toHaveBeenCalledWith({
      staffUserId: STAFF.userId,
      action: "repoint_league_round",
      targetType: "league_round",
      targetId: ROUND.id,
      detail: {
        roundNumber: 3,
        trackName: ROUND.trackName,
        trackConfig: ROUND.trackConfig,
        carName: ROUND.carName,
      },
    });
  });

  it("sends a layout that was tabbed through as no layout at all", async () => {
    // The agent reports null for a track with a single layout, and "" would
    // never match it - which is the same failure this route exists to repair.
    await POST(post({ trackName: "Lime Rock Park", trackConfig: "  ", carName: "Mazda MX-5" }));
    expect(repointOpenRound).toHaveBeenCalledWith({
      trackName: "Lime Rock Park",
      trackConfig: null,
      carName: "Mazda MX-5",
    });
  });

  it("says so when the round was closed a moment ago", async () => {
    repointOpenRound.mockResolvedValue(null);
    const res = await POST(post({ trackName: "Monza", carName: "Mazda MX-5" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_open_round" });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("is staff-only, and changes nothing for anyone else", async () => {
    getStaffUser.mockResolvedValue(null);
    const res = await POST(post({ trackName: "Monza", carName: "Mazda MX-5" }));
    expect(res.status).toBe(403);
    expect(repointOpenRound).not.toHaveBeenCalled();
  });

  it("refuses a combo with no track or no car rather than pointing the night at nothing", async () => {
    for (const body of [
      { trackName: "", carName: "Mazda MX-5" },
      { trackName: "Monza", carName: "   " },
      { carName: "Mazda MX-5" },
    ]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(repointOpenRound).not.toHaveBeenCalled();
  });

  it("keeps a database failure inside this route's error contract", async () => {
    // The staff panel reads `error` off the body; a bodyless Next 500 shows up
    // as an undefined error next to a disabled button.
    repointOpenRound.mockRejectedValue(new Error("connection terminated"));
    const res = await POST(post({ trackName: "Monza", carName: "Mazda MX-5" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_error" });
  });
});
