// @vitest-environment jsdom
//
// Round 11 item X.1 (carry-over "48 Tabs"): the staff phone "More" sheet is
// always mounted and was hidden only by `translate-y-full`. While closed its
// links and both sign-out buttons stayed in the Tab order and the
// accessibility tree; opening it moved no focus and Escape did nothing. Now,
// closed, it is `inert` and `aria-hidden`; open, it is a labelled modal dialog
// on the shared overlay behaviour (focus in, Tab trapped, Escape closes and
// focus returns to More).

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

import MobileNav from "@/components/layout/MobileNav";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function renderNav() {
  render(<MobileNav role="owner" primaryColor="#3b82f6" />);
  return screen.getByRole("button", { name: "More options" });
}

/** The sheet panel (the fixed box holding "Close menu"), whether or not it is hidden. */
function sheetPanel(): HTMLElement {
  const close = document.querySelector('[aria-label="Close menu"]');
  return close?.closest(".fixed") as HTMLElement;
}

const tab = (shiftKey = false) => fireEvent.keyDown(document, { key: "Tab", shiftKey });

describe("staff phone More sheet — closed", () => {
  it("its links and buttons are out of the Tab order and the accessibility tree", () => {
    renderNav();
    const panel = sheetPanel();
    expect(panel, "sheet panel not found").toBeTruthy();
    // `inert` removes every descendant from sequential focus in a browser
    // (jsdom does not implement it, so assert the attribute itself).
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    // Hidden from the accessibility tree: none of its items is reachable by role.
    expect(screen.queryByRole("link", { name: /Reports/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out all devices" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("staff phone More sheet — open", () => {
  it("opening moves focus into a labelled modal dialog", () => {
    const more = renderNav();
    more.focus();
    fireEvent.click(more);
    const dialog = screen.getByRole("dialog", { name: "More" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.hasAttribute("inert")).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The items are back in the accessibility tree.
    expect(screen.getByRole("link", { name: /Reports/ })).toBeTruthy();
  });

  it("keeps Tab and Shift+Tab inside the sheet", () => {
    const more = renderNav();
    more.focus();
    fireEvent.click(more);
    const dialog = screen.getByRole("dialog", { name: "More" });
    const controls = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
    expect(controls.length).toBeGreaterThan(2);
    controls.at(-1)!.focus();
    tab();
    expect(document.activeElement).toBe(controls[0]);
    tab(true);
    expect(document.activeElement).toBe(controls.at(-1));
  });

  it("Escape closes it and returns focus to the More button", () => {
    const more = renderNav();
    more.focus();
    fireEvent.click(more);
    expect(screen.getByRole("dialog", { name: "More" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sheetPanel().hasAttribute("inert")).toBe(true);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });
});
