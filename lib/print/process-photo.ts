import { applyInk, estimateInk, type InkMode } from "./ink";

/**
 * The browser half of the ink work: load a member's photo, apply the chosen
 * treatment, hand back something an `<img>` can print.
 *
 * Deliberately thin. Every decision worth testing lives in `./ink.ts` as pure
 * functions over a byte array; this file only does the parts that need a real
 * canvas, so there is very little here that can be wrong without being obvious.
 *
 * **Why a canvas at all, rather than a CSS filter.** `filter: grayscale(1)`
 * would handle greyscale, but there is no CSS for halftoning — and more
 * importantly a CSS filter is a rendering instruction, so what reaches the
 * printer is still the original full-colour image plus a hint. Browsers vary in
 * whether they honour that on paper. Baking the pixels means the sheet prints
 * what the preview showed.
 *
 * **Why this is safe from canvas tainting.** `toBlobProxyUrl` (`lib/blob-url.ts`)
 * rewrites every Vercel Blob URL to a SAME-ORIGIN `/api/blob-image?url=…`, so
 * the canvas stays untainted and `toDataURL` is allowed. A cross-origin photo
 * would throw on read — which is caught below and reported as a failure rather
 * than a blank card.
 */

export interface ProcessedPhoto {
  /** What to put in `src`. For colour this is the original URL, unmodified. */
  src: string;
  /** Relative ink the untouched colour photo would lay down. The baseline. */
  inkColour: number;
  /** Relative ink this treatment lays down. */
  inkApplied: number;
}

/**
 * Longest edge of the processed bitmap, in pixels.
 *
 * The card prints the photo at 38mm. At 300dpi that is ~449px, so 512 is one
 * comfortable step above what the paper can resolve — anything larger is bytes
 * the printer throws away, multiplied by up to 300 members on one sheet run.
 */
const MAX_EDGE_PX = 512;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`photo failed to load: ${src}`));
    img.src = src;
  });
}

export async function processPhoto(
  src: string,
  mode: InkMode,
  maxEdgePx: number = MAX_EDGE_PX,
): Promise<ProcessedPhoto> {
  const img = await loadImage(src);

  const longest = Math.max(img.naturalWidth, img.naturalHeight) || maxEdgePx;
  const scale = Math.min(1, maxEdgePx / longest);
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");

  // White behind the photo. A transparent PNG would otherwise dither its
  // transparent pixels as if they were black, ringing the face in dots.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);

  // Measured BEFORE the treatment, so the comparison the owner is shown is
  // against this club's actual photos rather than a generic assumption.
  const inkColour = estimateInk(imageData.data, "colour");

  if (mode === "colour") {
    // Nothing to bake. Re-encoding would only cost quality and bytes.
    return { src, inkColour, inkApplied: inkColour };
  }

  applyInk(imageData.data, width, height, mode);
  ctx.putImageData(imageData, 0, 0);
  const inkApplied = estimateInk(imageData.data, mode);

  // PNG, not JPEG. Halftone output is 1-bit and JPEG's block transform would
  // smear the dots into grey mush — losing both the look and the ink saving.
  return { src: canvas.toDataURL("image/png"), inkColour, inkApplied };
}
