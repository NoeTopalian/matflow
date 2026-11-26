// The MatFlow.Studio icon set behind the browser tab and the installed app:
// which file each surface names, and that every icon the manifest and the
// root layout name is a real PNG of the size it claims. Which icon a browser
// actually picks from the emitted HTML is the browser run's job.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
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

  it("the touch icon is 180 px and the layout lists one tab icon, /icon.png with its version", () => {
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
    // The only tab icon the layout lists is app/icon.png. Next adds it by
    // itself only when a layout sets no icons at all. Its address has no
    // content hash, so it carries a version: without one a browser that kept
    // an earlier tab tile would never ask for the new file.
    const listed = [...icons.matchAll(/url: "([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual(["/icon.png?v=4"]);
    expect(icons).not.toContain("/icons/");
  });

  it("the tab icons are the plain MF tile at 16, 32, 48 and 512 px, not the MF STUDIO tile", async () => {
    // Noe, 26 Nov 2026 (evening): the browser tab shows the plain MF; the MF
    // STUDIO tile is for the installed app and the phone home screen. Each
    // committed tab icon is compared, pixel by pixel, with
    // brand/app-icon-mf-plain.svg drawn at that size the way
    // scripts/generate-brand-icons.mjs draws it, and must be nearer to it than
    // to the STUDIO tile. Pixels, not bytes: PNG compression may differ
    // between machines, the picture may not.
    const draw = (name: string, size: number) =>
      sharp(readFileSync(resolve(ROOT, "brand", name)), { density: Math.ceil((72 * size) / 200) * 2 })
        .resize(size, size).ensureAlpha().raw().toBuffer();
    const pixels = (buf: Buffer) => sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    /** Mean absolute difference per channel, 0 to 255. */
    const distance = (a: Buffer, b: Buffer) => {
      expect(a.length).toBe(b.length);
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
      return sum / a.length;
    };

    const ico = readFileSync(resolve(ROOT, "app/favicon.ico"));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const p = 6 + i * 16;
      const start = ico.readUInt32LE(p + 12);
      return { size: ico[p] || 256, data: ico.subarray(start, start + ico.readUInt32LE(p + 8)) };
    });
    expect(entries.map((e) => e.size)).toEqual([16, 32, 48]);

    const tabIcons = [...entries, { size: 512, data: readFileSync(resolve(ROOT, "app/icon.png")) }];
    for (const { size, data } of tabIcons) {
      const got = await pixels(data);
      expect([got.info.width, got.info.height], `${size} px`).toEqual([size, size]);
      const toPlain = distance(got.data, await draw("app-icon-mf-plain.svg", size));
      const toStudio = distance(got.data, await draw("app-icon-mf-studio.svg", size));
      expect(toPlain, `${size} px is the plain MF tile`).toBeLessThan(0.5);
      expect(toStudio, `${size} px is not the STUDIO tile`).toBeGreaterThan(toPlain + 1);
    }
  });

  it("the installed app and the phone home screen use the MF STUDIO tile", async () => {
    // The manifest's regular icons and the iOS touch icon, compared pixel by
    // pixel with the STUDIO drawings they are generated from (rounded for the
    // manifest, square for iOS, which rounds the corners itself).
    const draw = (name: string, size: number) =>
      sharp(readFileSync(resolve(ROOT, "brand", name)), { density: Math.ceil((72 * size) / 200) * 2 })
        .resize(size, size).ensureAlpha().raw().toBuffer();
    const distance = (a: Buffer, b: Buffer) => {
      expect(a.length).toBe(b.length);
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
      return sum / a.length;
    };
    const cases: [string, string, number][] = [
      ["public/icons/icon-192.png", "app-icon-mf-studio.svg", 192],
      ["public/icons/icon-512.png", "app-icon-mf-studio.svg", 512],
      ["public/apple-touch-icon.png", "app-icon-mf-studio-square.svg", 180],
    ];
    for (const [file, drawing, size] of cases) {
      const got = await sharp(readFileSync(resolve(ROOT, file))).ensureAlpha().raw().toBuffer();
      expect(distance(got, await draw(drawing, size)), `${file} is the STUDIO tile`).toBeLessThan(0.5);
      expect(distance(got, await draw("app-icon-mf-plain.svg", size)), `${file} is not the plain MF`).toBeGreaterThan(1);
    }
  });

  it("the installed app is still called MatFlow under its icon", () => {
    expect(manifest().short_name).toBe("MatFlow");
  });
});
