import { describe, expect, it } from "vitest";
import { MAX_PUSH_ENDPOINT_LENGTH, isAllowedPushEndpoint } from "@/app/api/push/endpoint-url";

/**
 * Round 3, lane L-F. `POST /api/push/subscribe` validated its endpoint with
 * `z.string().url()`, which in zod 4.x is the WHATWG parser: `javascript:`,
 * `data:`, `file:` and every internal host were "valid URLs" and were stored
 * verbatim. Nothing sends yet, so nothing was fetched — but the column is the
 * address `webpush.sendNotification` will use the day a sender ships.
 */
describe("push endpoint validation", () => {
  it("accepts a real push-service endpoint", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/gAAA")).toBe(true);
    // Path spelling is the service's business: `..` in an https path is not a
    // traversal, nothing opens it as a file.
    expect(isAllowedPushEndpoint("https://push.example.test/a/../b")).toBe(true);
  });

  it("refuses every scheme that is not https", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ws://push.example.test/x",
      "blob:https://push.example.test/abc",
      // http, including localhost: nothing in this repo registers one, so the
      // loopback SSRF hop is closed rather than special-cased.
      "http://push.example.test/x",
      "http://localhost:3000/x",
      "http://127.0.0.1/x",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      expect(isAllowedPushEndpoint(bad), `${bad} is refused`).toBe(false);
    }
  });

  it("refuses embedded credentials and a missing host", () => {
    expect(isAllowedPushEndpoint("https://user:pass@push.example.test/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user@push.example.test/x")).toBe(false);
  });

  it("refuses anything that is not an absolute URL", () => {
    for (const bad of ["", "/../../etc/passwd", "push.example.test/x", "not a url"]) {
      expect(isAllowedPushEndpoint(bad), `${JSON.stringify(bad)} is refused`).toBe(false);
    }
  });

  it("refuses a non-string and caps the length", () => {
    for (const bad of [undefined, null, 42, {}, ["https://push.example.test/x"]]) {
      expect(isAllowedPushEndpoint(bad)).toBe(false);
    }
    const tail = "x".repeat(MAX_PUSH_ENDPOINT_LENGTH);
    const tooLong = `https://push.example.test/${tail}`;
    expect(tooLong.length).toBeGreaterThan(MAX_PUSH_ENDPOINT_LENGTH);
    expect(isAllowedPushEndpoint(tooLong)).toBe(false);
    const atCap = `https://push.example.test/`.padEnd(MAX_PUSH_ENDPOINT_LENGTH, "x");
    expect(atCap.length).toBe(MAX_PUSH_ENDPOINT_LENGTH);
    expect(isAllowedPushEndpoint(atCap)).toBe(true);
  });
});
