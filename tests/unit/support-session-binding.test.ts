/**
 * Support (impersonation) sessions end when they should — lib/impersonation.ts.
 *
 * Remediation lane B, 6 Oct 2026 (BRIEF Workstream B; audit Q3 "UNVERIFIED:
 * the impersonation cookie outlives a target sessionVersion bump", Q8 "ignores
 * club status"). resolveActiveImpersonation() runs on every request (auth.ts
 * jwt()) and must return null — ending support authority on that request —
 * after: the stop, expiry, operator logout / revocation, operator losing the
 * authenticator, a target sessionVersion bump, club suspension / cancellation /
 * deletion, and for a captured cookie replayed without the operator's own live
 * session. The REAL module runs here; only cookies, Prisma and the clock are
 * stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const st = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  operator: null as null | Record<string, unknown>,
  target: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (st.jar.has(name) ? { name, value: st.jar.get(name)! } : undefined),
    set: (name: string, value: string) => { st.jar.set(name, value); },
    delete: (name: string) => { st.jar.delete(name); },
  }),
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "unit-test-secret-0123456789" }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    operator: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        st.operator && st.operator.id === where.id ? { ...st.operator } : null,
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(st.operator!, data); return st.operator; },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!st.operator || st.operator.id !== where.id) return { count: 0 };
        if ("supportNonceHash" in where && st.operator.supportNonceHash !== where.supportNonceHash) return { count: 0 };
        Object.assign(st.operator, data);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) =>
    fn({ user: { findUnique: async ({ where }: { where: { id: string } }) => (st.target && st.target.id === where.id ? { ...st.target } : null) } }),
}));

import {
  startSupportSession,
  endSupportSession,
  resolveActiveImpersonation,
  readImpersonationCookieForStop,
  verifyImpersonationToken,
  IMPERSONATION_COOKIE,
  SUPPORT_SESSION_TTL_SECONDS,
} from "@/lib/impersonation";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";

const OP_ID = "op-noe";
const TENANT = { name: "Club", slug: "club", primaryColor: "#f00", secondaryColor: "#900", textColor: "#000" };

function resetWorld() {
  st.jar.clear();
  st.operator = { id: OP_ID, sessionVersion: 4, totpEnabled: true, supportNonceHash: null, supportExpiresAt: null };
  st.target = {
    id: "u-owner", role: "owner", sessionVersion: 7, tenantId: "t-club",
    tenant: { ...TENANT, subscriptionStatus: "active", deletedAt: null },
  };
  st.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 4));
}

async function start() {
  return startSupportSession({
    operatorId: OP_ID,
    operatorSessionVersion: 4,
    target: { id: "u-owner", tenantId: "t-club", sessionVersion: 7 },
    reason: "support ticket 41",
    scope: "view",
  });
}

beforeEach(resetWorld);
afterEach(() => vi.useRealTimers());

describe("a live support session", () => {
  it("positive control: resolves to the target while every binding holds", async () => {
    await start();
    const active = await resolveActiveImpersonation();
    expect(active?.payload).toMatchObject({ adminUserId: OP_ID, opSv: 4, targetUserId: "u-owner", targetTenantId: "t-club", tsv: 7 });
    expect(active?.target).toMatchObject({ id: "u-owner", tenantId: "t-club", tenant: { slug: "club" } });
  });

  it("lasts 30 minutes, and the Operator row stores only a HASH of the nonce", async () => {
    expect(SUPPORT_SESSION_TTL_SECONDS).toBe(30 * 60);
    await start();
    const payload = verifyImpersonationToken(st.jar.get(IMPERSONATION_COOKIE)!);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    expect(st.operator!.supportNonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(st.operator!.supportNonceHash).not.toBe(payload.payload.n);
    expect(payload.payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30 * 60);
  });
});

describe("support authority ends on the next request after…", () => {
  it("the stop — and a CAPTURED copy of the cookie is dead too", async () => {
    await start();
    const captured = st.jar.get(IMPERSONATION_COOKIE)!;
    const claim = await readImpersonationCookieForStop();
    await endSupportSession({ operatorId: OP_ID, nonce: claim!.n });
    st.jar.delete(IMPERSONATION_COOKIE);
    expect(await resolveActiveImpersonation()).toBeNull();

    // Replayed in the same browser, with the operator's live session still present.
    st.jar.set(IMPERSONATION_COOKIE, captured);
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("operator logout / revocation (sessionVersion bump) — the captured cookie dies with the operator session", async () => {
    await start();
    st.operator!.sessionVersion = 5; // lane A logout and scripts/operator-access.mjs revoke both bump it
    expect(await resolveActiveImpersonation()).toBeNull();
    // Even with a fresh op cookie for the NEW version: the support session was bound to the old one.
    st.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 5));
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("a captured support cookie replayed WITHOUT the operator's own session (another browser)", async () => {
    await start();
    st.jar.delete(OP_SESSION_COOKIE);
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("…or with ANOTHER operator's session", async () => {
    await start();
    st.jar.set(OP_SESSION_COOKIE, issueOperatorSession("op-someone-else", 4));
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("the operator losing the authenticator (disabled / recovered)", async () => {
    await start();
    st.operator!.totpEnabled = false;
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("the operator being removed from OPERATOR_ALLOWED_IDS (ledger AH-B4, 9 Oct 2026)", async () => {
    await start();
    vi.stubEnv("OPERATOR_ALLOWED_IDS", "someone-else");
    try {
      expect(await resolveActiveImpersonation()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("expiry of the cookie (31 minutes later)", async () => {
    await start();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("expiry recorded on the Operator row, even if the cookie were somehow still in date", async () => {
    await start();
    st.operator!.supportExpiresAt = new Date(Date.now() - 1000);
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("a target sessionVersion bump (password reset, 2FA reset, suspension) — no re-entry", async () => {
    await start();
    st.target!.sessionVersion = 8;
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it.each([
    ["suspended", { subscriptionStatus: "suspended", deletedAt: null }],
    ["cancelled", { subscriptionStatus: "cancelled", deletedAt: null }],
    ["deleted", { subscriptionStatus: "active", deletedAt: new Date() }],
  ])("the club being %s", async (_l, status) => {
    await start();
    st.target!.tenant = { ...TENANT, ...status };
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("the target moving to another club", async () => {
    await start();
    st.target!.tenantId = "t-other";
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("a new support session by the same operator (it supersedes the old cookie)", async () => {
    await start();
    const first = st.jar.get(IMPERSONATION_COOKIE)!;
    await start();
    st.jar.set(IMPERSONATION_COOKIE, first);
    expect(await resolveActiveImpersonation()).toBeNull();
  });
});

describe("forged and legacy cookies", () => {
  it("a tampered body fails the signature", async () => {
    await start();
    const [body, sig] = st.jar.get(IMPERSONATION_COOKIE)!.split(".");
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    p.targetUserId = "u-someone-else";
    st.jar.set(IMPERSONATION_COOKIE, `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${sig}`);
    expect(await resolveActiveImpersonation()).toBeNull();
  });

  it("a pre-6-Oct-2026 (v1, unbound, undomained) cookie no longer verifies", () => {
    const v1 = { adminUserId: OP_ID, targetUserId: "u-owner", targetTenantId: "t-club", reason: "x", exp: Math.floor(Date.now() / 1000) + 600 };
    const body = Buffer.from(JSON.stringify(v1)).toString("base64url");
    const sig = createHmac("sha256", "unit-test-secret-0123456789").update(body).digest().toString("base64url");
    expect(verifyImpersonationToken(`${body}.${sig}`).ok).toBe(false);
  });

  it("the stop can still read (signature-checked) an expired cookie so it can clear the nonce", async () => {
    await start();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(await readImpersonationCookieForStop()).toMatchObject({ adminUserId: OP_ID });
  });
});
