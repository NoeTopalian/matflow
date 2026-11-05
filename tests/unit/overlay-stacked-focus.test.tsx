// @vitest-environment jsdom
// Two overlays open at once (a Sheet opened from a Sheet; a confirm over a
// Sheet): Tab belongs to the one on top. Before this each overlay's focus trap
// answered every Tab, the lower one pulling focus into its own panel and the
// upper one pulling it straight back to its first control — so on a phone the
// Activity types sheet, opened from Filters, could not be used by keyboard.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function Stacked({ upper }: { upper: boolean }) {
  return (
    <>
      <Sheet open onClose={() => {}} title="Filters">
        <Button type="button">Lower one</Button>
        <Button type="button">Lower two</Button>
      </Sheet>
      <Sheet open={upper} onClose={() => {}} title="Activity types">
        <Button type="button">Upper one</Button>
        <Button type="button">Upper two</Button>
      </Sheet>
    </>
  );
}

const tab = (shiftKey = false) => fireEvent.keyDown(document, { key: "Tab", shiftKey });
const focused = () => document.activeElement?.textContent ?? document.activeElement?.getAttribute("aria-label");

describe("stacked overlays", () => {
  it("Tab moves on from a control in the top overlay's footer back to its first control, never into the one beneath", () => {
    render(<Stacked upper />);
    const upper = screen.getByRole("dialog", { name: "Activity types" });
    const controls = [...upper.querySelectorAll<HTMLElement>("button")];
    const last = controls.at(-1)!;
    // Focus is somewhere in the middle of the top sheet: Tab is left to the browser (the trap only acts at the ends).
    controls[1].focus();
    tab();
    expect(document.activeElement).toBe(controls[1]);
    // At the last control it wraps to the first — of THIS sheet.
    last.focus();
    tab();
    expect(document.activeElement).toBe(controls[0]);
    expect(upper.contains(document.activeElement)).toBe(true);
    // And backwards from the first to the last.
    tab(true);
    expect(document.activeElement).toBe(last);
    expect(focused()).not.toMatch(/Lower/);
  });

  it("with the top one closed, the one beneath traps Tab again", () => {
    const { rerender } = render(<Stacked upper />);
    rerender(<Stacked upper={false} />);
    const lower = screen.getByRole("dialog", { name: "Filters" });
    const controls = [...lower.querySelectorAll<HTMLElement>("button")];
    controls.at(-1)!.focus();
    tab();
    expect(document.activeElement).toBe(controls[0]);
  });
});
