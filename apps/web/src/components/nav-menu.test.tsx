import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The screen index must not reach the public on the `/tv` event view: a touch
 * display at an off-site event would hand any visitor every screen, the staff
 * sign-in included. The rest of the app, the shop's `/tv` among it, keeps it.
 * Rendered through the real component with only the router hooks stubbed.
 */
const location = vi.hoisted(() => ({ pathname: "/tv", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => location.pathname,
  useSearchParams: () => new URLSearchParams(location.search),
}));

const { NavMenu } = await import("./nav-menu");

function render(pathname: string, search: string): string {
  location.pathname = pathname;
  location.search = search;
  return renderToStaticMarkup(<NavMenu />);
}

describe("NavMenu", () => {
  beforeEach(() => {
    location.pathname = "/tv";
    location.search = "";
  });

  it("is absent from the /tv event view, with or without a host", () => {
    expect(render("/tv", "?event=1")).toBe("");
    expect(render("/tv", "?event=1&host=cadillac")).toBe("");
  });

  it("stays on the shop's /tv rotation", () => {
    for (const search of ["", "?event=0", "?host=cadillac"]) {
      const html = render("/tv", search);
      expect(html).toContain("Open screen menu");
      expect(html).toContain('href="/staff/login"');
    }
  });

  it("stays on every other screen, even one carrying event=1", () => {
    expect(render("/leaderboards", "?event=1")).toContain("Open screen menu");
  });
});
