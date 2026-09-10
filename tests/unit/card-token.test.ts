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
import { createHmac } from "crypto";

// AUTH_SECRET_VALUE is captured at module import, so the secret must be in the
// environment before either token module is loaded.
// Bound to a `string` first so the key-separation test below can re-sign with
// the same value lib/auth-secret.ts resolves to; reading it back off
// process.env would be `string | undefined` and would not compile.
const ROOT_SECRET = process.env.NEXTAUTH_SECRET ?? "card-token-unit-test-secret";
process.env.NEXTAUTH_SECRET = ROOT_SECRET;

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

  it("the card domain does not sign with the root secret the kiosk domain uses", () => {
    // This test used to compare a card token's signature with a KIOSK token's
    // and call that "the same body". The bodies are not the same — the card
    // payload carries cardVersion and purpose — so it compared the signatures
    // of two different messages and would have passed unchanged even if both
    // modules signed with one key. It proved nothing it claimed to prove.
    //
    // Comparing like with like instead: take the card token's own body and
    // sign it the way the kiosk domain does, HMAC-SHA256 keyed by
    // AUTH_SECRET_VALUE directly (lib/kiosk-token.ts). One message, two key
    // paths. If lib/card-token.ts ever stopped deriving its key, these two
    // digests would become identical and this fails.
    const card = signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });
    const [body, cardSig] = card.split(".");
    const sameBodyUnderRootSecret = createHmac("sha256", ROOT_SECRET)
      .update(body)
      .digest()
      .toString("base64url");

    expect(cardSig).not.toBe(sameBodyUnderRootSecret);
  });
});

// A card token is a string printed on a physical object and read back by a
// scanner. Task 5c-2 de-duplicates a batch of scans by that string before it
// can reach the database, so ONE CARD MUST MEAN EXACTLY ONE STRING. The
// payload was never forgeable — the envelope was simply malleable, and a
// scanner emitting a trailing newline would have registered a member twice and
// burned a second class-pack credit.
describe("card token envelope is canonical", () => {
  const token = () => signCardToken({ tenantId: TENANT, memberId: MEMBER, cardVersion: 1 });

  it("rejects a trailing third segment instead of discarding it", () => {
    // split(".", 2) used to drop everything after the signature.
    expect(verifyCardToken(`${token()}.junk`, TENANT)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyCardToken(`${token()}.`, TENANT)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects base64 padding on the signature", () => {
    expect(verifyCardToken(`${token()}=`, TENANT)).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyCardToken(`${token()}==`, TENANT)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects whitespace inside the token", () => {
    const raw = token();
    // A scanner's trailing newline, and a space in the middle of the signature.
    expect(verifyCardToken(`${raw}\n`, TENANT)).toEqual({ ok: false, reason: "bad-signature" });
    const [body, sig] = raw.split(".");
    const spaced = `${body}.${sig.slice(0, 4)} ${sig.slice(4)}`;
    expect(verifyCardToken(spaced, TENANT)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("still accepts the one canonical spelling", () => {
    // The point is a single accepted string, not strictness for its own sake.
    const raw = token();
    expect(verifyCardToken(raw, TENANT).ok).toBe(true);
  });
});

// The same malleability was inherited FROM the kiosk helper, which the card
// token was modelled on, and the kiosk verifier sits behind a public,
// session-free endpoint. The fix was back-ported, so it is guarded here — this
// file already owns the boundary between the two domains.
describe("kiosk token envelope is canonical", () => {
  const token = () => signKioskMemberToken({ tenantId: TENANT, memberId: MEMBER });

  it("rejects a discarded third segment, padding and whitespace", () => {
    expect(verifyKioskMemberToken(`${token()}.junk`, TENANT)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyKioskMemberToken(`${token()}=`, TENANT)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifyKioskMemberToken(`${token()}\n`, TENANT)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("still verifies a token minted by the kiosk members endpoint", () => {
    // The live path: signed here, carried in a JSON body, verified there.
    const result = verifyKioskMemberToken(token(), TENANT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.memberId).toBe(MEMBER);
  });
});
