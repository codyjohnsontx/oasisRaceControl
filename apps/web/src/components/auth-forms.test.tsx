import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthForms } from "./auth-forms";

/**
 * Which PIN boxes each tab shows. A new profile asks for its PIN twice (the
 * comparison itself is `newPinRefusal`, tested beside it); signing back in
 * asks once, as it always has.
 */

const render = (defaultMode: "login" | "register") =>
  renderToStaticMarkup(<AuthForms onSignedIn={() => {}} defaultMode={defaultMode} />);

describe("AuthForms", () => {
  it("asks a new profile for its PIN twice", () => {
    const html = render("register");
    expect(html).toContain('id="driver-pin"');
    expect(html).toContain('id="driver-pin-again"');
    expect(html).toContain("Type the PIN again");
  });

  it("asks a returning driver for the PIN once", () => {
    const html = render("login");
    expect(html).toContain('id="driver-pin"');
    expect(html).not.toContain('id="driver-pin-again"');
  });
});
