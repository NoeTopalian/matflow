// Generate MatFlow PWA icons with sharp. Re-runnable:
//   node scripts/generate-pwa-icons.mjs
//
// Produces:
//   public/icons/icon-192.png      (rounded square, transparent corners)
//   public/icons/icon-512.png      (rounded square, transparent corners)
//   public/apple-touch-icon.png    (180x180, opaque, square corners — iOS applies its own mask)
//
// Design: near-black #111111 rounded square, clean white "M" drawn as a
// stroked path (no font dependency, so output is identical on any machine).

import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(root, "public", "icons");

// 512-unit canvas. Corner radius ~15% keeps the rounded look while losing
// almost nothing when a launcher applies a maskable crop.
// The "M" glyph sits inside the central safe zone (roughly 40% of the canvas).
const svg = (rounded) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="0" y="0" width="512" height="512" rx="${rounded ? 76 : 0}" fill="#111111"/>
  <path d="M 156 352 L 156 160 L 256 296 L 356 160 L 356 352"
        fill="none" stroke="#ffffff" stroke-width="40"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

await mkdir(iconsDir, { recursive: true });

const roundedBuffer = Buffer.from(svg(true));
const squareBuffer = Buffer.from(svg(false));

await sharp(roundedBuffer).resize(512, 512).png().toFile(path.join(iconsDir, "icon-512.png"));
await sharp(roundedBuffer).resize(192, 192).png().toFile(path.join(iconsDir, "icon-192.png"));
// Apple touch icon: opaque, square corners, no alpha channel — iOS masks it itself.
await sharp(squareBuffer)
  .resize(180, 180)
  .flatten({ background: "#111111" })
  .removeAlpha()
  .png()
  .toFile(path.join(root, "public", "apple-touch-icon.png"));

for (const f of [
  path.join(iconsDir, "icon-192.png"),
  path.join(iconsDir, "icon-512.png"),
  path.join(root, "public", "apple-touch-icon.png"),
]) {
  const m = await sharp(f).metadata();
  console.log(`${path.basename(f)}: ${m.width}x${m.height} ${m.format} channels=${m.channels} alpha=${m.hasAlpha}`);
}
