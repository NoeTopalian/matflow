// @vitest-environment jsdom
// The keyboard focus ring in the staff dashboard is drawn in the club's accent
// (UI-RULES §2a: an accent is an input, not a palette we control). A white or
// pale accent drew no ring at all on the light shell. ThemeProvider now
// publishes `--focus-ring`: the accent, moved only as far as it must to be seen.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import fs from "node:fs";
import path from "node:path";

import ThemeProvider from "@/components/layout/ThemeProvider";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `--sf-0` (the navigation, the darkest surface) as app/globals.css declares it for the staff shell (jsdom loads no stylesheet). */
const sf0 = () => /--sf-0:\s*(#[0-9a-f]{6})/i.exec(fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8"))![1];
const ringFor = (accent: string) => {
  document.documentElement.style.setProperty("--sf-0", sf0());
  const view = render(
    <ThemeProvider primaryColor={accent} secondaryColor="#111111" textColor="#111111">
      <p>page</p>
    </ThemeProvider>,
  );
  const ring = document.documentElement.style.getPropertyValue("--focus-ring");
  return { ring, view };
};

describe("the staff shell's focus ring", () => {
  it.each(["#ffffff", "#ffe14d", "#f5f6f8", "#8b8b8b"])("an accent that cannot be seen on a light surface (%s) is darkened until it can", (accent) => {
    const { ring } = ringFor(accent);
    expect(ring).toMatch(/^#[0-9a-f]{6}$/i);
    // Against a white card, the page grey, a hovered or striped row, and the navigation.
    for (const surface of ["#ffffff", "#f5f6f8", "#f0f2f5", "#eceef2"]) expect(contrast(ring, surface), `${accent} on ${surface}`).toBeGreaterThanOrEqual(3);
  });

  it.each(["#3b82f6", "#111111", "#b91c1c"])("an accent that already shows (%s) is the ring, unchanged", (accent) => {
    expect(ringFor(accent).ring.toLowerCase()).toBe(accent);
  });

  it("is this shell's alone: leaving the dashboard gives the ring back to the accent", () => {
    const { view } = ringFor("#ffffff");
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--focus-ring")).toBe("");
  });

  it("without the surface token nothing is published, and the ring stays the accent", () => {
    document.documentElement.style.removeProperty("--sf-0");
    render(
      <ThemeProvider primaryColor="#ffffff" secondaryColor="#111111" textColor="#111111">
        <p>page</p>
      </ThemeProvider>,
    );
    expect(document.documentElement.style.getPropertyValue("--focus-ring")).toBe("");
  });

  it("is what the stylesheet draws the ring with, falling back to the accent where no shell sets it", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring, var\(--color-primary, #3b82f6\)\);/);
  });
});
