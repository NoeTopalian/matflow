// Single-use operator TOTP codes and step-up grants against REAL Postgres
// (lane A, 6 Oct 2026; atomic spend, bindings and idempotent replay — admin hub
// lane C, 9 Oct 2026, ledger AH-03). The unit suites prove the logic with an
// in-memory table; this proves, in the database:
//   - the conditional UPDATEs are atomic: racing instances cannot both win;
//   - the spend is INSIDE the route's mutation transaction: an audit failure
//     rolls back the mutation AND the spend (nonce hash and expiry unchanged);
//   - five concurrent submissions of one grant → ONE mutation, ONE
//     sessionVersion bump, ONE outcome row; the rest are answered from that
//     row ("already applied") or refused as used — never a second change;
//   - a stale record version and a different change are refused with the
//     grant left unspent; an earlier operator session's grant is refused;
//   - the outcome row carries operatorId + requestId COLUMNS.
//
// Runs only against the Neon TEST branch (tests/setup-test-db.ts refuses the
// production endpoint). Synthetic Operator, club and owner with unique ids,
// deleted in afterAll. Skips without a database.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { generateSecret, generateSync } from "otplib";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "operator-step-up-db-test-secret-0123456789abcdef";
  return { jar: new Map<string, string>(), failAuditInTx: false };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
// The REAL audit writer, with an injectable failure for rows written inside a
// caller's transaction — the failure the brief requires to roll back the spend.
vi.mock("@/lib/audit-log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/audit-log")>();
  return {
    ...real,
    logAudit: async (a: Parameters<typeof real.logAudit>[0]) => {
      if (h.failAuditInTx && a.tx) throw new Error("injected audit failure");
      return real.logAudit(a);
    },
  };
});

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { consumeOperatorTotp, issueOperatorSession } from "@/lib/operator-auth";
import {
  STEP_UP_HEADER,
  StepUpRefusedError,
  consumeStepUpGrant,
  issueStepUpGrant,
  requireStepUp,
  type VerifiedStepUp,
} from "@/lib/operator-step-up";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OP_ID = `lane-c-op-${STAMP}`;
const SECRET = generateSecret();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nonceOf = (grant: string) =>
  (JSON.parse(Buffer.from(grant.split(".")[0], "base64url").toString("utf8")) as { n: string }).n;

describe.skipIf(!HAS_DB)("operator single-use controls on the database", () => {
  const ids = { tenant: "", owner: "" };
  const TENANT_NAME = `Lane C Club ${STAMP}`;

  const operatorRow = () =>
    prisma.operator.findUnique({ where: { id: OP_ID }, select: { stepUpNonceHash: true, stepUpExpiresAt: true, sessionVersion: true } });
  const ownerRow = () =>
    withRlsBypass((tx) => tx.user.findUnique({ where: { id: ids.owner }, select: { name: true, sessionVersion: true, totpEnabled: true } }));
  const outcomeRows = (action: string) =>
    withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { tenantId: ids.tenant, action }, select: { requestId: true, operatorId: true, metadata: true } }),
    );
  const post = (file: string, body: unknown, grant: string) =>
    import(`@/app/api/admin/customers/[id]/${file}/route`).then((m: { POST: (r: Request, x: { params: Promise<{ id: string }> }) => Promise<Response> }) =>
      m.POST(
        new Request(`http://localhost/api/admin/customers/${ids.tenant}/${file}`, {
          method: "POST",
          headers: { "content-type": "application/json", [STEP_UP_HEADER]: grant },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: ids.tenant }) },
      ),
    );

  beforeAll(async () => {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `lane-c-${STAMP}@operator.test`,
        name: "Lane C synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: SECRET,
      },
    });
    await withRlsBypass(async (tx) => {
      ids.tenant = (await tx.tenant.create({ data: { name: TENANT_NAME, slug: `lane-c-${STAMP}` } })).id;
      ids.owner = (
        await tx.user.create({
          data: {
            tenantId: ids.tenant, email: `owner-${STAMP}@lanec.test`, name: "Placeholder Owner", role: "owner",
            passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a", totpEnabled: true, totpSecret: "synthetic",
          },
        })
      ).id;
    });
    h.jar.set("matflow_op_session", issueOperatorSession(OP_ID, 0));
  });

  afterAll(async () => {
    // Refusal rows are best-effort (written after the response): let them land
    // so they are cleaned up with the rest.
    await new Promise((r) => setTimeout(r, 750));
    await withRlsBypass(async (tx) => {
      if (ids.tenant) {
        await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
        await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
        await tx.tenant.deleteMany({ where: { id: ids.tenant } });
      }
      await tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: OP_ID } });
    });
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
  });

  it("the operator columns exist; the new audit columns exist and default to null", async () => {
    const row = await prisma.operator.findUnique({
      where: { id: OP_ID },
      select: { totpLastUsedStep: true, stepUpNonceHash: true, stepUpExpiresAt: true },
    });
    expect(row).toEqual({ totpLastUsedStep: null, stepUpNonceHash: null, stepUpExpiresAt: null });
    const probe = await withRlsBypass((tx) =>
      tx.auditLog.create({ data: { tenantId: ids.tenant, action: "lane_c.probe", entityType: "Probe", entityId: STAMP }, select: { operatorId: true, requestId: true } }),
    );
    expect(probe).toEqual({ operatorId: null, requestId: null });
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: ids.tenant, action: "lane_c.probe" } }));
  });

  it("five concurrent uses of one TOTP code: exactly one is accepted", async () => {
    const code = generateSync({ secret: SECRET });
    const row = { id: OP_ID, totpSecret: SECRET, totpLastUsedStep: null };
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeOperatorTotp(row, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { totpLastUsedStep: true } });
    expect(typeof after?.totpLastUsedStep).toBe("number");
    expect(await consumeOperatorTotp({ ...row, totpLastUsedStep: after!.totpLastUsedStep }, code)).toBe(false);
  });

  it("five concurrent spends of one grant, each in its own transaction: exactly one is spent", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.totp_reset", targetId: ids.tenant });
    const v = (await requireStepUp(
      new Request("http://localhost/x", { headers: { [STEP_UP_HEADER]: grant } }),
      { operatorId: OP_ID, named: true, sessionVersion: 0 },
      "owner.totp_reset",
      ids.tenant,
      { change: {} },
    )) as VerifiedStepUp;
    expect(v.requestId).toBe(sha256(nonceOf(grant)));
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => withRlsBypass((tx) => consumeStepUpGrant(tx, v))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused.every((r) => r.reason instanceof StepUpRefusedError && r.reason.reason === "used")).toBe(true);
    expect(await operatorRow()).toMatchObject({ stepUpNonceHash: null, stepUpExpiresAt: null });
  });

  it("a grant whose stored expiry has passed is refused even though its token is in date", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.totp_reset", targetId: ids.tenant });
    await prisma.operator.update({ where: { id: OP_ID }, data: { stepUpExpiresAt: new Date(Date.now() - 1000) } });
    const res = await post("totp-reset", { reason: "lost phone, verified", confirmName: TENANT_NAME }, grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("used");
    expect((await ownerRow())?.totpEnabled).toBe(true);
  });

  it("audit failure inside the transaction: the change AND the spend roll back; the same grant then succeeds once", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.profile", targetId: `${ids.tenant}/${ids.owner}/name`, change: { name: "Ann Synthetic" } });
    const before = await operatorRow();
    expect(before?.stepUpNonceHash).toBe(sha256(nonceOf(grant)));

    h.failAuditInTx = true;
    const failed = await post("owner-profile", { name: "Ann Synthetic", reason: "placeholder name at signup" }, grant);
    h.failAuditInTx = false;
    expect(failed.status).toBe(500);
    expect(await operatorRow()).toEqual(before); // nonce hash AND expiry unchanged
    expect((await ownerRow())?.name).toBe("Placeholder Owner");
    expect(await outcomeRows("admin.owner.profile.updated")).toHaveLength(0);

    const ok = await post("owner-profile", { name: "Ann Synthetic", reason: "placeholder name at signup" }, grant);
    expect(ok.status).toBe(200);
    expect((await ownerRow())?.name).toBe("Ann Synthetic");
    const rows = await outcomeRows("admin.owner.profile.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorId: OP_ID, requestId: sha256(nonceOf(grant)) });
    expect((await operatorRow())?.stepUpNonceHash).toBeNull();
  });

  it("a different change (same operator, same owner) is refused and the grant is NOT spent", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.profile", targetId: `${ids.tenant}/${ids.owner}/name`, change: { name: "Bob Synthetic" } });
    const res = await post("owner-profile", { name: "Mallory Synthetic", reason: "placeholder name at signup" }, grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("wrong_change");
    expect((await operatorRow())?.stepUpNonceHash).toBe(sha256(nonceOf(grant)));
    expect((await ownerRow())?.name).toBe("Ann Synthetic");
  });

  it("the record moved after the grant was issued: 409 stale, nothing written, the spend rolled back", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.profile", targetId: `${ids.tenant}/${ids.owner}/name`, change: { name: "Cara Synthetic" } });
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.owner }, data: { name: "Owner Edited Meanwhile" } }));
    const res = await post("owner-profile", { name: "Cara Synthetic", reason: "placeholder name at signup" }, grant);
    expect(res.status).toBe(409);
    expect((await res.json()).refusal).toBe("stale");
    expect((await ownerRow())?.name).toBe("Owner Edited Meanwhile");
    expect((await operatorRow())?.stepUpNonceHash).toBe(sha256(nonceOf(grant)));
  });

  it("double-click / lost response: five concurrent submissions of one grant → ONE reset, ONE sessionVersion bump, ONE outcome row", async () => {
    const svBefore = (await ownerRow())!.sessionVersion;
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.totp_reset", targetId: ids.tenant });
    const body = { reason: "lost phone, verified by call-back", confirmName: TENANT_NAME };
    const responses = await Promise.all(Array.from({ length: 5 }, () => post("totp-reset", body, grant)));
    const bodies = await Promise.all(responses.map(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> })));
    const applied = bodies.filter((b) => b.status === 200 && b.json.alreadyApplied !== true);
    const echoed = bodies.filter((b) => b.status === 200 && b.json.alreadyApplied === true);
    const used = bodies.filter((b) => b.status === 403 && b.json.refusal === "used");
    expect(applied).toHaveLength(1);
    expect(echoed.length + used.length).toBe(4);
    for (const e of echoed) expect(e.json).toMatchObject({ recordedAction: "admin.owner.totp_reset", ownerId: ids.owner });

    const after = (await ownerRow())!;
    expect(after.sessionVersion).toBe(svBefore + 1);
    expect(after.totpEnabled).toBe(false);
    const rows = (await outcomeRows("admin.owner.totp_reset")).filter((r) => r.requestId === sha256(nonceOf(grant)));
    expect(rows).toHaveLength(1);
    expect(rows[0].operatorId).toBe(OP_ID);

    // The lost-response retry, later: answered from the record, nothing changes.
    const retry = await post("totp-reset", body, grant);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ alreadyApplied: true, sessionVersionAfter: svBefore + 1 });
    expect((await ownerRow())!.sessionVersion).toBe(svBefore + 1);
  });

  it("a spent grant with NO recorded outcome is refused as used", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.force_password_reset", targetId: ids.tenant });
    await prisma.operator.update({ where: { id: OP_ID }, data: { stepUpNonceHash: null, stepUpExpiresAt: null } });
    const res = await post("force-password-reset", { reason: "owner locked out, verified" }, grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("used");
  });

  it("a grant from an earlier operator session is refused (wrong_session), not spent", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.profile", targetId: `${ids.tenant}/${ids.owner}/name`, change: { name: "Dee Synthetic" } });
    await prisma.operator.update({ where: { id: OP_ID }, data: { sessionVersion: 1 } });
    h.jar.set("matflow_op_session", issueOperatorSession(OP_ID, 1));
    const res = await post("owner-profile", { name: "Dee Synthetic", reason: "placeholder name at signup" }, grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("wrong_session");
    expect((await operatorRow())?.stepUpNonceHash).toBe(sha256(nonceOf(grant)));
    expect((await ownerRow())?.name).toBe("Owner Edited Meanwhile");
  });
});
