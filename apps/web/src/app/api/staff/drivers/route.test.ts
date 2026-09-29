import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The name lookup behind the staff PIN reset. It lists racers' names, which the
 * public sign-in deliberately never reveals, so it must be staff-only.
 */

const query = vi.fn();
const getStaffUser = vi.fn();

vi.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  isUniqueViolation: () => false,
}));
vi.mock("@/lib/staff", () => ({
  getStaffUser: () => getStaffUser(),
}));

const { GET } = await import("./route");

function get(name?: string) {
  const url = new URL("http://localhost/api/staff/drivers");
  if (name !== undefined) url.searchParams.set("name", name);
  return new Request(url);
}

beforeEach(() => {
  query.mockReset();
  getStaffUser.mockReset();
  getStaffUser.mockResolvedValue({ userId: "staff-uuid", displayName: "Cody" });
  query.mockResolvedValue([]);
});

describe("GET /api/staff/drivers", () => {
  it("refuses a caller with no staff session before touching the database", async () => {
    getStaffUser.mockResolvedValue(null);

    const response = await GET(get("chuy"));

    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("refuses a missing or blank name (%j)", async (name) => {
    const response = await GET(get(name));

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("searches by partial name and ranks the exact name first", async () => {
    const match = { id: "d1", display_name: "chuy", lap_count: 12 };
    query.mockResolvedValue([match]);

    const response = await GET(get("  chuy "));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ drivers: [match] });
    expect(query.mock.calls[0]![1]).toEqual(["%chuy%", "chuy"]);
  });

  it("matches a typed LIKE wildcard literally", async () => {
    await GET(get("a_b%"));

    expect(query.mock.calls[0]![1]).toEqual(["%a\\_b\\%%", "a_b%"]);
  });
});
