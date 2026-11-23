// @vitest-environment jsdom
//
// The MatFlow.Studio logo on the landing page and the icon set behind the
// browser tab and the installed app. jsdom lays nothing out: this pins which
// brand file each place uses, what it is called for a screen reader, and that
// every icon the manifest names is a real PNG of the size it claims. How it
// looks is the browser run's job.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "@/app/manifest";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { Hero } from "@/components/landing/Hero";

const ROOT = resolve(__dirname, "../..");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk. */
function pngSize(rel: string) {
  const buf = readFileSync(resolve(ROOT, rel));
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${rel} is a PNG`).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const publicFile = (src: string) => `public${src.split("?")[0]}`;
const srcOf = (img: HTMLElement) => decodeURIComponent(img.getAttribute("src") ?? "");

afterEach(cleanup);

describe("landing page logo", () => {
  it("the top bar links home with the short logo, named MatFlow.Studio", () => {
    render(<LandingNav />);
    const home = screen.getByRole("link", { name: "MatFlow.Studio home" });
    expect(home.getAttribute("href")).toBe("/");
    // Two drawings, one shown at a time: the plain bar on a phone, the striped
    // belt from 640 px, as the brand guide sizes them.
    const [small, striped] = within(home).getAllByRole("img", { name: "MatFlow.Studio" });
    expect(srcOf(small)).toContain("matflow-short-small-on-dark");
    expect(small.className).toContain("sm:hidden");
    expect(Number(small.getAttribute("width"))).toBeLessThan(140);
    expect(srcOf(striped)).toContain("matflow-short-on-dark");
    expect(striped.className).toContain("hidden sm:block");
    expect(Number(striped.getAttribute("width"))).toBeGreaterThanOrEqual(140);
    expect(Number(striped.getAttribute("width"))).toBeLessThan(320);
  });

  it("the opening carries the full logo at 320 px or wider", () => {
    render(<Hero />);
    const logo = screen.getByRole("img", { name: "MatFlow.Studio" });
    expect(srcOf(logo)).toContain("matflowstudio-logo-on-dark");
    expect(Number(logo.getAttribute("width"))).toBeGreaterThanOrEqual(320);
  });

  it("the footer names the product in full beside the MF icon", () => {
    const { container } = render(<LandingFooter />);
    expect(screen.getByText("© 2026 MatFlow.Studio")).toBeTruthy();
    const icon = container.querySelector("img");
    // The test bundler inlines a file this small, so match its file name or
    // the title the kit gave the drawing.
    expect(srcOf(icon as HTMLElement)).toMatch(/app-icon-mf-plain|MatFlow\.Studio small icon/);
    // Decorative: the name is in the text next to it.
    expect(icon?.getAttribute("alt")).toBe("");
  });

  it("no brand file contains live text, a script or an embedded image", () => {
    for (const name of [
      "matflow-short-on-dark.svg",
      "matflowstudio-logo-on-dark.svg",
      "app-icon-mf-plain.svg",
      "app-icon-mf-studio.svg",
      "app-icon-mf-studio-square.svg",
    ]) {
      const svg = readFileSync(resolve(ROOT, "brand", name), "utf8");
      expect(svg, name).not.toMatch(/<(text|script|image|foreignObject)\b/i);
    }
  });
});

describe("icon set", () => {
  it("every manifest icon is a PNG of the size it claims, served from /icons/", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(
      ["192x192 any", "192x192 maskable", "512x512 any", "512x512 maskable"].sort(),
    );
    for (const icon of icons) {
      // proxy.ts lets /icons/ through without a session; anything else would
      // be answered with a redirect to the login page.
      expect(icon.src.startsWith("/icons/"), icon.src).toBe(true);
      const size = Number(icon.sizes?.split("x")[0]);
      expect(pngSize(publicFile(icon.src)), icon.src).toEqual({ width: size, height: size });
    }
  });

  it("maskable icons are their own full-bleed files, not the rounded tile", () => {
    const icons = manifest().icons ?? [];
    const any = icons.filter((i) => i.purpose === "any").map((i) => i.src.split("?")[0]);
    const maskable = icons.filter((i) => i.purpose === "maskable").map((i) => i.src.split("?")[0]);
    for (const src of maskable) expect(any).not.toContain(src);
  });

  it("the touch icon is 180 px and the tab icon files exist", () => {
    // Read as text: app/layout.tsx loads next/font, which only the Next
    // compiler can run.
    const layout = readFileSync(resolve(ROOT, "app/layout.tsx"), "utf8");
    const icons = layout.match(/\n  icons: \{([\s\S]*?)\n  \},/)?.[1] ?? "";
    expect(icons).not.toBe("");
    const apple = icons.match(/apple: "([^"]+)"/)?.[1] ?? "";
    expect(apple.startsWith("/apple-touch-icon.png")).toBe(true);
    expect(pngSize(publicFile(apple))).toEqual({ width: 180, height: 180 });
    expect(pngSize("app/icon.png").width).toBe(pngSize("app/icon.png").height);
    expect(existsSync(resolve(ROOT, "app/favicon.ico"))).toBe(true);
    // The layout must not list its own tab icons: they would outrank the plain
    // MF tile in app/ with the STUDIO-patch tile, which is unreadable at 16 px.
    expect(icons).not.toMatch(/icon:/);
  });

  it("the installed app is still called MatFlow under its icon", () => {
    expect(manifest().short_name).toBe("MatFlow");
  });
});
