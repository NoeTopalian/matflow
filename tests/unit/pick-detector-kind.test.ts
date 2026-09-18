// Which QR decoder the scanner runs. Until 18 Sep 2026 a browser without a
// BarcodeDetector was refused outright — and every browser on an iPhone is
// WebKit, which has none, so the demo phone read "This browser can't scan QR
// codes" while its camera worked perfectly. Frames are decoded in JS there.
import { describe, it, expect } from "vitest";
import { pickDetectorKind } from "@/lib/scan-detector";

describe("pickDetectorKind", () => {
  it("is native when the platform reads QR, or has not said yet (Android before its module downloads)", () => {
    expect(pickDetectorKind({ hasBarcodeDetector: true, formats: ["qr_code"], hasGetUserMedia: true })).toBe("native");
    expect(pickDetectorKind({ hasBarcodeDetector: true, formats: [], hasGetUserMedia: true })).toBe("native");
    expect(pickDetectorKind({ hasBarcodeDetector: true, formats: undefined, hasGetUserMedia: true })).toBe("native");
  });

  it("decodes frames on an iPhone (no BarcodeDetector, camera present)", () => {
    expect(pickDetectorKind({ hasBarcodeDetector: false, formats: undefined, hasGetUserMedia: true })).toBe("frames");
  });

  it("decodes frames when the detector exists but cannot read QR, or throws when asked", () => {
    expect(pickDetectorKind({ hasBarcodeDetector: true, formats: ["ean_13", "code_128"], hasGetUserMedia: true })).toBe("frames");
    expect(pickDetectorKind({ hasBarcodeDetector: true, formats: undefined, formatsThrew: true, hasGetUserMedia: true })).toBe("frames");
  });

  it("is unsupported only when no camera can be opened at all", () => {
    expect(pickDetectorKind({ hasBarcodeDetector: false, formats: undefined, hasGetUserMedia: false })).toBe("unsupported");
    expect(pickDetectorKind({ hasBarcodeDetector: true, formats: ["qr_code"], hasGetUserMedia: false })).toBe("unsupported");
  });
});
