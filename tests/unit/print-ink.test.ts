// The ink treatments that make a 200-card print run survivable.
//
// A card renders the member's photo at 38mm × 38mm — roughly a 450×450px block
// of near-solid coverage at print resolution. Two hundred of those cockles the
// paper, can smear before it dries, and drains cartridges. Noe raised it after
// looking at a sheet: "I worry the ink heavy pictures could be an issue."
//
// These are pure functions over a flat RGBA byte array — the shape
// `getImageData().data` gives you — so the arithmetic is tested here in Node and
// the browser half stays a thin canvas wrapper with nothing to get wrong.
//
// The load-bearing assertion is the LAST describe: halftone must actually lay
// down less ink than greyscale, which must lay down less than colour. Without
// it every function here could be individually correct and the feature still
// fail at the only thing it was built to do.

import { describe, it, expect } from "vitest";
import {
  luma,
  toGreyscale,
  orderedDither,
  applyInk,
  estimateInk,
  relativeInkPercent,
  BAYER_8X8,
  INK_MODES,
  PHOTO_MODES,
} from "@/lib/print/ink";

/** An RGBA buffer of a solid colour. */
function solid(width: number, height: number, r: number, g: number, b: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < width * height; i++) out.push(r, g, b, 255);
  return out;
}

/** A left-to-right black→white ramp, i.e. every grey level a photo would have. */
function ramp(width: number, height: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / Math.max(1, width - 1)) * 255);
      out.push(v, v, v, 255);
    }
  }
  return out;
}

describe("luma", () => {
  it("uses Rec. 601, so the preview and the processed bytes agree", () => {
    // Same coefficients the browser's `filter: grayscale()` uses. If these
    // drifted, the on-screen preview would stop predicting the print.
    expect(luma(255, 255, 255)).toBeCloseTo(255, 5);
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(255, 0, 0)).toBeCloseTo(76.245, 3);
    expect(luma(0, 255, 0)).toBeCloseTo(149.685, 3);
    expect(luma(0, 0, 255)).toBeCloseTo(29.07, 3);
  });
});

describe("BAYER_8X8", () => {
  it("is a complete 0-63 permutation", () => {
    // A duplicated or missing entry would quietly band the output — visible as
    // stripes across every face, and easy to miss in a thumbnail.
    const flat = BAYER_8X8.flatMap((row) => [...row]).sort((a, b) => a - b);
    expect(flat).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(BAYER_8X8).toHaveLength(8);
    for (const row of BAYER_8X8) expect(row).toHaveLength(8);
  });
});

describe("toGreyscale", () => {
  it("collapses the three channels to one value", () => {
    const px = solid(2, 1, 255, 0, 0);
    toGreyscale(px);
    expect(px[0]).toBe(px[1]);
    expect(px[1]).toBe(px[2]);
    expect(px[0]).toBe(76); // round(255 * 0.299)
  });

  it("leaves alpha alone", () => {
    const px = solid(1, 1, 10, 200, 30);
    px[3] = 128;
    toGreyscale(px);
    expect(px[3]).toBe(128);
  });

  it("leaves pure white and pure black where they are", () => {
    const white = solid(1, 1, 255, 255, 255);
    toGreyscale(white);
    expect(white.slice(0, 3)).toEqual([255, 255, 255]);
    const black = solid(1, 1, 0, 0, 0);
    toGreyscale(black);
    expect(black.slice(0, 3)).toEqual([0, 0, 0]);
  });
});

describe("orderedDither", () => {
  it("emits ONLY pure black or pure white", () => {
    // The whole ink saving rests on this: dots, never partial tones.
    const px = ramp(32, 32);
    orderedDither(px, 32, 32);
    for (let i = 0; i < px.length; i += 4) {
      expect([0, 255]).toContain(px[i]);
      expect(px[i + 1]).toBe(px[i]);
      expect(px[i + 2]).toBe(px[i]);
    }
  });

  it("is deterministic — same input, same bytes", () => {
    // This is why ordered dithering was chosen over Floyd-Steinberg: an
    // error-diffusing filter makes every pixel depend on the ones before it, so
    // exact assertions become brittle and 200 photos get slower.
    const a = ramp(16, 16);
    const b = ramp(16, 16);
    orderedDither(a, 16, 16);
    orderedDither(b, 16, 16);
    expect(a).toEqual(b);
  });

  it("keeps white white and black black", () => {
    const white = solid(8, 8, 255, 255, 255);
    orderedDither(white, 8, 8);
    expect([...white].filter((_, i) => i % 4 === 0).every((v) => v === 255)).toBe(true);

    const black = solid(8, 8, 0, 0, 0);
    orderedDither(black, 8, 8);
    expect([...black].filter((_, i) => i % 4 === 0).every((v) => v === 0)).toBe(true);
  });

  it("renders mid-grey as roughly half dots, not a solid block", () => {
    // A flat 50% grey must become a chequer, which is what makes a face
    // readable rather than a silhouette.
    const px = solid(64, 64, 128, 128, 128);
    orderedDither(px, 64, 64);
    let black = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] === 0) black++;
    const fraction = black / (64 * 64);
    expect(fraction).toBeGreaterThan(0.35);
    expect(fraction).toBeLessThan(0.65);
  });

  it("gets darker as the input gets darker", () => {
    const darkness = (v: number) => {
      const px = solid(32, 32, v, v, v);
      orderedDither(px, 32, 32);
      let black = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] === 0) black++;
      return black;
    };
    expect(darkness(60)).toBeGreaterThan(darkness(128));
    expect(darkness(128)).toBeGreaterThan(darkness(200));
  });
});

describe("applyInk", () => {
  it("leaves colour untouched", () => {
    const px = solid(4, 4, 200, 30, 90);
    const before = [...px];
    applyInk(px, 4, 4, "colour");
    expect(px).toEqual(before);
  });

  it("routes greyscale and halftone to their treatments", () => {
    const grey = solid(4, 4, 200, 30, 90);
    applyInk(grey, 4, 4, "greyscale");
    expect(grey[0]).toBe(grey[1]);
    expect([0, 255]).not.toContain(grey[0]); // a real grey, not thresholded

    const half = ramp(16, 16);
    applyInk(half, 16, 16, "halftone");
    for (let i = 0; i < half.length; i += 4) expect([0, 255]).toContain(half[i]);
  });
});

describe("the claim the feature is actually built on", () => {
  it("halftone uses less ink than greyscale, which uses less than colour", () => {
    // If this ever inverts, every word of the UI is a lie and the owner is
    // choosing the expensive option believing it is the cheap one.
    const photoish = () => {
      // Mid-tone-heavy, coloured — a face against a wall.
      const out: number[] = [];
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const v = 90 + ((x * 3 + y * 2) % 110);
          out.push(v, Math.round(v * 0.8), Math.round(v * 0.7), 255);
        }
      }
      return out;
    };

    const colour = photoish();
    const grey = photoish();
    const half = photoish();
    applyInk(grey, 64, 64, "greyscale");
    applyInk(half, 64, 64, "halftone");

    const colourInk = estimateInk(colour, "colour");
    const greyInk = estimateInk(grey, "greyscale");
    const halfInk = estimateInk(half, "halftone");

    expect(greyInk).toBeLessThan(colourInk);
    expect(halfInk).toBeLessThan(greyInk);
  });

  it("reports a sane percentage to the owner", () => {
    expect(relativeInkPercent(0.9, 0.3)).toBe(33);
    expect(relativeInkPercent(0.9, 0.9)).toBe(100);
    // Never 0% — that reads as "it will not print".
    expect(relativeInkPercent(0.9, 0)).toBe(1);
    // No colour ink at all (a blank white photo) cannot divide by zero.
    expect(relativeInkPercent(0, 0)).toBe(100);
  });
});

describe("the choices offered to the owner", () => {
  it("offers exactly the three ink modes, each with a reason", () => {
    expect(INK_MODES.map((m) => m.value)).toEqual(["colour", "greyscale", "halftone"]);
    for (const m of INK_MODES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
    }
  });

  it("offers photo, initials and name-only", () => {
    // "optional for image or just name" — all three are first-class, not a
    // fallback that only appears when something fails.
    expect(PHOTO_MODES.map((m) => m.value)).toEqual(["photo", "initials", "none"]);
  });
});
