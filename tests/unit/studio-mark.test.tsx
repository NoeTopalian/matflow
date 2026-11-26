// @vitest-environment jsdom
// MatFlow's own mark is the approved MF tile with STUDIO (brand/app-icon-mf-studio.svg), at a size where STUDIO
// reads, in every place MatFlow showed its old single-M tile (26 Nov 2026). Club logos and initials are not this mark.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StudioMark, STUDIO_MARK_SRC, STUDIO_MARK_MIN_PX } from "@/components/brand/StudioMark";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

// The four places main showed the old mark (a tile holding the letter M) before this change.
const PLACEMENTS = ["app/login/page.tsx", "app/apply/page.tsx", "components/landing/LandingNav.tsx", "components/landing/LandingFooter.tsx"];

describe("StudioMark", () => {
  it("draws the approved STUDIO tile, decorative, at least 72 px by default", () => {
    const { container } = render(<StudioMark />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(STUDIO_MARK_SRC);
    expect(img.getAttribute("alt")).toBe("");
    expect(Number(img.getAttribute("width"))).toBeGreaterThanOrEqual(72);
    expect(img.hasAttribute("data-studio-mark")).toBe(true);
  });

  it("loads eagerly unless a placement below the fold asks for lazy", () => {
    expect(render(<StudioMark />).container.querySelector("img")!.getAttribute("loading")).toBe("eager");
    expect(render(<StudioMark loading="lazy" />).container.querySelector("img")!.getAttribute("loading")).toBe("lazy");
  });

  it("points at the file generated from brand/app-icon-mf-studio.svg, with a version that passes the service worker cache", () => {
    expect(STUDIO_MARK_SRC).toBe("/icons/icon-512.png?v=2");
    expect(read("scripts/generate-brand-icons.mjs")).toMatch(/kit\("app-icon-mf-studio\.svg"\)[\s\S]*public\/icons\/icon-512\.png", await png\(STUDIO_ROUNDED, 512\)/);
    expect(fs.existsSync(path.join(root, "public/icons/icon-512.png"))).toBe(true);
  });
});

describe("every former placement of the old mark", () => {
  it.each(PLACEMENTS)("%s uses StudioMark, no smaller than the readable minimum, and no letter-M tile", (file) => {
    const src = read(file);
    expect(src).toMatch(/import \{ StudioMark \} from "@\/components\/brand\/StudioMark";/);
    const uses = [...src.matchAll(/<StudioMark([^>]*)\/>/g)];
    expect(uses.length).toBe(1);
    const size = uses[0][1].match(/size=\{(\d+)\}/);
    expect(size ? Number(size[1]) : STUDIO_MARK_MIN_PX).toBeGreaterThanOrEqual(STUDIO_MARK_MIN_PX);
    // The old mark: a JSX text node that is just "M".
    expect(src).not.toMatch(/>\s*M\s*</);
    expect(src).not.toMatch(/^\s*M\s*$/m);
    // No second copy of the artwork by path, and no "Studio" drawn as page text.
    expect(src).not.toMatch(/icons\/icon-(192|512)\.png/);
    expect(src).not.toMatch(/>\s*STUDIO\s*</i);
    // Only the footer sits below the fold; the sign-in, application and landing-bar marks are on the first screen.
    const lazy = /loading="lazy"/.test(uses[0][1]);
    expect(lazy).toBe(file === "components/landing/LandingFooter.tsx");
  });

  it("no product page or component draws a letter-M tile as MatFlow's mark", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "api") walk(rel); continue; }
        if (!/\.tsx$/.test(e.name)) continue;
        const s = read(rel);
        if (/>\s*M\s*</.test(s) || /^\s*M\s*$/m.test(s)) hits.push(rel);
      }
    };
    walk("app");
    walk("components");
    expect(hits).toEqual([]);
  });
});

describe("the landing header's height has one source", () => {
  it("the bar, the hero's first screen and the anchor offset all use it", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/--land-bar-h:\s*5rem;\s*--land-nav-h:\s*calc\(var\(--land-bar-h\) \+ 1px\);/);
    expect(css).toMatch(/section\[id\] \{ scroll-margin-top: var\(--land-nav-h\); \}/);
    expect(read("components/landing/LandingNav.tsx")).toMatch(/h-\[var\(--land-bar-h\)\]/);
    expect(read("components/landing/Hero.tsx")).toMatch(/minHeight: "calc\(100svh - var\(--land-nav-h\)\)"/);
  });
});
