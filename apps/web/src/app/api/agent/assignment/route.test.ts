import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The assignment poll, which is also the only place the backend ever says which
 * rig it thinks is asking.
 *
 * That second job exists because a rig's bearer token is the whole of its
 * identity here: laps arrive, the token names a rig, and whoever is checked in
 * there is credited. The rig number a machine was installed with never travels,
 * so an install command run at the wrong computer produces a rig that works
 * perfectly and scores every lap onto somewhere else in the room. Nothing on this
 * side can see it - the token is valid and the request is well formed - so the
 * backend's job is simply to say who it authenticated, and the agent compares
 * (apps/rig-agent/OasisRigAgent.Core/RigIdentity.cs).
 */

const rigFromBearer = vi.fn();
vi.mock("@/lib/agent-auth", () => ({
  rigFromBearer: (auth: string | null) => rigFromBearer(auth),
}));

const queryOne = vi.fn();
vi.mock("@/lib/db", () => ({
  queryOne: (sql: string, params: unknown[]) => queryOne(sql, params),
}));

const { GET } = await import("./route");

const RIG = {
  id: "rig-uuid",
  rig_number: 7,
  display_name: "Rig 07 - corner",
  installation_conflict: false,
  installation_conflict_detail: null,
};

function get() {
  return new Request("http://localhost/api/agent/assignment", {
    headers: { authorization: "Bearer whatever" },
  });
}

beforeEach(() => {
  rigFromBearer.mockReset().mockResolvedValue(RIG);
  queryOne.mockReset().mockResolvedValue(null);
});

describe("GET /api/agent/assignment", () => {
  it("names the rig the token was authenticated as, with nobody checked in", async () => {
    // The empty rig is the case that matters most: a machine enrolled on the
    // wrong token is normally found before any customer sits down, and this is
    // the only answer it gets until one does.
    const body = await (await GET(get())).json();

    expect(body.assignment).toBeNull();
    expect(body.rig).toEqual({ number: 7, displayName: "Rig 07 - corner" });
  });

  it("names it alongside an active assignment too", async () => {
    queryOne.mockResolvedValue({
      id: "assignment-uuid",
      started_at: new Date("2026-07-12T00:00:00.000Z"),
      driver_id: "driver-uuid",
      display_name: "Cody J.",
    });

    const body = await (await GET(get())).json();

    expect(body.rig).toEqual({ number: 7, displayName: "Rig 07 - corner" });
    expect(body.assignment.driver.displayName).toBe("Cody J.");
  });

  it("reports the token's rig, never a number the caller supplied", async () => {
    // A machine that could ask to be told it is rig 4 could confirm its own
    // mistake, which is the one thing this answer must not be able to do.
    const request = new Request(
      "http://localhost/api/agent/assignment?rigNumber=4",
      { headers: { authorization: "Bearer whatever", "x-rig-number": "4" } },
    );

    const body = await (await GET(request)).json();

    expect(body.rig.number).toBe(7);
  });

  it("still refuses a token it does not recognise", async () => {
    rigFromBearer.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("looks the assignment up by the rig the token names", async () => {
    await GET(get());

    expect(queryOne).toHaveBeenCalledWith(expect.any(String), ["rig-uuid"]);
  });
});
