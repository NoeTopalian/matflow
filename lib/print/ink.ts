/**
 * Ink treatments for printed member cards.
 *
 * ## Why this exists
 *
 * A card renders the member's photo at **38mm × 38mm**
 * (`components/print/MemberCardSheet.tsx`). At print resolution that is roughly
 * a 450×450px block of near-solid coverage, per member. On a 200-card run that
 * has three real costs: the paper cockles and goes wavy, the ink can smear
 * before it dries, and cartridges drain fast. On plain paper rather than photo
 * paper it also goes muddy and bleeds at the edges.
 *
 * Nothing about the card's layout is at fault — the millimetre arithmetic is
 * exact and the QR is sized from its module pitch. **The ink is the problem**,
 * so this is where it is solved.
 *
 * ## Why ordered dithering and not Floyd–Steinberg
 *
 * Floyd–Steinberg gives a slightly better-looking photo. It is also
 * error-DIFFUSING: every pixel depends on the ones before it, so a one-pixel
 * change at the top-left alters the whole image. That makes exact assertions in
 * a test brittle, and it is slower over 200 photos. Ordered (Bayer) dithering
 * is a pure function of (x, y, value) — the same input always gives the same
 * output, a test can assert exact bytes, and at card size the regular dot grid
 * reads as a deliberately printed ID card rather than a degraded photo.
 *
 * Everything here works on a flat RGBA byte array, which is what
 * `CanvasRenderingContext2D.getImageData().data` gives you — so the browser
 * half stays a thin wrapper and all the logic is testable in Node.
 */

export type InkMode = "colour" | "greyscale" | "halftone";
export type PhotoMode = "photo" | "initials" | "none";

export const INK_MODES: ReadonlyArray<{
  value: InkMode;
  label: string;
  hint: string;
}> = [
  // Hints describe the TRADE, never a number — the panel measures the real
  // percentage from the actual photos and shows that instead. A hard-coded
  // figure here would be wrong for any club whose photos are darker or lighter
  // than whatever sample it was written against.
  {
    value: "colour",
    label: "Colour",
    hint: "Full colour. Three cartridges at once — heaviest on ink, and the most likely to cockle plain paper.",
  },
  {
    value: "greyscale",
    label: "Greyscale",
    hint: "Black cartridge only, so roughly a third of the ink. Still a continuous dark block on the page.",
  },
  {
    value: "halftone",
    label: "Halftone dots",
    hint: "Printed-dot look. Least ink, and the only one that lays dots with dry paper between them — which is what stops a long run going wavy.",
  },
];

export const PHOTO_MODES: ReadonlyArray<{
  value: PhotoMode;
  label: string;
  hint: string;
}> = [
  { value: "photo", label: "Photo", hint: "The member's picture." },
  { value: "initials", label: "Initials", hint: "Their initials instead. No photo ink at all." },
  { value: "none", label: "Name only", hint: "No picture block. Name, belt and QR fill the card." },
];

/**
 * Rec. 601 luma. Matches what browsers use for `filter: grayscale()`, so the
 * on-screen preview and the processed bytes agree.
 */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * The classic 8×8 Bayer matrix, in threshold order 0–63.
 *
 * 8×8 rather than 4×4 deliberately: it resolves 65 grey levels instead of 17,
 * which is the difference between a face and a posterised smear at this size.
 */
export const BAYER_8X8: readonly (readonly number[])[] = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

/** Convert RGBA pixels to grey in place. Alpha is untouched. */
export function toGreyscale(data: Uint8ClampedArray | number[]): void {
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.round(luma(data[i], data[i + 1], data[i + 2]));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

/**
 * How much halftone lightens mid-tones before thresholding. Below 1 = brighter.
 *
 * **This is where halftone's ink saving actually comes from, and it is worth
 * being exact about it.** Ordered dithering PRESERVES average tone — that is
 * what makes it look like the original — so a dithered photo and a greyscale
 * photo of the same image lay down almost the same amount of ink. A first
 * version of this file claimed halftone was dramatically cheaper; the test
 * asserting so failed, and it was the claim that was wrong, not the code.
 *
 * So the saving is made real rather than asserted: a gamma lift pushes the
 * mid-tones — which is where nearly all the ink goes, since shadows are a small
 * fraction of a face and highlights cost nothing — toward white before the
 * threshold. 0.7 measurably reduces coverage while leaving a face readable at
 * 38mm.
 *
 * The other benefit needs no arithmetic and is the one Noe actually asked about
 * ("soggy"): the output is 1-bit, so the printer lays discrete dots with dry
 * paper between them instead of flooding a continuous mid-tone. That is what
 * stops an A4 sheet cockling on a 200-card run.
 */
const HALFTONE_LIFT = 0.7;

/**
 * Ordered-dither RGBA pixels to pure black and white in place.
 *
 * `contrast` expands around mid-grey first. Gym photos are often phone snaps in
 * bad hall lighting, and a straight threshold turns those into a dark blob; the
 * lift keeps the face readable without adding ink, because the output is still
 * only ever black or white.
 */
export function orderedDither(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  contrast = 1.15,
  lift = HALFTONE_LIFT,
): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let grey = luma(data[i], data[i + 1], data[i + 2]);
      // Expand around mid-grey, then clamp.
      grey = (grey - 128) * contrast + 128;
      if (grey < 0) grey = 0;
      else if (grey > 255) grey = 255;
      // Then lighten the mid-tones — the actual ink reduction.
      grey = 255 * Math.pow(grey / 255, lift);

      // +0.5 centres the cell so an even grey does not bias entirely one way.
      const threshold = ((BAYER_8X8[y & 7][x & 7] + 0.5) / 64) * 255;
      const v = grey > threshold ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
}

/** Apply the chosen treatment in place. `colour` is deliberately a no-op. */
export function applyInk(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  mode: InkMode,
): void {
  if (mode === "greyscale") toGreyscale(data);
  else if (mode === "halftone") orderedDither(data, width, height);
}

/**
 * Relative ink laid down, where 1 is "as much as full colour would use".
 *
 * A rough model, and honest about being one: an inkjet lays cyan, magenta and
 * yellow separately, so a colour image costs roughly the sum of the three
 * channels' darkness, while greyscale and halftone use the black cartridge
 * alone. Good enough to tell an owner that one option costs a fifth of another,
 * which is the decision they are actually making — not good enough to predict
 * millilitres, which is why the UI says "about".
 */
export function estimateInk(
  data: Uint8ClampedArray | number[],
  mode: InkMode,
): number {
  let total = 0;
  const pixels = data.length / 4;
  if (pixels === 0) return 0;

  if (mode === "colour") {
    for (let i = 0; i < data.length; i += 4) {
      total += (255 - data[i]) / 255 + (255 - data[i + 1]) / 255 + (255 - data[i + 2]) / 255;
    }
    return total / pixels / 3;
  }

  // Single cartridge: darkness of the grey channel only, and a third of the
  // cost per unit of darkness because only one ink is being laid.
  for (let i = 0; i < data.length; i += 4) {
    total += (255 - data[i]) / 255;
  }
  return total / pixels / 3;
}

/**
 * What the owner is told, as a percentage of what full colour would use.
 *
 * Clamped to a floor of 1 so a very light halftone never reports "0% of colour",
 * which reads as "it will not print".
 */
export function relativeInkPercent(colourInk: number, modeInk: number): number {
  if (colourInk <= 0) return 100;
  return Math.max(1, Math.round((modeInk / colourInk) * 100));
}
