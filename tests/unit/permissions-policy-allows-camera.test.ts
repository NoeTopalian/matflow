// The app must not forbid itself the camera.
//
// next.config.ts sends a Permissions-Policy on every response. From May 2026
// it carried `camera=()` — a sensible default when nothing used the camera —
// and it was still there on 17 September, four months after the coach card
// scanner (/dashboard/scan) shipped. The header forbade the camera on every
// page, so `getUserMedia` rejected with NotAllowedError on every device, and
// the scanner's "Camera access was blocked — allow it in your browser
// settings" copy sent the coach to a setting that could not help. Nobody had
// pressed Start camera on the served app; the first end-to-end run did.
//
// A source scan rather than a rendered check on purpose: the value lives in
// config, and the failure mode is "somebody hardened the header back", which
// is visible in the file. Comments are stripped first — the explanation beside
// the value names the old string.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("Permissions-Policy and the card scanner", () => {
  const config = stripComments(readFileSync("next.config.ts", "utf8"));

  it("allows the camera for same-origin documents", () => {
    expect(config, "the scanner cannot open a camera the app has forbidden").toContain(
      String.raw`"camera=(self)"`,
    );
  });

  it("does not forbid the camera outright", () => {
    expect(config, "camera=() is the value that broke the scanner on every device").not.toContain(
      String.raw`"camera=()"`,
    );
  });

  it("still forbids the microphone — the scanner never asks for audio", () => {
    expect(config).toContain(String.raw`"microphone=()"`);
  });
});
