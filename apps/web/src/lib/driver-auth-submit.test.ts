import { describe, expect, it, vi } from "vitest";
import { submitDriverAuth, submitGuestClaim } from "./driver-auth-submit";

/**
 * What the New profile tab and the guest Save profile form send, against a
 * stand-in fetch: two PINs that differ send nothing and come back refused;
 * two that match send one request carrying that one PIN.
 */

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

const sent = (fetchImpl: ReturnType<typeof fakeFetch>) =>
  fetchImpl.mock.calls.map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

describe("submitDriverAuth", () => {
  it("sends nothing for a new profile whose PINs differ", async () => {
    const fetchImpl = fakeFetch(200, { displayName: "Chuy" });
    const result = await submitDriverAuth("register", { name: "Chuy", pin: "1234", pinAgain: "1243" }, fetchImpl);
    expect(result).toEqual({ ok: false, message: "The two PINs don't match - type the same PIN in both boxes" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a new profile's one PIN, once, when both match", async () => {
    const fetchImpl = fakeFetch(200, { displayName: "Chuy" });
    const result = await submitDriverAuth("register", { name: "Chuy", pin: "1234", pinAgain: "1234" }, fetchImpl);
    expect(result).toEqual({ ok: true, displayName: "Chuy" });
    expect(sent(fetchImpl)).toEqual([{ url: "/api/auth/register", body: { displayName: "Chuy", pin: "1234" } }]);
  });

  it("signs a returning driver in with the PIN typed once", async () => {
    const fetchImpl = fakeFetch(200, { displayName: "Chuy" });
    const result = await submitDriverAuth("login", { name: "chuy", pin: "1234", pinAgain: "" }, fetchImpl);
    expect(result).toEqual({ ok: true, displayName: "Chuy" });
    expect(sent(fetchImpl)).toEqual([{ url: "/api/auth/login", body: { displayName: "chuy", pin: "1234" } }]);
  });

  it("words a taken name on New profile as the backend's refusal", async () => {
    const fetchImpl = fakeFetch(409, { error: "name_taken" });
    const result = await submitDriverAuth("register", { name: "Chuy", pin: "1234", pinAgain: "1234" }, fetchImpl);
    expect(result).toEqual({
      ok: false,
      message: "That name is already registered. If it's yours, use Sign in; otherwise pick a different name.",
    });
  });
});

describe("submitGuestClaim", () => {
  it("sends nothing when the two PINs differ", async () => {
    const fetchImpl = fakeFetch(200, {});
    const result = await submitGuestClaim({ pin: "0427", pinAgain: "0472" }, fetchImpl);
    expect(result).toEqual({ ok: false, message: "The two PINs don't match - type the same PIN in both boxes" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the one PIN, once, when both match", async () => {
    const fetchImpl = fakeFetch(200, {});
    const result = await submitGuestClaim({ pin: "0427", pinAgain: "0427" }, fetchImpl);
    expect(result).toEqual({ ok: true });
    expect(sent(fetchImpl)).toEqual([{ url: "/api/auth/claim", body: { pin: "0427" } }]);
  });

  it("says so when the save is refused", async () => {
    const result = await submitGuestClaim({ pin: "0427", pinAgain: "0427" }, fakeFetch(500, {}));
    expect(result).toEqual({ ok: false, message: "Could not save the profile — try again" });
  });
});
