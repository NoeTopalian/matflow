// @vitest-environment jsdom
//
// The camera chip on a member's picture rendered as a 20×44 vertical pill:
// app/globals.css puts `min-height: 44px` on every button without
// .ui-fixed-size, and the fine-pointer relaxation exempts only
// .ui-fixed-size — so the inline 20px height never won, on any pointer.
// Noe photographed it on 17 Aug and asked again on 18 Sep 2026. The circle
// keeps its own geometry and supplies the 44px touch target as a centred
// ::before overlay instead (UI-RULES §5a) — both axes, because the compact
// Button's inset-x-0 overlay would have left a 20×44 target that looks
// compliant and is not.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { AvatarUploader } from "@/components/ui/AvatarUploader";

afterEach(cleanup);

function renderChip() {
  render(<AvatarUploader memberId="m-1" name="Ada Lovelace" pictureUrl={null} onChange={() => {}} />);
  return screen.getByRole("button", { name: "Add profile picture" });
}

describe("AvatarUploader camera chip", () => {
  it("is a fixed-size circle whose width equals its height", () => {
    const chip = renderChip();
    const classes = chip.className.split(/\s+/);
    expect(classes).toContain("ui-fixed-size");
    expect(classes).toContain("rounded-full");
    expect(chip.style.width).toBe(chip.style.height);
    expect(chip.style.width).toBe("24px");
  });

  it("carries a 44px touch target on BOTH axes", () => {
    const classes = renderChip().className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(["before:h-11", "before:w-11", "before:absolute", "before:left-1/2", "before:top-1/2"]),
    );
  });
});
