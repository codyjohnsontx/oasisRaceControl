import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The wall's touch lock, pinned on the page as served. A browser honours the
 * list's `touch-action: pan-y` only if no ancestor forbids that gesture, so on
 * the event view every ancestor of the list must allow a vertical pan or a
 * finger can never scroll it; on the rotation, where nothing is meant to move,
 * the lock stays total. Synthetic touch events skip `touch-action`, which is
 * why this is pinned on the markup rather than trusted to a gesture test.
 *
 * The same `main` carries `data-tv-mode`, which is what hides the app-wide
 * Screens menu on the event view (`globals.css`, `nav-menu.test.tsx`).
 *
 * `next/image` is stubbed: the server render here has no Next runtime, and
 * the footer's images are not what is under test.
 */

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt } = props as { src: string; alt: string };
    // eslint-disable-next-line @next/next/no-img-element -- a stub for the server render, not a page image
    return <img src={src} alt={alt} />;
  },
}));

const { TvScreen } = await import("./tv-screen");

const renderMain = (mode: "event" | "rotation") => {
  const html = renderToStaticMarkup(<TvScreen initialBoards={[]} mode={mode} hostLogo={null} />);
  const main = html.match(/<main data-tv-mode="([^"]*)" class="([^"]*)"/);
  expect(main).not.toBeNull();
  return { mode: main![1], classes: main![2].split(/\s+/) };
};
const mainClasses = (mode: "event" | "rotation") => renderMain(mode).classes;

describe("TvScreen touch lock", () => {
  it("lets the event view pan vertically, on the list's own ancestor", () => {
    const classes = mainClasses("event");
    expect(classes).toContain("touch-pan-y");
    expect(classes).not.toContain("touch-none");
  });

  it("keeps the rotation locked against every touch gesture", () => {
    const classes = mainClasses("rotation");
    expect(classes).toContain("touch-none");
    expect(classes).not.toContain("touch-pan-y");
  });
});

describe("TvScreen Screens-menu marker", () => {
  it("marks the event view, which hides the menu", () => {
    expect(renderMain("event").mode).toBe("event");
  });

  it("marks the rotation as the rotation, which keeps the menu", () => {
    expect(renderMain("rotation").mode).toBe("rotation");
  });
});
