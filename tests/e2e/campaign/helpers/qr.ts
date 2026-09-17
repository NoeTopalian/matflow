import { expect, type Page } from "@playwright/test";
import jsQR from "jsqr";

/**
 * Read the card token the print sheet actually rendered.
 *
 * The token exists in the DOM only inside the PNG data URL of
 * `img[data-testid="qr-<memberId>"]` (components/print/MemberCardSheet.tsx) —
 * no text copy, no data attribute — and `.env.test` carries no NEXTAUTH_SECRET,
 * so a spec cannot mint a token the running server would verify. Taking it from
 * the product instead proves the whole mint → QR → decode chain through the real
 * code, and leaves only camera optics to the physical test.
 *
 * Decoded IN THE PAGE: the `<img>` is drawn onto a canvas and its pixels handed
 * to jsQR in Node. No PNG parser in the test process — `pngjs` ships no type
 * declarations and would turn `tsc --noEmit` red.
 */
export async function readCardToken(page: Page, memberId: string): Promise<string> {
  const selector = `img[data-testid="qr-${memberId}"]`;
  const img = page.locator(selector);

  // The sheet sets `src` once `QRCode.toDataURL` resolves; the empty-src
  // placeholder before that must not be decoded.
  await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/, { timeout: 60_000 });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel) as HTMLImageElement | null;
      return !!el && el.complete && el.naturalWidth > 0;
    },
    selector,
    { timeout: 30_000 },
  );

  const { data, width, height } = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLImageElement;
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(el, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: Array.from(image.data), width: canvas.width, height: canvas.height };
  }, selector);

  const code = jsQR(Uint8ClampedArray.from(data), width, height);
  if (!code) {
    throw new Error(`jsQR could not decode the printed QR for member ${memberId} (${width}x${height})`);
  }
  return code.data;
}
