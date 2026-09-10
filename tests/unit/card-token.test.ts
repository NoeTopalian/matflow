// Card token — key separation is the whole point of this file.
//
// The card token is printed on a laminated card that members carry, photograph
// and lose. The kiosk token is accepted by an UNAUTHENTICATED endpoint
// (`POST /api/kiosk/[token]/checkin`). If those two shared a signing key, a
// photograph of anyone's card would let a stranger check that member in and
// burn their class-pack credits. The "must not verify as a kiosk token" case
// below is the regression guard for that; everything else is round-trip and
// tamper coverage.

import { describe, it, expect, beforeAll } from "vitest";

// AUTH_SECRET_VALUE is captured at module import, so the secret must be in the
// environment before either token module is loaded.
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "card-token-unit-test-secret";

type CardTokenModule = typeof import("@/lib/card-token");
type KioskTokenModule = typeof import("@/lib/kiosk-token");

let signCardToken: CardTokenModule["signCardToken"];
let verifyCardToken: CardTokenModule["verifyCardToken"];
let signKioskMemberToken: KioskTokenModule["signKioskMemberToken"];
let verifyKioskMemberToken: KioskTokenModule["verifyKioskMemberToken"];

beforeAll(async () => {
  ({ signCardToken, verifyCardToken } = await import("@/lib/card-token"));
  ({ signKioskMemberToken, verifyKioskMemberToken } = await import("@/lib/kiosk-token"));
});

const TENANT = "tenant-total-bjj";
const OTHER_TENANT = "tenant-someone-else";
const MEMBER = "member-abc123";

describe("card token round trip", () => {
  it("verifies a freshly signed token and returns the member", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const result = verifyCardToken(token, TENANT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.memberId).toBe(MEMBER);
  });

  it("defaults to a multi-year expiry", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const [body] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const yearsAhead = (payload.exp - Math.floor(Date.now() / 1000)) / (365 * 24 * 60 * 60);
    expect(yearsAhead).toBeGreaterThan(2);
  });

  it("carries purpose: card in the payload", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 3 });
    const [body] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    expect(payload.purpose).toBe("card");
  });
});

describe("card token cardVersion", () => {
  it("surfaces the signed cardVersion on verify", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 7 });
    const result = verifyCardToken(token, TENANT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cardVersion).toBe(7);
  });

  it("lets a caller detect a stale card after the member's version is bumped", () => {
    // A card printed at version 2 is lost; staff bump Member.cardVersion to 3.
    const printed = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 2 });
    const result = verifyCardToken(printed, TENANT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const currentVersionInDb = 3;
    expect(result.cardVersion).not.toBe(currentVersionInDb);
  });
});

describe("card token rejection cases", () => {
  it("rejects a tampered body", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.memberId = "member-someone-else";
    const forgedBody = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const result = verifyCardToken(`${forgedBody}.${sig}`, TENANT);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered signature", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const [body, sig] = token.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    const result = verifyCardToken(`${body}.${flipped}`, TENANT);
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token minted for another tenant", () => {
    const token = signCardToken({ tenantId: OTHER_TENANT, memberId: MEMBER, cardVersion: 1 });
    const result = verifyCardToken(token, TENANT);
    expect(result).toEqual({ ok: false, reason: "tenant-mismatch" });
  });

  it("rejects an expired token", () => {
    const token = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 }, -60);
    const result = verifyCardToken(token, TENANT);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed input", () => {
    expect(verifyCardToken("", TENANT)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyCardToken("no-dot-here", TENANT)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyCardToken(".", TENANT)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("key separation between the card and kiosk domains", () => {
  it("a card token is REJECTED by verifyKioskMemberToken", () => {
    // The attack this prevents: photograph a member's laminated card, POST the
    // QR contents to the public kiosk check-in endpoint, forge attendance.
    const card = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const asKiosk = verifyKioskMemberToken(card, TENANT);
    expect(asKiosk.ok).toBe(false);
    if (asKiosk.ok) return;
    expect(asKiosk.reason).toBe("bad-signature");
  });

  it("a kiosk token is REJECTED by verifyCardToken", () => {
    const kiosk = signKioskMemberToken({ tenantId: TENANT, memberId: MEMBER });
    const asCard = verifyCardToken(kiosk, TENANT);
    expect(asCard.ok).toBe(false);
    if (asCard.ok) return;
    expect(asCard.reason).toBe("bad-signature");
  });

  it("the two domains produce different signatures for the same body", () => {
    const card = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const kiosk = signKioskMemberToken({ tenantId: TENANT, memberId: MEMBER });
    expect(card.split(".")[1]).not.toBe(kiosk.split(".")[1]);
  });
});
