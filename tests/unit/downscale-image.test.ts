// @vitest-environment jsdom
//
// lib/downscale-image.ts is what makes a phone photo uploadable at all: the
// upload route's ingress cap and Vercel's ~4.5 MB request-body limit both sit
// below the size of an ordinary 12-megapixel picture. These cases pin the
// three things a caller depends on — the longest edge really is capped, the
// aspect ratio survives, and a file the browser cannot decode surfaces a
// message instead of hanging or resolving with nothing.
//
// jsdom has no image decoder and no canvas encoder, so both are stubbed. The
// stubs model the real contract rather than waving it through: toBlob reports
// the type it actually produced (Safari before 16.4 returns PNG when asked
// for WebP, which is the reason the JPEG fallback exists), and the fake image
// only reports dimensions after a successful decode.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  downscaleImage,
  AVATAR_MAX_EDGE_PX,
  IMAGE_MAX_EDGE_PX,
  UNREADABLE_IMAGE_MESSAGE,
} from "@/lib/downscale-image";

/** What the next decode attempt should do. */
let source: { width: number; height: number } | "undecodable";
/** Whether the stubbed canvas can encode WebP. */
let webpSupported: boolean;
/** Canvas dimensions seen by the last toBlob call. */
let encoded: { width: number; height: number; type: string } | null;
let fillRectCalls: number;
let revokeCalls: number;

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(objectUrl: string) {
    expect(objectUrl).toBe("blob:fake");
    queueMicrotask(() => {
      if (source === "undecodable") {
        this.onerror?.();
        return;
      }
      this.naturalWidth = source.width;
      this.naturalHeight = source.height;
      this.onload?.();
    });
  }
}

/** ~0.35 bytes per pixel — roughly what a WebP photo encode costs. */
function encodedBytes(width: number, height: number): number {
  return Math.max(1, Math.round(width * height * 0.35));
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

beforeEach(() => {
  source = { width: 3024, height: 4032 };
  webpSupported = true;
  encoded = null;
  fillRectCalls = 0;
  revokeCalls = 0;

  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:fake");
  URL.revokeObjectURL = vi.fn(() => {
    revokeCalls += 1;
  });

  HTMLCanvasElement.prototype.getContext = function () {
    return {
      drawImage: () => {},
      fillRect: () => {
        fillRectCalls += 1;
      },
      fillStyle: "",
    };
  } as unknown as typeof originalGetContext;

  HTMLCanvasElement.prototype.toBlob = function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ) {
    // A browser that cannot encode the requested type silently returns PNG.
    const produced = type === "image/webp" && !webpSupported ? "image/png" : (type ?? "image/png");
    encoded = { width: this.width, height: this.height, type: produced };
    callback(
      new Blob([new Uint8Array(encodedBytes(this.width, this.height))], { type: produced }),
    );
  } as typeof originalToBlob;
});

afterEach(() => {
  vi.unstubAllGlobals();
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
});

function phonePhoto(bytes = 8_025_740, type = "image/jpeg"): File {
  return new File([new Uint8Array(bytes)], "IMG_4021.JPG", { type });
}

describe("downscaleImage", () => {
  it("brings a 12-megapixel phone photo under the upload route's 6MB cap", async () => {
    const original = phonePhoto();
    expect(original.size).toBeGreaterThan(6 * 1024 * 1024);

    const result = await downscaleImage(original, IMAGE_MAX_EDGE_PX);

    expect(result.size).toBeLessThan(6 * 1024 * 1024);
    // And under Vercel's ~4.5MB serverless request-body limit, which the cap
    // itself cannot protect us from.
    expect(result.size).toBeLessThan(4.5 * 1024 * 1024);
    expect(result.size).toBeLessThan(original.size);
  });

  it("caps the longest edge and preserves the aspect ratio", async () => {
    source = { width: 3024, height: 4032 };

    await downscaleImage(phonePhoto(), IMAGE_MAX_EDGE_PX);

    expect(encoded).not.toBeNull();
    expect(Math.max(encoded!.width, encoded!.height)).toBe(IMAGE_MAX_EDGE_PX);
    expect(encoded!.width / encoded!.height).toBeCloseTo(3024 / 4032, 3);
    expect(encoded).toMatchObject({ width: 1200, height: 1600 });
  });

  it("caps a landscape avatar at 256 on its longest edge", async () => {
    source = { width: 4032, height: 3024 };

    await downscaleImage(phonePhoto(), AVATAR_MAX_EDGE_PX);

    expect(encoded).toMatchObject({ width: AVATAR_MAX_EDGE_PX, height: 192 });
    expect(encoded!.width / encoded!.height).toBeCloseTo(4032 / 3024, 3);
  });

  it("falls back to JPEG over an opaque background when WebP encoding is unavailable", async () => {
    webpSupported = false;

    const result = await downscaleImage(phonePhoto(), IMAGE_MAX_EDGE_PX);

    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("IMG_4021.jpg");
    // JPEG has no alpha: the canvas must be filled before the redraw or
    // transparent pixels come out black.
    expect(fillRectCalls).toBe(1);
  });

  it("surfaces a clear error when the browser cannot decode the file", async () => {
    source = "undecodable";

    await expect(downscaleImage(phonePhoto(300, "image/heic"), IMAGE_MAX_EDGE_PX)).rejects.toThrow(
      UNREADABLE_IMAGE_MESSAGE,
    );
    // The object URL is released even on the failure path.
    expect(revokeCalls).toBe(1);
  });

  it("hands back a small in-spec image untouched so a logo keeps its transparency", async () => {
    source = { width: 400, height: 120 };
    const logo = new File([new Uint8Array(9_000)], "logo.png", { type: "image/png" });

    const result = await downscaleImage(logo, IMAGE_MAX_EDGE_PX);

    expect(result).toBe(logo);
    expect(encoded).toBeNull();
  });
});
