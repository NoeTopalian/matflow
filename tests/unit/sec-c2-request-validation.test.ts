/**
 * SEC-019 / SEC-036 remaining request validation (security campaign iteration 2, lane C2, 9 Oct 2026).
 *
 * The lane C inventory (docs/security/evidence/C2/03-validation-residuals.md) re-run on af803d5 left
 * JSON routes with no schema. The six JSON routes below (plus the four multipart routes pinned in
 * sec-c2-upload-controls) now parse with zod strictObject. Each route gets: unknown keys → 400,
 * wrong types → 400, null / array / string bodies → 400 (never a throw), each with NOTHING read,
 * spent or written; and a positive control that the legitimate body still reaches the effect.
 *
 * Confirmed defects (red against HEAD, evidence/C2/03-validation-red-green.log):
 *  - SF-C2-V1 /api/auth/totp/verify and /api/member/totp/verify: a null body threw on destructuring
 *    (500), and `{ code: ["123456"] }` coerced past the six-digit regex into the verifier.
 *  - SF-C2-V2 /api/members/[id]/hold: an unparsable or empty body was read as {} → `until` undefined →
 *    an OPEN-ENDED hold (paymentStatus "paused", collection paused) was written.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

type Call = { target: string; method: string; args: unknown[] };
const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const state = { session: null as unknown, token: null as unknown };
  const record: Record<string, unknown> = {
    id: "secC2-row-1", tenantId: "secC2-tenant", name: "secC2", status: "active", paymentStatus: "paid",
    stripeSubscriptionId: null, totpSecret: "JBSWY3DPEHPK3PXP", totpEnabled: true, totpLastUsedStep: null,
    mustChangePassword: false, sessionVersion: 0,
  };
  const model = (name: string) => new Proxy({}, {
    get(_t, method) {
      if (method === "then" || typeof method === "symbol") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ target: name, method: String(method), args });
        const m = String(method);
        if (/Many$/.test(m) && m !== "findMany") return { count: 1 };
        if (m === "findMany") return [];
        return { ...record };
      };
    },
  });
  const db: Record<string | symbol, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (prop === "$transaction") return async (fn: (t: unknown) => unknown) => fn(db);
      return model(String(prop));
    },
  });
  return { calls, state, db };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db, default: h.db }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(h.db),
  withRlsBypass: async (fn: (tx: unknown) => unknown) => fn(h.db),
}));
vi.mock("@/auth", () => ({ auth: async () => h.state.session }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/auth-pending-gate", () => ({ refuseRevokedPendingToken: async () => null }));
vi.mock("next-auth/jwt", () => ({ getToken: async () => h.state.token, encode: async () => "secC2.jwt" }));
vi.mock("@/lib/login-email", () => ({
  consumeUserTotp: async (...args: unknown[]) => { h.calls.push({ target: "totp", method: "consumeUserTotp", args }); return false; },
}));
vi.mock("otplib", () => ({
  verifySync: (...args: unknown[]) => { h.calls.push({ target: "totp", method: "verifySync", args }); return { valid: false }; },
  generateSecret: () => "JBSWY3DPEHPK3PXP",
  generateURI: () => "otpauth://totp/x",
}));
vi.mock("@/lib/recovery-codes", () => ({ generateRecoveryCodes: async () => ({ plain: [], hashed: [] }) }));
vi.mock("@/lib/import-upload", () => ({
  createUpload: async (...args: unknown[]) => { h.calls.push({ target: "importUpload", method: "createUpload", args }); return { ok: false, error: "refused", code: "bad_request" }; },
  UPLOAD_REFUSAL_STATUS: { bad_request: 400 },
}));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: () => null }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, session: {}, tenantId: "secC2-tenant", userId: "secC2-owner", role: "owner" }),
  requireApiOwnerOrManager: async () => ({ ok: true, session: {}, tenantId: "secC2-tenant", userId: "secC2-owner", role: "owner" }),
}));

type Handler = (req: Request, ctx?: unknown) => Promise<Response>;
const ROUTES: Record<string, { load: () => Promise<Handler>; ctx?: unknown; valid: unknown; effect: (c: Call) => boolean }> = {
  "/api/auth/totp/verify": {
    load: async () => (await import("@/app/api/auth/totp/verify/route")).POST as unknown as Handler,
    valid: { code: "123456" },
    effect: (c) => c.method === "consumeUserTotp",
  },
  "/api/member/totp/verify": {
    load: async () => (await import("@/app/api/member/totp/verify/route")).POST as unknown as Handler,
    valid: { code: "123456" },
    effect: (c) => c.method === "verifySync",
  },
  "/api/auth/totp/setup": {
    load: async () => (await import("@/app/api/auth/totp/setup/route")).POST as unknown as Handler,
    valid: { code: "123456", issueRecoveryCodes: true },
    effect: (c) => c.method === "consumeUserTotp",
  },
  "/api/member/totp/setup": {
    load: async () => (await import("@/app/api/member/totp/setup/route")).POST as unknown as Handler,
    valid: { code: "123456", issueRecoveryCodes: true },
    effect: (c) => c.method === "verifySync",
  },
  "/api/members/[id]/hold": {
    load: async () => (await import("@/app/api/members/[id]/hold/route")).POST as unknown as Handler,
    ctx: { params: Promise.resolve({ id: "secC2-row-1" }) },
    valid: { until: null },
    effect: (c) => c.target === "member" && c.method === "updateMany",
  },
  "/api/admin/import/uploads": {
    load: async () => (await import("@/app/api/admin/import/uploads/route")).POST as unknown as Handler,
    valid: { purpose: "members", fileName: "m.csv", bytes: 10, sha256: "a".repeat(64) },
    effect: (c) => c.method === "createUpload",
  },
};

function req(url: string, body: string) {
  return new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body });
}

beforeEach(() => {
  h.calls.length = 0;
  h.state.session = { user: { id: "secC2-owner", tenantId: "secC2-tenant", role: "owner", memberId: "secC2-row-1" } };
  h.state.token = { id: "secC2-owner", tenantId: "secC2-tenant", memberId: "secC2-row-1", totpPending: true, role: "owner" };
});

const bad = (valid: Record<string, unknown>) => ({
  "unknown key role": JSON.stringify({ ...valid, role: "owner" }),
  "unknown key tenantId": JSON.stringify({ ...valid, tenantId: "secC2-other" }),
  "nested data": JSON.stringify({ ...valid, data: { paymentStatus: "paid" } }),
  "null body": "null",
  "array body": JSON.stringify([valid]),
  "string body": JSON.stringify("x"),
  "not JSON": "garbage{",
  // `{}` is refused wherever a field is required; on the hold route it is the documented
  // open-ended hold (member-hold.test.ts), so that route is exempted from this one cell below.
  "empty object": "{}",
});
const SKIP: Record<string, string> = { "/api/members/[id]/hold|empty object": "an explicit {} is an open-ended hold by contract" };

describe("strict request bodies — refused before any read, spend or write", () => {
  for (const [url, r] of Object.entries(ROUTES)) {
    for (const [label, body] of Object.entries(bad(r.valid as Record<string, unknown>))) {
      if (SKIP[`${url}|${label}`]) continue;
      it(`${url}: ${label} → 400, no effect`, async () => {
        const handler = await r.load();
        const res = await handler(req(url, body), r.ctx);
        expect(res.status).toBe(400);
        expect(h.calls.filter(r.effect)).toHaveLength(0);
        expect(h.calls.filter((c) => /update|create|delete|upsert/i.test(c.method))).toHaveLength(0);
      });
    }
    it(`${url}: positive control — the legitimate body reaches the effect`, async () => {
      const handler = await r.load();
      const res = await handler(req(url, JSON.stringify(r.valid)), r.ctx);
      expect(res.status).not.toBe(500);
      expect(h.calls.filter(r.effect).length).toBeGreaterThan(0);
    });
  }

  it.each(["/api/auth/totp/verify", "/api/member/totp/verify", "/api/auth/totp/setup", "/api/member/totp/setup"])(
    "%s: a code that is not a six-digit STRING never reaches the verifier",
    async (url) => {
      const handler = await ROUTES[url].load();
      for (const code of [["123456"], 123456, "12345", "1234567", "12345a", { toString: "123456" }, null, true]) {
        const res = await handler(req(url, JSON.stringify({ code })));
        expect(res.status, JSON.stringify(code)).toBe(400);
      }
      expect(h.calls.filter(ROUTES[url].effect)).toHaveLength(0);
    },
  );

  it("/api/members/[id]/hold: a dated hold is still accepted (positive control for the strict schema)", async () => {
    const handler = await ROUTES["/api/members/[id]/hold"].load();
    const until = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const res = await handler(req("/api/members/secC2-row-1/hold", JSON.stringify({ until })), ROUTES["/api/members/[id]/hold"].ctx);
    expect(res.status).toBe(200);
    const write = h.calls.find((c) => c.target === "member" && c.method === "updateMany")!;
    expect((write.args[0] as { data: { holdUntil: Date } }).data.holdUntil.toISOString()).toBe(until);
  });
});
