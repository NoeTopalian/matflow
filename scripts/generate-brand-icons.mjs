/**
 * Generates the whole MatFlow icon set from ONE source definition.
 *
 * Every icon surface (browser tab, PWA install, Android home screen, iOS
 * touch icon) previously drifted: app/favicon.ico was switched to blue in
 * 860e78e while public/icons/*.png and public/apple-touch-icon.png stayed on
 * the black placeholder, so an installed app still showed black. Generating
 * them from a single mark makes that drift impossible.
 *
 *   node scripts/generate-brand-icons.mjs           # write the icon set
 *   node scripts/generate-brand-icons.mjs --preview # only write previews
 *
 * The mark is the skinny M: thin round-capped strokes, matching the landing
 * wordmark (components/landing/LandingNav.tsx) rather than the heavy stroked
 * M of the old placeholder.
 */
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Landing brand blue — components/landing/LandingNav.tsx. */
const BLUE = "#3d8bff";
const INK = "#ffffff";

/**
 * Stroke weight is optically sized, not linearly scaled. A stroke that reads
 * as elegantly thin at 512px disappears at 16px, where a favicon is only a
 * handful of device pixels, so small sizes get a proportionally heavier mark.
 */
function strokeFor(size) {
  if (size <= 16) return 0.095;
  if (size <= 32) return 0.075;
  if (size <= 64) return 0.06;
  return 0.048;
}

/**
 * The mark, as a stroked polyline on a 100x100 grid: left stem up, down to the
 * central vertex, up to the right apex, right stem down. Round caps and joins
 * keep the thin strokes from looking brittle at the corners.
 */
function markSvg(size, { bg = BLUE, ink = INK } = {}) {
  const w = strokeFor(size) * 100;
  const radius = 22; // maskable-safe rounded square
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${radius}" ry="${radius}" fill="${bg}"/>
  <path d="M 30 71 L 30 29 L 50 53 L 70 29 L 70 71"
        fill="none" stroke="${ink}" stroke-width="${w}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

async function png(size, opts) {
  return sharp(Buffer.from(markSvg(size, opts))).png().toBuffer();
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

const previewOnly = process.argv.includes("--preview");

console.log(previewOnly ? "Writing previews only:" : "Writing icon set:");

// Preview sheet: the mark at real tab size beside a large rendering, so the
// letterform can be judged at the size it will actually be seen.
const previewDir = ".omc/state/assess-loop/artifacts/icon-preview";
write(`${previewDir}/mark-512.png`, await png(512));
write(`${previewDir}/mark-64.png`, await png(64));
write(`${previewDir}/mark-32.png`, await png(32));
write(`${previewDir}/mark-16.png`, await png(16));

if (!previewOnly) {
  write("public/icons/icon-192.png", await png(192));
  write("public/icons/icon-512.png", await png(512));
  write("public/apple-touch-icon.png", await png(180));
  write("app/icon.png", await png(512));

  const ico = buildIco([
    { size: 16, data: await png(16) },
    { size: 32, data: await png(32) },
    { size: 48, data: await png(48) },
  ]);
  write("app/favicon.ico", ico);
}

console.log("Done.");
