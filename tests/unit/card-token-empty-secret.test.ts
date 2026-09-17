// verifyCardToken must refuse to verify under an EMPTY signing secret.
//
// signCardToken refuses to MINT with an empty secret (lib/card-token.ts) — but
// lib/auth-secret.ts throws only in production, and a preview deployment or a
// local `next dev` without NEXTAUTH_SECRET has AUTH_SECRET_VALUE === "". Under
// that, the card key is HMAC("", "matflow.card.v1"): a perfectly well-defined,
// publicly computable key. Anyone who has read the file can mint a card that
// verifies. Plan X-5 A4-ii (Q5-F4).
//
// The test FORGES under the empty-derived key rather than replaying a token
// signed under a real secret: a real-secret token is refused with or without
// the guard (the keys differ), so "a previously valid token is refused" would
// be green on the mutant. Only a token that verifies without the guard can
// prove the guard is there. (Q6-F2)
//
// AUTH_SECRET_VALUE is a module-level const, so the environment is stubbed and
// the module re-imported; mutating process.env alone changes nothing.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "crypto";

const CARD_KEY_CONTEXT = "matflow.card.v1";
const CARD_KEYID_CONTEXT = "matflow.card.keyid";
const TENANT = "tenant-total-bjj";

type CardTokenModule = typeof import("@/lib/card-token");
let verifyCardToken: CardTokenModule["verifyCardToken"];

/** Exactly what the module computes when the root secret is "". */
function forgeUnderEmptyKey(memberId: string): string {
  const key = createHmac("sha256", "").update(CARD_KEY_CONTEXT).digest();
  const keyId = createHmac("sha256", key)
    .update(CARD_KEYID_CONTEXT)
    .digest()
    .toString("base64url")
    .slice(0, 6);
  const payload = {
    tenantId: TENANT,
    memberId,
    cardVersion: 1,
    purpose: "card",
    keyId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest().toString("base64url");
  return `${body}.${sig}`;
}

beforeAll(async () => {
  vi.stubEnv("NEXTAUTH_SECRET", "");
  vi.stubEnv("AUTH_SECRET", "");
  vi.resetModules();
  ({ verifyCardToken } = await import("@/lib/card-token"));
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("verifyCardToken with an empty signing secret", () => {
  it("refuses a token forged under the empty-derived key", () => {
    const forged = forgeUnderEmptyKey("member-forged");

    // Sanity: the forgery IS what an unguarded verifier would accept — its
    // signature is correct for the empty key. If this ever fails, the forgery
    // is wrong, not the guard.
    const [body, sig] = forged.split(".");
    const expected = createHmac(
      "sha256",
      createHmac("sha256", "").update(CARD_KEY_CONTEXT).digest(),
    )
      .update(body)
      .digest()
      .toString("base64url");
    expect(sig).toBe(expected);

    expect(verifyCardToken(forged, TENANT)).toEqual({ ok: false, reason: "bad-signature" });
  });
});
