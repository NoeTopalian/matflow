/**
 * Client-side image downscaling for POST /api/upload.
 *
 * A phone photo is 3–12 MB and 12 megapixels. The upload route keeps none of
 * that: it re-encodes every accepted image with sharp to a 256² avatar or a
 * ≤1600px WebP, so the bytes on the wire are pure waste — and they are waste
 * that fails, because Vercel's serverless request-body limit is ~4.5 MB and
 * the route's own cap sits below that. Shrinking in the browser is therefore
 * required rather than merely polite.
 *
 * This is a CONVENIENCE, never a boundary. Every server-side control stays
 * exactly where it is: the allow-list, the magic-byte check against the
 * declared MIME type, the auth gate, the CSRF check, and above all the sharp
 * re-encode, which strips EXIF including GPS coordinates from photographs of
 * members and children. Nothing here is trusted by the server.
 *
 * It also resolves HEIC without shipping a decoder. Canvas re-encoding emits
 * a standard format whatever the source was, provided the browser can decode
 * it — and Safari, which is where HEIC comes from, can.
 *
 * Browser-only: call it from a client component, never during render.
 */

/** Longest edge for avatars — matches PROFILE_PIC_SIZE_PX in the upload route. */
export const AVATAR_MAX_EDGE_PX = 256;

/** Longest edge for everything else — matches MAX_IMAGE_EDGE_PX in the upload route. */
export const IMAGE_MAX_EDGE_PX = 1600;

/** Re-encode quality. High enough that a downscaled photo shows no artefacts. */
const QUALITY = 0.85;

/** The types POST /api/upload will accept. Kept in step with its ALLOWED_TYPES. */
const SERVER_ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];

/**
 * An image already within the edge cap, already a type the server takes, and
 * already this small is handed back untouched. Re-encoding it would cost a
 * logo its transparency for no size win, and a gym's logo usually depends on
 * it. Well under both the route's cap and the platform's body limit.
 */
const PASS_THROUGH_MAX_BYTES = 1024 * 1024;

/**
 * Shown when the browser cannot decode the chosen file — a corrupt image, or
 * a HEIC on a browser without an Apple decoder. Exported so callers surface
 * the same words and tests can pin them.
 */
export const UNREADABLE_IMAGE_MESSAGE =
  "Couldn't read that image. Try a different photo, or save it as a JPEG and upload that.";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(UNREADABLE_IMAGE_MESSAGE));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

/** Scale to fit the longest edge within maxEdgePx, preserving aspect ratio. */
function fitWithin(
  width: number,
  height: number,
  maxEdgePx: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdgePx) return { width, height };
  const scale = maxEdgePx / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function withExtension(name: string, ext: string): string {
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return `${stem || "image"}.${ext}`;
}

/**
 * Decode `file`, cap its longest edge at `maxEdgePx`, and re-encode it.
 *
 * Returns a new File ready to post to /api/upload, or the original when it is
 * already small enough to be left alone. Rejects with
 * {@link UNREADABLE_IMAGE_MESSAGE} when the browser cannot decode the file —
 * callers must surface that message rather than swallowing it.
 */
export async function downscaleImage(file: File, maxEdgePx: number): Promise<File> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const sourceWidth = img.naturalWidth || img.width;
    const sourceHeight = img.naturalHeight || img.height;
    if (!sourceWidth || !sourceHeight) throw new Error(UNREADABLE_IMAGE_MESSAGE);

    const { width, height } = fitWithin(sourceWidth, sourceHeight, maxEdgePx);

    if (
      width === sourceWidth &&
      height === sourceHeight &&
      SERVER_ACCEPTED_TYPES.includes(file.type) &&
      file.size <= PASS_THROUGH_MAX_BYTES
    ) {
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(UNREADABLE_IMAGE_MESSAGE);
    ctx.drawImage(img, 0, 0, width, height);

    let blob = await canvasToBlob(canvas, "image/webp");
    if (blob?.type !== "image/webp") {
      // Safari before 16.4 ignores an unsupported toBlob type and silently
      // returns PNG, which for a photograph is larger than what we started
      // with. Re-encode as JPEG, over an opaque background because JPEG
      // carries no alpha channel and undrawn pixels would otherwise go black.
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      blob = await canvasToBlob(canvas, "image/jpeg");
    }
    if (!blob || (blob.type !== "image/webp" && blob.type !== "image/jpeg")) {
      throw new Error(UNREADABLE_IMAGE_MESSAGE);
    }

    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    return new File([blob], withExtension(file.name, ext), {
      type: blob.type,
      lastModified: Date.now(),
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
