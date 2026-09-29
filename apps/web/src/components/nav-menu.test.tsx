import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The screen index is in every page's server HTML, `/tv` included: the menu
 * reads nothing but the path, so no page waits for the browser to draw it.
 * The `/tv` event view hides it with CSS keyed on the marker asserted here
 * (`globals.css`, and `tv-screen.test.tsx` for the view's side of it);
 * `npm run tv:check` proves in a browser that the two meet.
 */
const location = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }));

const { NavMenu } = await import("./nav-menu");

describe("NavMenu", () => {
  it.each(["/", "/leaderboards", "/tv"])("is in the server HTML of %s", (pathname) => {
    location.pathname = pathname;
    const html = renderToStaticMarkup(<NavMenu />);
    expect(html).toMatch(/^<div data-screen-menu[ =]/);
    expect(html).toContain("Open screen menu");
    expect(html).toContain('href="/staff/login"');
  });
});
