// Security campaign lane C — AH-G6 / SEC-019: the operator route
// POST /api/admin/customers/[id]/login-email parses its body with a
// discriminated union of NON-strict z.object variants. This file demonstrates
// what that actually does with unknown, duplicate and nested security-sensitive
// keys (role, tenant, verification, identity, credential), with positive
// controls, and pins the invariant that holds whether or not the schema is made
// strict: no client-supplied key other than action/reason/newEmail/attest ever
// reaches a read filter, the step-up binding, a write or the audit row.
//
// Disposition (9 Oct 2026, candidate 2a6487e + working tree): unknown keys are
// STRIPPED silently (200 on an otherwise valid request), never assigned. The
// recommended one-line hardening (lane B owns the route) is to build the three
// variants with z.strictObject so a forged key is a visible 400 — the clients
// (app/admin/tenants/[id]/LoginEmailCard.tsx, components/admin/ConflictPanel.tsx)
// send exactly the schema keys, pinned below against a mirror of the schema.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { emailField } from "@/lib/email-normalise";
import { addLoginClaimSql } from "./login-claim-fake";

const h = vi.hoisted(() => ({
  requireStepUp: vi.fn(async () => null as unknown),
  grant: { operatorId: "secC-op", sessionVersion: 0, action: "owner.login_email", targetId: "t", tenantId: "secC-tenant-A", versionDigest: "v", requestId: "secC-rq" },
  consumeStepUpGrant: vi.fn(async () => ({ kind: "spent" }) as unknown),
  logAudit: vi.fn(async () => {}),
  owner: null as null | Record<string, unknown>,
}));

const tx = {
  user: {
    findFirst: vi.fn(async (args: { where: { role?: string } }) => (args.where.role === "owner" ? h.owner : null)),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  member: { findFirst: vi.fn(async () => null) },
  passwordResetToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  magicLinkToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
};
addLoginClaimSql(tx);

vi.mock("@/lib/prisma-tenant", () => ({ withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx) }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: async () => ({ operatorId: "secC-op", named: true }) }));
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

import { POST } from "@/app/api/admin/customers/[id]/login-email/route";

const REASON = "secC owner verified by call-back";
const raw = (json: string) =>
  POST(
    new Request("http://localhost/api/admin/customers/secC-tenant-A/login-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
    }),
    { params: Promise.resolve({ id: "secC-tenant-A" }) },
  );
const call = (body: unknown) => raw(JSON.stringify(body));

/** Every security-sensitive key a forged body might try to assign, top level. */
const FORGED = {
  role: "owner",
  tenantId: "secC-tenant-B",
  userId: "secC-other-user",
  ownerId: "secC-other-user",
  id: "secC-other-user",
  email: "secC-attacker@secc.example",
  passwordHash: "secC-forged-hash",
  password: "secC-Forged-Password-1",
  totpSecret: "secC-forged-totp",
  totpEnabled: false,
  totpRecoveryCodes: ["secC-forged-code"],
  sessionVersion: 0,
  emailVerified: true,
  loginEmailProvisionalSince: null,
  mustChangePassword: false,
  operatorId: "secC-other-op",
  isOperator: true,
};
const NESTED = {
  data: { role: "owner", tenantId: "secC-tenant-B", passwordHash: "secC-forged-hash" },
  where: { tenantId: "secC-tenant-B" },
  user: { role: "owner", email: "secC-attacker@secc.example" },
};

/** Everything the route passed to the database, the binding and the audit row. */
function observed(): string {
  return JSON.stringify({
    reads: tx.user.findFirst.mock.calls,
    update: tx.user.update.mock.calls,
    updateMany: tx.user.updateMany.mock.calls,
    stepUp: h.requireStepUp.mock.calls.map((c) => (c as unknown[]).slice(2)),
    audit: h.logAudit.mock.calls,
  });
}
function expectNoForgedValue() {
  const seen = observed();
  for (const v of ["secC-tenant-B", "secC-other-user", "secC-attacker@secc.example", "secC-forged-hash", "secC-Forged-Password-1", "secC-forged-totp", "secC-forged-code", "secC-other-op"]) {
    expect(seen, `forged value ${v} reached the route's effects`).not.toContain(v);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireStepUp.mockResolvedValue(h.grant);
  h.consumeStepUpGrant.mockResolvedValue({ kind: "spent" });
  h.owner = { id: "secC-owner-1", email: "owner@secc.example", loginEmailProvisionalSince: null };
});

describe("AH-G6 positive controls (legitimate bodies, exactly as the clients send them)", () => {
  it("mark_provisional succeeds and writes only the provisional mark", async () => {
    const res = await call({ action: "mark_provisional", reason: REASON });
    expect(res.status).toBe(200);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    const arg = tx.user.update.mock.calls[0] as unknown as [{ where: unknown; data: Record<string, unknown> }];
    expect(arg[0].where).toEqual({ id: "secC-owner-1" });
    expect(Object.keys(arg[0].data)).toEqual(["loginEmailProvisionalSince"]);
  });

  it("change succeeds and writes exactly email + provisional mark + session bump, scoped to this tenant", async () => {
    const res = await call({ action: "change", reason: REASON, newEmail: "new-owner@secc.example" });
    expect(res.status).toBe(200);
    const arg = tx.user.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
    expect(arg[0].where).toEqual({ id: "secC-owner-1", tenantId: "secC-tenant-A", email: "owner@secc.example" });
    expect(Object.keys(arg[0].data).sort()).toEqual(["email", "loginEmailProvisionalSince", "sessionVersion"]);
    expect(arg[0].data.sessionVersion).toEqual({ increment: 1 });
  });
});

describe("AH-G6 unknown top-level security-sensitive keys", () => {
  it.each([
    ["mark_provisional", { action: "mark_provisional", reason: REASON }],
    ["clear_provisional", { action: "clear_provisional", reason: REASON, attestMailboxVerified: true }],
    ["change", { action: "change", reason: REASON, newEmail: "new-owner@secc.example" }],
  ])("%s + forged role/tenant/identity/credential/verification keys: refused before any effect, or stripped — never assigned", async (action, legit) => {
    if (action === "clear_provisional") h.owner = { ...h.owner!, loginEmailProvisionalSince: new Date("2026-10-07T08:00:00Z") };
    const res = await call({ ...FORGED, ...legit });
    // Pinned (review R-3, 9 Oct 2026): the body schema is strict, so an unknown key is a 400 with
    // nothing read, nothing bound and nothing written. Reverting to the lenient schema fails here.
    expect(res.status).toBe(400);
    if (res.status === 400) {
      // The strict form (recommended): nothing read, nothing bound, nothing written.
      expect(h.requireStepUp).not.toHaveBeenCalled();
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.user.updateMany).not.toHaveBeenCalled();
    } else {
      // The current form: stripped. Same 200 as the legitimate body; the write carries only the route's own fields.
      expect(res.status).toBe(200);
      const writes = [...tx.user.update.mock.calls, ...tx.user.updateMany.mock.calls] as unknown as Array<[{ data: Record<string, unknown> }]>;
      for (const [w] of writes) {
        for (const k of ["role", "tenantId", "passwordHash", "totpSecret", "totpEnabled", "totpRecoveryCodes", "emailVerified", "mustChangePassword"]) {
          expect(w.data).not.toHaveProperty(k);
        }
        // sessionVersion only ever as the route's own increment, never the forged 0.
        if ("sessionVersion" in w.data) expect(w.data.sessionVersion).toEqual({ increment: 1 });
        // loginEmailProvisionalSince only as the route's own value, never the forged null on mark/change.
        if (action !== "clear_provisional" && "loginEmailProvisionalSince" in w.data) expect(w.data.loginEmailProvisionalSince).toBeInstanceOf(Date);
      }
      // The step-up binding is derived from the parsed body only.
      const binding = (h.requireStepUp.mock.calls[0] as unknown[])[4];
      expect(binding).toEqual(action === "change" ? { change: { newEmail: "new-owner@secc.example" } } : { change: {} });
      // The owner lookup is pinned to the path tenant + role owner.
      expect((tx.user.findFirst.mock.calls[0] as unknown as [{ where: unknown }])[0].where).toEqual({ tenantId: "secC-tenant-A", role: "owner" });
    }
    expectNoForgedValue();
  });

  it("a forged newEmail on mark_provisional does not change the address or the binding", async () => {
    const res = await call({ action: "mark_provisional", reason: REASON, newEmail: "secC-attacker@secc.example" });
    expect([200, 400]).toContain(res.status);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expectNoForgedValue();
  });
});

describe("AH-G6 nested keys and type confusion", () => {
  it("nested data/where/user objects never reach a write or a filter", async () => {
    const res = await call({ action: "change", reason: REASON, newEmail: "new-owner@secc.example", ...NESTED });
    expect([200, 400]).toContain(res.status);
    expectNoForgedValue();
  });

  it.each([
    ["operator-style object", { $ne: null }],
    ["array", ["new-owner@secc.example"]],
    ["number", 1],
    ["boolean", true],
    ["object with toString", { toString: "secC-attacker@secc.example" }],
  ])("newEmail as %s is a 400 before any read, binding or write", async (_label, value) => {
    const res = await call({ action: "change", reason: REASON, newEmail: value });
    expect(res.status).toBe(400);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(h.requireStepUp).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it.each([["string 'true'", "true"], ["1", 1], ["object", { value: true }]])(
    "attestMailboxVerified as %s is a 400 (only the literal true attests)",
    async (_label, value) => {
      h.owner = { ...h.owner!, loginEmailProvisionalSince: new Date("2026-10-07T08:00:00Z") };
      const res = await call({ action: "clear_provisional", reason: REASON, attestMailboxVerified: value });
      expect(res.status).toBe(400);
      expect(tx.user.update).not.toHaveBeenCalled();
    },
  );

  it("a reason given as an object is a 400", async () => {
    const res = await call({ action: "mark_provisional", reason: { length: 50, toString: REASON } });
    expect(res.status).toBe(400);
  });
});

describe("AH-G6 duplicate keys (JSON.parse: last occurrence wins)", () => {
  it("duplicate action — the executed action is the one the step-up binding names, never the first", async () => {
    const res = await raw(`{"action":"mark_provisional","reason":"${REASON}","action":"change","newEmail":"new-owner@secc.example"}`);
    expect(res.status).toBe(200);
    expect((h.requireStepUp.mock.calls[0] as unknown[])[3]).toBe("secC-tenant-A/secC-owner-1/change");
    expect((h.requireStepUp.mock.calls[0] as unknown[])[4]).toEqual({ change: { newEmail: "new-owner@secc.example" } });
    expect(tx.user.update).not.toHaveBeenCalled(); // no mark was applied
    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it("duplicate newEmail — the address written is the address bound into the grant", async () => {
    const res = await raw(`{"action":"change","reason":"${REASON}","newEmail":"first@secc.example","newEmail":"second@secc.example"}`);
    expect(res.status).toBe(200);
    expect((h.requireStepUp.mock.calls[0] as unknown[])[4]).toEqual({ change: { newEmail: "second@secc.example" } });
    const arg = tx.user.updateMany.mock.calls[0] as unknown as [{ data: { email: string } }];
    expect(arg[0].data.email).toBe("second@secc.example");
  });

  it("raw __proto__ / constructor keys neither pollute nor reach an effect", async () => {
    const res = await raw(`{"__proto__":{"role":"owner","tenantId":"secC-tenant-B"},"constructor":{"prototype":{"role":"owner"}},"action":"mark_provisional","reason":"${REASON}"}`);
    expect([200, 400]).toContain(res.status);
    expect(({} as Record<string, unknown>).role).toBeUndefined();
    expectNoForgedValue();
  });
});

describe("AH-G6 recommended change is compatible with every client body", () => {
  // Mirror of the route's schema with the one-line change applied (z.object -> z.strictObject).
  const reason = z.string().trim().min(10).max(500);
  const strict = z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("mark_provisional"), reason }),
    z.strictObject({ action: z.literal("clear_provisional"), reason, attestMailboxVerified: z.literal(true) }),
    z.strictObject({ action: z.literal("change"), reason, newEmail: emailField(120) }),
  ]);
  it.each([
    [{ action: "mark_provisional", reason: REASON }],
    [{ action: "clear_provisional", reason: REASON, attestMailboxVerified: true }],
    [{ action: "change", reason: REASON, newEmail: "new-owner@secc.example" }],
  ])("accepts the client body %j", (body) => {
    expect(strict.safeParse(body).success).toBe(true);
  });
  it("refuses each forged key", () => {
    for (const [k, v] of Object.entries({ ...FORGED, ...NESTED })) {
      expect(strict.safeParse({ action: "mark_provisional", reason: REASON, [k]: v }).success, k).toBe(false);
    }
  });
});
