// The MatFlow.Studio icon set behind the browser tab and the installed app:
// which file each surface names, and that every icon the manifest and the
// root layout name is a real PNG of the size it claims. Which icon a browser
// actually picks from the emitted HTML is the browser run's job.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "@/app/manifest";

const ROOT = resolve(__dirname, "../..");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk. */
function pngSize(rel: string) {
  const buf = readFileSync(resolve(ROOT, rel));
  expect(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${rel} is a PNG`).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const publicFile = (src: string) => `public${src.split("?")[0]}`;

describe("brand kit files", () => {
  it("no icon drawing contains live text, a script or an embedded image", () => {
    for (const name of ["app-icon-mf-plain.svg", "app-icon-mf-studio.svg", "app-icon-mf-studio-square.svg", "favicon.svg"]) {
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
    expect(maskable.length).toBe(2);
    for (const src of maskable) {
      expect(any).not.toContain(src);
      // Not a copy of the rounded tile under another name. That the artwork is
      // full bleed and inside the safe circle is checked on the built site.
      const twin = src.replace("-maskable", "");
      expect(readFileSync(resolve(ROOT, publicFile(src))).equals(readFileSync(resolve(ROOT, publicFile(twin)))), src).toBe(false);
    }
  });

  it("the touch icon is 180 px and the tab icon is the plain MF tile only", () => {
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
    // The only tab icon the layout lists is the plain MF tile. Next adds
    // app/icon.png by itself only when a layout sets no icons at all, and the
    // STUDIO-patch tiles under /icons/ are unreadable at 16 px.
    const listed = [...icons.matchAll(/url: "([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual(["/icon.png"]);
    expect(icons).not.toContain("/icons/");
  });

  it("the installed app is still called MatFlow under its icon", () => {
    expect(manifest().short_name).toBe("MatFlow");
  });
});
