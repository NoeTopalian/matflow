/**
 * Security lane D (9 Oct 2026) — SEC-050 / SEC-051: what bounds the native
 * image decoder (sharp 0.35.5 / libvips 8.18.7) on /api/upload.
 *
 * The route (app/api/upload/route.ts) runs, for every accepted image:
 *   sharp(buffer).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
 * with sharp's default options. Its only bounds before libvips are a 4 MB body,
 * a declared type in {png, jpeg, webp} and matching magic bytes. A PNG can
 * declare any dimensions; deflate of a 1-bit image reaches ~8,000 pixels per
 * input byte, so the effective bound is sharp's default limitInputPixels
 * (268,402,689 px = 0x3FFF * 0x3FFF).
 *
 * Fixtures are tiny and bounded: PNGs are built in memory, IDAT is produced by
 * a streaming deflate of zero rows (never a large buffer), and the largest
 * image actually DECODED here is 8192 x 8192 (67 MP). Images above any limit
 * are only ever header-checked (rejected before decode). Ceilings: 30 s and
 * 1.5 GB RSS growth per case; the test fails rather than continue past them.
 */
import { describe, it, expect } from "vitest";
import { deflateSync, constants as zc } from "node:zlib";
import sharp, { type SharpOptions } from "sharp";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid 1-bit greyscale PNG of zeros. `decodable=false` writes a token IDAT (header-only fixtures). */
function bombPng(width: number, height: number, decodable = true): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // greyscale
  let idat: Buffer;
  if (decodable) {
    const rowBytes = 1 + Math.ceil(width / 8);
    // Bounded: refuse to build more than 16 MB of raw scanlines in this test.
    if (rowBytes * height > 16 * 1024 * 1024) throw new Error("fixture too large to build");
    idat = deflateSync(Buffer.alloc(rowBytes * height), { level: zc.Z_BEST_COMPRESSION });
  } else {
    idat = deflateSync(Buffer.alloc(16));
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** The route's pipeline, verbatim, with optional extra sharp constructor options. */
const routePipeline = (buf: Buffer, opts: SharpOptions = {}) =>
  sharp(buf, opts).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();

async function measure(buf: Buffer, opts: SharpOptions = {}) {
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const t0 = performance.now();
  try {
    const out = await routePipeline(buf, opts);
    return { ok: true as const, ms: Math.round(performance.now() - t0), rssGrowthMB: Math.round((peak - rss0) / 1048576), outBytes: out.length };
  } catch (e) {
    return { ok: false as const, ms: Math.round(performance.now() - t0), rssGrowthMB: Math.round((peak - rss0) / 1048576), error: (e as Error).message };
  } finally {
    clearInterval(timer);
  }
}

const DEFAULT_LIMIT = 0x3fff * 0x3fff; // 268,402,689 — sharp 0.35 default limitInputPixels
const PROPOSED_LIMIT = 50_000_000;
const results: Record<string, unknown> = {};

describe("SEC-050/051 image decoder bounds on the upload pipeline", () => {
  it("header check: a PNG declaring more pixels than the default limit is refused before decode, fast", async () => {
    const png = bombPng(20_000, 20_000, false); // 400 MP declared, ~100-byte file
    expect(png.length).toBeLessThan(200);
    const r = await measure(png);
    results.over_default_limit_400MP = { inputBytes: png.length, ...r };
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toMatch(/pixel limit/i);
    expect(r.ms).toBeLessThan(2_000);
  });

  it("default limit is the only pixel bound: a 16000 x 16000 header (256 MP, under the default) passes the header check", async () => {
    const meta = await sharp(bombPng(16_000, 16_000, false)).metadata();
    expect(meta.width! * meta.height!).toBeLessThan(DEFAULT_LIMIT);
    results.under_default_limit_256MP_header = { width: meta.width, height: meta.height, acceptedByHeaderCheck: true };
  });

  it("measured decode cost and decompression ratio of bounded 1-bit PNGs (2048², 4096², 8192²)", async () => {
    for (const side of [2048, 4096, 8192]) {
      const png = bombPng(side, side);
      const r = await measure(png);
      const px = side * side;
      results[`decode_${side}`] = { inputBytes: png.length, pixels: px, pixelsPerInputByte: Math.round(px / png.length), ...r };
      expect(r.ok).toBe(true);
      expect(r.ms).toBeLessThan(30_000);
      expect(r.rssGrowthMB).toBeLessThan(1_536);
    }
    const big = results.decode_8192 as { ms: number; pixels: number; inputBytes: number };
    // Linear extrapolation to the default limit (stated as an estimate, not a measurement).
    results.extrapolated_at_default_limit = {
      pixels: DEFAULT_LIMIT,
      estimatedMs: Math.round((big.ms * DEFAULT_LIMIT) / big.pixels),
      estimatedInputBytes: Math.round((big.inputBytes * DEFAULT_LIMIT) / big.pixels),
    };
  }, 120_000);

  it("PROPOSED bound: limitInputPixels 50 MP refuses a 67 MP image before decode and still accepts a 48 MP phone frame header", async () => {
    const r = await measure(bombPng(8192, 8192, false), { limitInputPixels: PROPOSED_LIMIT });
    results.proposed_limit_67MP = r;
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toMatch(/pixel limit/i);
    const meta = await sharp(bombPng(8000, 6000, false), { limitInputPixels: PROPOSED_LIMIT }).metadata();
    expect(meta.width! * meta.height!).toBeLessThanOrEqual(PROPOSED_LIMIT);
    console.log(`[sec-d image bounds] ${JSON.stringify(results)}`);
  });

  it("type confusion: libvips loads by CONTENT — a GIF/SVG/TIFF body is refused by the route's magic-byte check before sharp sees it", () => {
    const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
      "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
      "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
      "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
    };
    const bodies = {
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      gif: Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
      tiff: Buffer.from([0x49, 0x49, 0x2a, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]),
      html: Buffer.from("<html><script>alert(1)</script></html>"),
    };
    for (const [kind, body] of Object.entries(bodies)) {
      for (const [declared, ok] of Object.entries(MAGIC)) expect(ok(body), `${kind} declared ${declared}`).toBe(false);
    }
  });
});
