// Who gets to decide which rate-limit bucket a request lands in.
//
// `getClientIp` used to read `x-forwarded-for` first and take its LEADING
// entry. That header is set by the client, so anyone could send a fresh random
// value on every request and get a fresh bucket every time — which made every
// IP-keyed limit in the product decorative.
//
// The one that mattered: `admin/auth/login` allows 5 attempts per 15 minutes
// and is the only brake on brute-forcing MATFLOW_ADMIN_SECRET, a secret that
// bypasses operator identity, bcrypt, TOTP, lockout and audit. Unlimited
// guesses against it is total platform compromise. The same bypass drained the
// club's email budget via the kiosk waiver request and turned the limiter into
// a cheap way to fill the database, since each allowed request inserts a row.
//
// These tests fail if the trust order is reverted.

import { describe, it, expect } from "vitest";
import { getClientIp } from "@/lib/rate-limit";

function req(headers: Record<string, string>): Request {
  return new Request("https://matflow.studio/api/whatever", { headers });
}

describe("getClientIp — an attacker must not choose their own bucket", () => {
  it("ignores a client-supplied x-forwarded-for when the platform header is present", () => {
    // The attack: spoof a random leading entry to get a fresh bucket.
    const ip = getClientIp(
      req({
        "x-forwarded-for": "9.9.9.9",
        "x-vercel-forwarded-for": "203.0.113.7",
      }),
    );
    expect(ip).toBe("203.0.113.7");
    expect(ip).not.toBe("9.9.9.9");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    const ip = getClientIp(
      req({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "203.0.113.7" }),
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("takes the LAST x-forwarded-for hop, not the first, when it is all there is", () => {
    // A spoofed value is PREPENDED by the client; the trusted proxy appends the
    // real one. Taking the last entry means a forged header adds noise the
    // attacker cannot control rather than a key they choose.
    expect(getClientIp(req({ "x-forwarded-for": "9.9.9.9, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("two requests spoofing different leading hops share one bucket", () => {
    // The property that actually matters: varying the forged part must not
    // produce distinct keys.
    const a = getClientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    const b = getClientIp(req({ "x-forwarded-for": "2.2.2.2, 203.0.113.7" }));
    expect(a).toBe(b);
  });

  it("still resolves a plain single-hop header", () => {
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("falls back to a SHARED 'unknown' rather than a private allowance", () => {
    // Deliberate: a request with no proxy headers should collide with every
    // other such request, not get a bucket of its own.
    expect(getClientIp(req({}))).toBe("unknown");
  });

  it("ignores empty and whitespace-only hops instead of keying on them", () => {
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.7, , " }))).toBe("203.0.113.7");
  });
});
