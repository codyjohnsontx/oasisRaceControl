import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaffPinReset } from "./staff-pin-reset";

/**
 * The two ways staff reach the PIN reset: the panel's own name search, and a
 * tap on a racer's name under Recent laps, which hands the panel that driver.
 * Rendered to static markup - what the panel shows first is the behaviour.
 */

describe("StaffPinReset", () => {
  it("starts on the name search when no driver was tapped", () => {
    const html = renderToStaticMarkup(<StaffPinReset />);

    expect(html).toContain("Racer name");
    expect(html).not.toContain("New PIN for");
    expect(html).not.toContain("Type it again");
  });

  it("opens straight on the typed-twice PIN form for a tapped driver", () => {
    const html = renderToStaticMarkup(
      <StaffPinReset driver={{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_name: "chuy" }} />,
    );

    expect(html).toContain('New PIN for <span class="font-bold">chuy</span>');
    expect(html).toContain("Type it again");
    expect(html.match(/type="password"/g)).toHaveLength(2);
  });
});
