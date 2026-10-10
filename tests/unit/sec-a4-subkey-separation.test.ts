// R6-N2 (security campaign iteration 2, lane A4, 10 Oct 2026) — domain separation between the root secret's raw
// signers and the sub-keys derived from it. Adopts review R6's K1 cell (docs/security/evidence/R6/zz-r6-d3-probe-db,
// "R6-K1 KEY SEPARATION") per context, as a unit file with the real route and the real cookie code.
//
// THE FINDING. Sub-keys are HMAC(root, context) — provenance "matflow.import-mapping-provenance.v2", kiosk
// "matflow.kiosk.v1", card "matflow.card.v1". POST /api/account/pending-tenant signed its cookie as HMAC(root, slug)
// and handed the signature to the caller, so a Tenant whose slug equals a context (a raw INSERT — the API slug
// validators refuse dots, the database does not) turned the cookie into that sub-key whenever Google sign-in is on.
//
// WHAT CHANGED (and what did not — no deployed token is invalidated):
//   UNCHANGED, byte for byte: the provenance, kiosk and card sub-keys and everything signed with them (fixed-key
//     vectors below, computed on 1bad6ee/7ce179c before the change); hashToken() for every input that is not exactly
//     a registered key context, so every stored token hash, recovery code, kiosk/leaderboard token and DSAR email
//     hash keeps matching.
//   CHANGED: the pending-tenant cookie is now HMAC(HMAC(root, "matflow.pending-tenant-cookie.v1"),
//     "pending-tenant:v1:" + slug). A cookie minted before the change no longer verifies — harmless: its maxAge is
//     300 s (5 minutes) and the only effect is one more "Continue with Google" click. hashToken(x) for x EXACTLY equal
//     to a registered context is computed over a reserved prefix instead, so it can never output a sub-key.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FIXED = "secA4-fixed-vector-key-0123456789abcdef0123456789abcdef";
const env = vi.hoisted(() => {
  const saved = { NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET, AUTH_SECRET: process.env.AUTH_SECRET, ENABLE_GOOGLE_OAUTH: process.env.ENABLE_GOOGLE_OAUTH };
  process.env.NEXTAUTH_SECRET = "secA4-fixed-vector-key-0123456789abcdef0123456789abcdef";
  delete process.env.AUTH_SECRET;
  return { saved };
});
const JAR = vi.hoisted(() => new Map<string, string>());
const planted = vi.hoisted(() => new Set<string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (JAR.has(n) ? { name: n, value: JAR.get(n)! } : undefined),
    set: (o: { name: string; value: string }) => {
      JAR.set(o.name, o.value);
    },
    delete: (n: string) => {
      JAR.delete(n);
    },
  }),
}));
// The planted Tenant rows (prerequisite: a raw INSERT). Nothing connects.
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async (fn: (tx: unknown) => unknown) =>
    fn({ tenant: { findUnique: async ({ where }: { where: { slug: string } }) => (planted.has(where.slug) ? { id: `t-${where.slug}` } : null) } }),
}));

import { POST } from "@/app/api/account/pending-tenant/route";
import { readPendingTenantSlug } from "@/lib/pending-tenant-cookie";
import { hashToken } from "@/lib/token-hash";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import * as ai from "@/lib/attendance-import";
import { signKioskMemberToken, verifyKioskMemberToken } from "@/lib/kiosk-token";
import { signCardToken, verifyCardToken, CARD_KEY_CONTEXT } from "@/lib/card-token";

const CONTEXTS = {
  provenance: "matflow.import-mapping-provenance.v2",
  kiosk: "matflow.kiosk.v1",
  card: "matflow.card.v1",
  "pending-tenant": "matflow.pending-tenant-cookie.v1",
} as const;
const subKey = (ctx: string) => createHmac("sha256", FIXED).update(ctx).digest();
const b64 = (b: Buffer) => b.toString("base64url");

async function mint(slug: string): Promise<{ status: number; cookie: string }> {
  JAR.clear();
  const res = await POST(
    new Request("http://localhost/api/account/pending-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantSlug: slug }),
    }),
  );
  return { status: res.status, cookie: JAR.get("pendingTenantSlug") ?? "" };
}
const sigOf = (cookie: string) => Buffer.from(cookie.slice(cookie.lastIndexOf(".") + 1), "base64url");

beforeAll(() => {
  process.env.ENABLE_GOOGLE_OAUTH = "true";
  for (const c of Object.values(CONTEXTS)) planted.add(c);
  planted.add("seca4-club");
});
afterAll(() => {
  for (const [k, v] of Object.entries(env.saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("harness", () => {
  it("signs with the fixed synthetic key (vectors below are meaningless otherwise)", () => {
    expect(AUTH_SECRET_VALUE).toBe(FIXED);
  });
  it("the card module's exported context is the one this file tests", () => {
    expect(CARD_KEY_CONTEXT).toBe(CONTEXTS.card);
    expect(ai.PROVENANCE_KEY_CONTEXT).toBe(CONTEXTS.provenance);
  });
});

describe("positive controls: the cookie still works", () => {
  it("an ordinary club's cookie is minted (200) and reads back as the slug", async () => {
    const { status, cookie } = await mint("seca4-club");
    expect(status).toBe(200);
    expect(cookie.startsWith("seca4-club.")).toBe(true);
    expect(await readPendingTenantSlug()).toBe("seca4-club");
  });
  it("a tampered signature reads back as nothing", async () => {
    const { cookie } = await mint("seca4-club");
    JAR.set("pendingTenantSlug", cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA"));
    expect(await readPendingTenantSlug()).toBeNull();
  });
  it("the cookie signature is the documented derivation: HMAC(HMAC(root, pending-tenant context), 'pending-tenant:v1:' + slug)", async () => {
    const { cookie } = await mint("seca4-club");
    const k = subKey(CONTEXTS["pending-tenant"]);
    expect(b64(sigOf(cookie))).toBe(b64(createHmac("sha256", k).update("pending-tenant:v1:seca4-club").digest()));
  });
  it("documented change: a cookie in the OLD format (HMAC(root, slug)) no longer verifies (5-minute cookie; one more click)", async () => {
    JAR.set("pendingTenantSlug", `seca4-club.${b64(createHmac("sha256", FIXED).update("seca4-club").digest())}`);
    expect(await readPendingTenantSlug()).toBeNull();
  });
  it("Google sign-in off → 503 and no cookie (unchanged)", async () => {
    process.env.ENABLE_GOOGLE_OAUTH = "false";
    try {
      const { status, cookie } = await mint("seca4-club");
      expect(status).toBe(503);
      expect(cookie).toBe("");
    } finally {
      process.env.ENABLE_GOOGLE_OAUTH = "true";
    }
  });
});

describe("R6-K1 per context: a slug equal to the context does not hand out the sub-key", () => {
  for (const [name, ctx] of Object.entries(CONTEXTS)) {
    it(`${name}: the route answers 200 for the planted slug, and the cookie signature is NOT HMAC(root, "${ctx}")`, async () => {
      const { status, cookie } = await mint(ctx);
      expect(status, "precondition: the planted row is found and a cookie is minted").toBe(200);
      expect(cookie.length).toBeGreaterThan(0);
      expect(b64(sigOf(cookie))).not.toBe(b64(subKey(ctx)));
    });
    it(`${name}: hashToken("${ctx}") is not the sub-key either`, () => {
      expect(hashToken(ctx)).not.toBe(subKey(ctx).toString("hex"));
    });
  }

  it("a planted dotted slug's cookie verifies as NO sub-key: kiosk and card tokens and a provenance proof minted with it are refused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
    try {
      for (const ctx of Object.values(CONTEXTS)) {
        const leaked = sigOf((await mint(ctx)).cookie);
        for (const other of Object.values(CONTEXTS)) expect(leaked.equals(subKey(other)), `${ctx} vs ${other}`).toBe(false);
        // Kiosk member token forged with the cookie signature as the key.
        const kBody = b64(Buffer.from(JSON.stringify({ tenantId: "t-secA4", memberId: "m-mal", exp: 1791591000 })));
        const kTok = `${kBody}.${b64(createHmac("sha256", leaked).update(kBody).digest())}`;
        expect(verifyKioskMemberToken(kTok, "t-secA4").ok, `kiosk forged from ${ctx}`).toBe(false);
        // Card token forged the same way (payload copied from a real card so only the signature differs).
        const real = signCardToken({ tenantId: "t-secA4", memberId: "m-mal", cardVersion: 1 });
        const cBody = real.split(".")[0];
        const cTok = `${cBody}.${b64(createHmac("sha256", leaked).update(cBody).digest())}`;
        expect(verifyCardToken(real, "t-secA4").ok, "control: the real card verifies").toBe(true);
        expect(verifyCardToken(cTok, "t-secA4").ok, `card forged from ${ctx}`).toBe(false);
        // Provenance decision minted with it.
        const mapping = { id: "map-mal", kind: "person", sourceKey: "secA4|victim", action: "member", targetId: "m-mal" };
        const digest = ai.sourceKeyDigest("person", mapping.sourceKey);
        const at = Date.now() - 1000;
        const fields = { tenantId: "t-secA4", mappingId: mapping.id, kind: "person", sourceKeyDigest: digest, before: null, after: { action: "member", targetId: "m-mal" }, createdAtMs: at, prev: ai.MAPPING_PROVENANCE_GENESIS };
        const forged = createHmac("sha256", leaked).update(ai.provenanceCanonical(fields)).digest("hex");
        const row = (proof: string) => ({ id: "r1", entityId: mapping.id, atMs: at, metadata: { kind: "person", sourceKeyDigest: digest, before: null, after: fields.after, prev: ai.MAPPING_PROVENANCE_GENESIS, proof } });
        const legit = createHmac("sha256", subKey(CONTEXTS.provenance)).update(ai.provenanceCanonical(fields)).digest("hex");
        expect(ai.provenanceVouches("t-secA4", mapping, [row(legit)]), "control: the real sub-key's proof vouches").toBe(true);
        expect(ai.provenanceVouches("t-secA4", mapping, [row(forged)]), `provenance forged from ${ctx}`).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("no deployed token is invalidated: fixed-key vectors computed BEFORE the change (1bad6ee / 7ce179c)", () => {
  const V = {
    sourceKeyDigest: "87ae0819f1f889b32b7d1a67dd6bd563fb44ea51a25043a1ba1dd7a9df2b9d4c",
    provenanceProof: "131ab3e9760d7006f18bef2fdc251aee85f6100e6b43eaead9a997d931419364",
    kiosk: "eyJ0ZW5hbnRJZCI6InQtc2VjQTQiLCJtZW1iZXJJZCI6Im0tc2VjQTQiLCJleHAiOjE3OTE1OTEwMDB9.jiLH1t13GLRU9V21ZyzfRECMGhphs-7Gm-2VBQcbbVE",
    card: "eyJ0ZW5hbnRJZCI6InQtc2VjQTQiLCJtZW1iZXJJZCI6Im0tc2VjQTQiLCJjYXJkVmVyc2lvbiI6MywicHVycG9zZSI6ImNhcmQiLCJrZXlJZCI6IjhkaUpmRiIsImV4cCI6MTk0OTI3MDQwMH0.9OCWMUGKoFXcM8CNYOkTuI-_RhHsQfLK2G7Y-gk4VLU",
    hashTokenSample: "dba41b9011ef6f2a6d7670ff020dc14bbd01c6548c712627dc96d8053710085f",
    hashTokenEmail: "df549330c21beb7ff84e8a3145dd95d6e53ed7c4985091e8410fe6e68ed272f6",
  };
  it("provenance: source-key digest and the proof under the derived sub-key are byte-identical, and the stored proof still vouches", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
    try {
      const digest = ai.sourceKeyDigest("person", "secA4|vector|person");
      expect(digest).toBe(V.sourceKeyDigest);
      const after = { action: "member", targetId: "m-secA4" };
      const mapping = { id: "map-secA4", kind: "person", sourceKey: "secA4|vector|person", ...after };
      const row = { id: "r-vec", entityId: "map-secA4", atMs: 1760054400000, metadata: { kind: "person", sourceKeyDigest: digest, before: null, after, prev: ai.MAPPING_PROVENANCE_GENESIS, proof: V.provenanceProof } };
      expect(ai.provenanceVouches("t-secA4", mapping, [row])).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("kiosk and card tokens: identical strings, and the stored strings still verify", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00.000Z"));
    try {
      expect(signKioskMemberToken({ tenantId: "t-secA4", memberId: "m-secA4" })).toBe(V.kiosk);
      expect(signCardToken({ tenantId: "t-secA4", memberId: "m-secA4", cardVersion: 3 })).toBe(V.card);
      expect(verifyKioskMemberToken(V.kiosk, "t-secA4").ok).toBe(true);
      expect(verifyCardToken(V.card, "t-secA4").ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("hashToken: unchanged for a token and for an address that merely starts with 'matflow.'", () => {
    expect(hashToken("0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe(V.hashTokenSample);
    expect(hashToken("matflow.support@example.test")).toBe(V.hashTokenEmail);
  });
});

describe("registry: every root-key derivation in the code base is a registered context", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("each createHmac(sha256, AUTH_SECRET_VALUE).update(<X_CONTEXT>) names a context in ROOT_KEY_CONTEXTS, with a shape no other signer can produce", async () => {
    const { ROOT_KEY_CONTEXTS } = await import("@/lib/key-contexts");
    const found: string[] = [];
    for (const f of [...walk("lib"), ...walk("app")]) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/createHmac\(\s*"sha256"\s*,\s*AUTH_SECRET_VALUE\s*\)\s*\.update\(\s*([A-Z_]+_CONTEXT)\s*\)/g)) {
        const def = src.match(new RegExp(`const ${m[1]}\\s*=\\s*"([^"]+)"`));
        expect(def, `${f}: ${m[1]} must be a string literal in the same file`).not.toBeNull();
        found.push(def![1]);
      }
    }
    expect(found.length, "derivation sites found").toBeGreaterThanOrEqual(4);
    for (const c of found) expect(ROOT_KEY_CONTEXTS, c).toContain(c);
    // Why the other raw signers cannot reach a context: google-drive and stripe-connect state carry ':', the device
    // hash '|', the disown token and the operator session end in a numeric segment, the step-up / impersonation /
    // operator-id / login-email digests carry their own prefix. A context has none of those shapes.
    for (const c of ROOT_KEY_CONTEXTS) {
      expect(c).toMatch(/^matflow\.[a-z-]+(\.[a-z0-9-]+)*\.v\d+$/);
      expect(c).not.toMatch(/[:|@]/);
    }
  });
});
