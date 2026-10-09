import { vi, describe, it, expect, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { addLoginClaimSql } from "./login-claim-fake";

// claimLoginIdentity / claimLoginIdentities (admin hub AH-01, 9 Oct 2026) in
// isolation, and how the operator route and a club route answer a legacy
// duplicate. The database behaviour (real advisory locks, two connections,
// both DB roles) is in tests/integration/login-identity-*-db.test.ts.

const h = vi.hoisted(() => ({
  userHolder: null as null | Record<string, unknown>,
  memberHolder: null as null | Record<string, unknown>,
  owner: { id: "owner-1", email: "owner@club.example", loginEmailProvisionalSince: null } as Record<string, unknown>,
  logAudit: vi.fn(async () => {}),
  requireStepUp: vi.fn(async () => ({ operatorId: "op-1", sessionVersion: 0, action: "owner.login_email", targetId: "t", tenantId: "t", versionDigest: "v", requestId: "rq-1" }) as unknown),
  consumeStepUpGrant: vi.fn(async () => ({ kind: "spent" }) as unknown),
  session: { user: { id: "owner-1", tenantId: "tenant-A", role: "owner" } } as unknown,
}));

function makeTx() {
  return {
    user: {
      findFirst: vi.fn(async (a: { where: { role?: string; email?: unknown } }) =>
        a.where.role === "owner" ? h.owner : (typeof a.where.email === "string" ? h.userHolder : null)),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: "new-user" })),
    },
    member: { findFirst: vi.fn(async () => h.memberHolder) },
    passwordResetToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    magicLinkToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
}
let tx = addLoginClaimSql(makeTx());

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: async () => ({ operatorId: "op-1", named: true }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/operator-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator-step-up")>()),
  requireStepUp: h.requireStepUp,
  consumeStepUpGrant: h.consumeStepUpGrant,
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "$2a$12$hashed") } }));

import { claimLoginIdentity, claimLoginIdentities, emailDigest, loginEmailTaken, type LoginClaimTx } from "@/lib/login-email";
import { POST as operatorLoginEmail } from "@/app/api/admin/customers/[id]/login-email/route";
import { POST as createStaff } from "@/app/api/staff/route";

const asTx = (t: unknown) => t as LoginClaimTx;

beforeEach(() => {
  vi.clearAllMocks();
  tx = addLoginClaimSql(makeTx());
  h.userHolder = null;
  h.memberHolder = null;
});

describe("claimLoginIdentity", () => {
  it("takes the transaction-scoped lock BEFORE reading holders, on the canonical address", async () => {
    const order: string[] = [];
    const t = tx as unknown as { $executeRaw: (...a: unknown[]) => Promise<number>; $queryRaw: (...a: unknown[]) => Promise<unknown[]> };
    const exec = t.$executeRaw;
    const query = t.$queryRaw;
    t.$executeRaw = async (...a) => { order.push("lock"); return exec(...a); };
    t.$queryRaw = async (...a) => { order.push("read"); return query(...a); };
    await claimLoginIdentity(asTx(tx), { tenantId: "tenant-A", email: "  Della@Club.Example " });
    expect(order).toEqual(["lock", "read", "read"]);
    expect(tx.locks).toHaveLength(1);
    expect(tx.locks[0][0]).toBe(0x4c474944); // the login-identity namespace
    // Same canonical address, same key; a different club, a different key.
    await claimLoginIdentity(asTx(tx), { tenantId: "tenant-A", email: "della@club.example" });
    await claimLoginIdentity(asTx(tx), { tenantId: "tenant-B", email: "della@club.example" });
    expect(tx.locks[1]).toEqual(tx.locks[0]);
    expect(tx.locks[2]).not.toEqual(tx.locks[0]);
  });

  it("none / user / member / many — never picks one of several", async () => {
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example" })).toEqual({ kind: "none" });
    h.userHolder = { id: "u1", name: "Coach", role: "coach", email: "a@x.example" };
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example" })).toEqual({ kind: "user", id: "u1", name: "Coach", role: "coach", canSignIn: true });
    h.userHolder = null;
    h.memberHolder = { id: "m1", name: "Kid", status: "active", passwordHash: null, email: "kid-00@no-login.matflow.local" };
    // A synthesised holder cannot sign in through the address; a passwordless REAL address can.
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "kid-00@no-login.matflow.local" })).toMatchObject({ kind: "member", hasPassword: false, canSignIn: false });
    h.memberHolder = { id: "m2", name: "Walk-in", status: "active", passwordHash: null, email: "a@x.example" };
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example" })).toMatchObject({ kind: "member", hasPassword: false, canSignIn: true });
    h.userHolder = { id: "u1", name: "Coach", role: "coach", email: "a@x.example" };
    const many = await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example" });
    expect(many.kind).toBe("many");
    expect(many.kind === "many" && many.holders.map((x) => x.id)).toEqual(["u1", "m2"]);
  });

  it("exclusion removes only the named record", async () => {
    h.userHolder = { id: "u1", name: "Coach", role: "coach", email: "a@x.example" };
    h.memberHolder = { id: "m2", name: "Walk-in", status: "active", passwordHash: "x", email: "a@x.example" };
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example", exclude: { userId: "u1" } })).toMatchObject({ kind: "member", id: "m2" });
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example", exclude: { memberId: "m2" } })).toMatchObject({ kind: "user", id: "u1" });
    expect(await claimLoginIdentity(asTx(tx), { tenantId: "t", email: "a@x.example", exclude: { userId: "m2" } })).toMatchObject({ kind: "many" });
    // The 7-Oct wrapper keeps its meaning: any holder other than this user.
    expect(await loginEmailTaken(asTx(tx), { tenantId: "t", userId: "u1", email: "a@x.example" })).toBe(true);
    h.memberHolder = null;
    expect(await loginEmailTaken(asTx(tx), { tenantId: "t", userId: "u1", email: "a@x.example" })).toBe(false);
  });

  it("refuses an empty tenant or address instead of locking nothing", async () => {
    await expect(claimLoginIdentity(asTx(tx), { tenantId: "", email: "a@x.example" })).rejects.toThrow();
    await expect(claimLoginIdentity(asTx(tx), { tenantId: "t", email: "   " })).rejects.toThrow();
    expect(tx.locks).toHaveLength(0);
  });

  it("bulk: one lock per distinct canonical address, ascending (deadlock-safe), synthesised logins skipped", async () => {
    const out = await claimLoginIdentities(asTx(tx), "t", ["b@x.example", "A@X.example", "a@x.example", "kid-1@no-login.matflow.local", "", "c@x.example"]);
    expect(tx.locks).toHaveLength(3);
    const keys = tx.locks.map((l) => l[1]);
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
    expect([...out.keys()].sort()).toEqual(["a@x.example", "b@x.example", "c@x.example", "kid-1@no-login.matflow.local"]);
    expect(out.get("kid-1@no-login.matflow.local")).toEqual({ kind: "none" });
  });

  it("does not accept the bare client (the lock would not outlive the call) — compile-time", () => {
    // Type-level only; never executed. `tsc --noEmit` fails if this stops being an error.
    const typeOnly = (client: PrismaClient) => {
      // @ts-expect-error a PrismaClient is not a transaction client
      void claimLoginIdentity(client, { tenantId: "t", email: "a@x.example" });
      // @ts-expect-error a PrismaClient is not a transaction client
      void claimLoginIdentities(client, "t", []);
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("emailDigest is keyed (AH-E2)", () => {
  const plain = (s: string) => createHash("sha256").update(s).digest("hex");
  it("is HMAC-SHA256 under the server secret: changes with the key, never equals sha256(address)", () => {
    const a = "della@club.example";
    const k1 = emailDigest(a, "key-one");
    const k2 = emailDigest(a, "key-two");
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(plain(a));
    expect(k2).not.toBe(plain(a));
    expect(emailDigest(a)).not.toBe(plain(a)); // the default (server secret) path too
  });
  it("is stable for one key and canonical over case and whitespace", () => {
    expect(emailDigest("  Della@Club.Example ", "k")).toBe(emailDigest("della@club.example", "k"));
    expect(emailDigest("della@club.example", "k")).not.toBe(emailDigest("della+x@club.example", "k"));
  });
  it("refuses an unkeyed digest in production", () => {
    const env = { ...process.env };
    try {
      delete process.env.NEXTAUTH_SECRET;
      delete process.env.AUTH_SECRET;
      vi.stubEnv("NODE_ENV", "production");
      expect(() => emailDigest("della@club.example")).toThrow(/must be set in production/);
    } finally {
      vi.unstubAllEnvs();
      Object.assign(process.env, env);
    }
  });
});

describe("a legacy duplicate at the door", () => {
  const opCall = (newEmail: string) =>
    operatorLoginEmail(
      new Request("http://localhost/api/admin/customers/tenant-A/login-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "change", reason: "owner verified by call-back", newEmail }),
      }),
      { params: Promise.resolve({ id: "tenant-A" }) },
    );

  it("operator: two holders → 409 'legacy duplicate — review', nothing written, no audit", async () => {
    h.userHolder = { id: "u9", name: "Old Staff", role: "coach", email: "dup@club.example" };
    h.memberHolder = { id: "m9", name: "Old Member", status: "active", passwordHash: null, email: "dup@club.example" };
    const res = await opCall("dup@club.example");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { result?: string; error: string };
    expect(body.result).toBe("legacy_duplicate");
    expect(body.error).toMatch(/legacy duplicate/i);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("operator: one holder → the ordinary opaque 409 (whose is not said)", async () => {
    h.memberHolder = { id: "m9", name: "Old Member", status: "active", passwordHash: null, email: "taken@club.example" };
    const res = await opCall("taken@club.example");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { result?: string; error: string };
    expect(body.result).toBeUndefined();
    expect(body.error).not.toMatch(/member|Old Member|m9/);
  });

  it("club staff: a legacy duplicate is the same opaque 409 as any collision — no 'legacy' detail", async () => {
    h.userHolder = { id: "u9", name: "Old Staff", role: "coach", email: "dup@club.example" };
    h.memberHolder = { id: "m9", name: "Old Member", status: "active", passwordHash: null, email: "dup@club.example" };
    const res = (await createStaff(
      new Request("http://localhost/api/staff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New", email: "dup@club.example", role: "coach", password: "Strong-Temp-Pass-42" }),
      }),
    )) as Response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; result?: string };
    expect(body.result).toBeUndefined();
    expect(body.error).not.toMatch(/legacy|staff|member/i);
    expect(tx.user.create).not.toHaveBeenCalled();
  });
});
