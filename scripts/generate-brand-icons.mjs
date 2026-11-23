/**
 * Generates the whole MatFlow.Studio icon set from the brand kit in `brand/`.
 *
 * Every icon surface (browser tab, installed app, Android home screen, iOS
 * touch icon) is rasterised from the kit's SVG files, so they cannot drift
 * apart. The kit is used as it is: nothing here redraws or recolours the mark
 * (brand/MATFLOW-STUDIO-LOGO-GUIDE.md, rule 5).
 *
 *   node scripts/generate-brand-icons.mjs
 *
 * Which drawing goes where follows the guide: the MF tile with the STUDIO
 * patch at 64 px and above, the plain MF tile below that and in browser tabs.
 */
import sharp from "sharp";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TILE = "#111111";

const kit = (name) => readFileSync(resolve(ROOT, "brand", name));
const STUDIO_ROUNDED = kit("app-icon-mf-studio.svg");
const STUDIO_SQUARE = kit("app-icon-mf-studio-square.svg");
const PLAIN = kit("app-icon-mf-plain.svg");

/** The kit SVGs are 200 x 200; rasterising above the target size keeps edges sharp. */
function png(svg, size) {
  return sharp(svg, { density: Math.ceil((72 * size) / 200) * 2 })
    .resize(size, size)
    .png()
    .toBuffer();
}

/**
 * Maskable icons are cropped by the launcher to a circle 80% of the width, and
 * the STUDIO patch reaches past that. The square tile is therefore drawn at
 * 80% on a full-bleed tile of the same black, which keeps the whole mark
 * inside the safe zone without touching the drawing.
 */
async function maskablePng(size) {
  const inner = Math.round(size * 0.8);
  return sharp({ create: { width: size, height: size, channels: 4, background: TILE } })
    .composite([{ input: await png(STUDIO_SQUARE, inner), gravity: "centre" }])
    .png()
    .toBuffer();
}

/**
 * Minimal ICO container holding PNG-encoded entries. Windows and every current
 * browser accept PNG inside ICO, so there is no need for BMP encoding.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach(({ size, data }, i) => {
    const p = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, p + 0); // width (0 means 256)
    dir.writeUInt8(size >= 256 ? 0 : size, p + 1); // height
    dir.writeUInt8(0, p + 2); // palette
    dir.writeUInt8(0, p + 3); // reserved
    dir.writeUInt16LE(1, p + 4); // colour planes
    dir.writeUInt16LE(32, p + 6); // bits per pixel
    dir.writeUInt32LE(data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

function write(rel, buf) {
  const path = resolve(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`  ${rel}  (${buf.length.toLocaleString()} bytes)`);
}

console.log("Writing icon set:");

// Installed app (manifest "any") and notifications.
write("public/icons/icon-192.png", await png(STUDIO_ROUNDED, 192));
write("public/icons/icon-512.png", await png(STUDIO_ROUNDED, 512));
// Installed app on launchers that crop the icon themselves.
write("public/icons/icon-maskable-192.png", await maskablePng(192));
write("public/icons/icon-maskable-512.png", await maskablePng(512));
// iOS rounds the corners itself and needs an opaque square.
write("public/apple-touch-icon.png", await png(STUDIO_SQUARE, 180));
// Browser tab.
write("app/icon.png", await png(PLAIN, 512));
write(
  "app/favicon.ico",
  buildIco([
    { size: 16, data: await png(PLAIN, 16) },
    { size: 32, data: await png(PLAIN, 32) },
    { size: 48, data: await png(PLAIN, 48) },
  ]),
);

console.log("Done.");
