// Operator step-up re-authentication (lane A, 6 Oct 2026; bindings, atomic
// spend and idempotent replay — admin hub lane C, 9 Oct 2026, ledger AH-03).
// Audit OPERATOR-ADMIN-SECURITY 2026-10-05 Q5: "Operator re-authentication:
// none at the moment of action."
//
// Pins, against the real routes and lib/operator-step-up.ts:
//   - the step-up route needs a full MFA session AND a fresh code (spent), and
//     a change that is valid for the action (checked BEFORE the code is spent);
//   - each Danger Zone route refuses without a grant, with NO tenant write;
//   - a grant is bound to operator + operator SESSION + action + target +
//     canonical CHANGE + subject VERSION, and expires after 5 minutes;
//   - it is spent INSIDE the route's transaction: an audit failure rolls back
//     the mutation AND the spend (the grant stays usable); a stale version
//     rolls back the spend (409);
//   - a replay of a grant whose mutation committed answers "already applied"
//     with the recorded result and changes nothing; without that record → used;
//   - the development shared secret (sentinel operator) can never step up.
// History: until 9 Oct 2026 the grant was spent by requireStepUp BEFORE the
// route's transaction and was bound to operator/action/target only; a replay
// was a bare 403 (pinned by "the replay is refused with no further write").
// Red on revert: drop the change-digest compare and "wrong_change" fails; drop
// the sv compare and "wrong_session" fails; spend outside the transaction and
// "audit failure rolls back the spend" fails; drop replayActions and the replay
// cases fail.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { generateSecret, generateSync } from "otplib";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "operator-step-up-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    ops: new Map<string, Record<string, unknown>>(),
    writes: [] as string[],
    audit: [] as Array<Record<string, unknown>>,
    auditFail: false,
    ownerSv: 0,
    ownerName: "Owner",
  };
});

const tableFactory = vi.hoisted(() => (ops: Map<string, Record<string, unknown>>) => {
  type Row = Record<string, unknown>;
  const matches = (row: Row, where: Row): boolean => {
    for (const [k, cond] of Object.entries(where)) {
      if (k === "OR") {
        if (!(cond as Row[]).some((c) => matches(row, c))) return false;
        continue;
      }
      const v = row[k];
      if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { lt?: number; gt?: Date };
        if (c.lt !== undefined && !(typeof v === "number" && v < c.lt)) return false;
        if (c.gt !== undefined && !(v instanceof Date && v.getTime() > c.gt.getTime())) return false;
        continue;
      }
      if (v !== cond) return false;
    }
    return true;
  };
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
      else row[k] = v;
    }
  };
  const findRow = (where: Row) => [...ops.values()].find((r) => matches(r, where));
  return {
    findUnique: async ({ where }: { where: Row }) => {
      const r = findRow(where);
      return r ? { ...r } : null;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = findRow(where);
      if (!r) throw new Error("not found");
      apply(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const r of ops.values()) if (matches(r, where)) { apply(r, data); count++; }
      return { count };
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { operator: tableFactory(h.ops) } }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: async (a: Record<string, unknown>) => {
    if (h.auditFail && a.action !== "admin.operator.step_up_refused") throw new Error("audit store unavailable");
    h.audit.push(a);
  },
}));

// Club data the Danger Zone routes touch. Every WRITE is recorded.
const club = {
  operator: tableFactory(h.ops),
  // Replay lookup (findAppliedGrant) over the rows the mocked logAudit kept.
  auditLog: {
    findFirst: async ({ where }: { where: { tenantId: string; requestId: string; action: { in: string[] } } }) => {
      const row = [...h.audit].reverse().find(
        (a) => a.tenantId === where.tenantId && a.requestId === where.requestId && where.action.in.includes(a.action as string),
      );
      return row ? { action: row.action, metadata: row.metadata } : null;
    },
  },
  tenant: {
    findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: "Club Name" }),
    // suspend (lane H, 6 Oct 2026)
    updateMany: async ({ where }: { where: { id: string } }) => { h.writes.push(`tenant.updateMany:${where.id}`); return { count: 1 }; },
  },
  user: {
    findFirst: async ({ where }: { where: { id?: string; role?: string } }) =>
      where.role === "owner"
        ? { id: "u-owner", email: "owner@example.test", name: h.ownerName, totpEnabled: true, sessionVersion: h.ownerSv, loginEmailProvisionalSince: null }
        : { id: where.id ?? "u-target", email: "staff@example.test", name: "Staff", role: "manager", sessionVersion: 0 },
    findUnique: async () => ({ passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1yJ0Q0m0m0m0m0m0m0m0m0m0m0m0m" }),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      h.writes.push(`user.update:${where.id}:${Object.keys(data).sort().join(",")}`);
      if (where.id === "u-owner" && data.sessionVersion) h.ownerSv += 1;
      return { ...data, sessionVersion: where.id === "u-owner" ? h.ownerSv : 1 };
    },
    updateMany: async ({ where, data }: { where: { id?: string; name?: string }; data: Record<string, unknown> }) => {
      h.writes.push("user.updateMany");
      if (where.id === "u-owner" && typeof data.name === "string") {
        if (where.name !== undefined && where.name !== h.ownerName) return { count: 0 };
        h.ownerName = data.name;
      }
      return { count: 1 };
    },
  },
  member: {
    findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, email: "m@example.test", name: "Member", totpEnabled: true, sessionVersion: 0 }),
    update: async ({ where }: { where: { id: string } }) => { h.writes.push(`member.update:${where.id}`); return { sessionVersion: 1 }; },
    findMany: async () => [],
    updateMany: async () => { h.writes.push("member.updateMany"); return { count: 0 }; },
  },
  passwordHistory: { create: async () => { h.writes.push("passwordHistory.create"); return {}; } },
};
// A transaction stand-in: on a throw, every write it made is undone (the
// Operator row, the recorded writes, the audit rows, the owner's state) — so
// "rolled back" is observable here. The real rollback is proven on Postgres in
// tests/integration/operator-step-up-db.test.ts.
// Transactions run one at a time, as two transactions updating the same
// Operator row do in Postgres (the second waits for the first's row lock).
let txChain: Promise<unknown> = Promise.resolve();
function inTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const run = txChain.then(() => inTxNow(fn));
  txChain = run.catch(() => undefined);
  return run;
}
async function inTxNow<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const ops = new Map([...h.ops].map(([k, v]) => [k, { ...v }]));
  const writes = h.writes.length;
  const audit = h.audit.length;
  const owner = { sv: h.ownerSv, name: h.ownerName };
  try {
    return await fn(club);
  } catch (e) {
    h.ops.clear();
    for (const [k, v] of ops) h.ops.set(k, v);
    h.writes.length = writes;
    h.audit.length = audit;
    h.ownerSv = owner.sv;
    h.ownerName = owner.name;
    throw e;
  }
}
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) => inTx(fn),
  withTenantContext: async <T,>(_id: string, fn: (tx: unknown) => Promise<T>) => inTx(fn),
}));

import { issueOperatorSession, issueOperatorEnrolmentSession } from "@/lib/operator-auth";
import {
  STEP_UP_HEADER,
  canonicalStepUpChange,
  consumeStepUpGrant,
  issueStepUpGrant,
  requireStepUp,
  type StepUpAction,
  type VerifiedStepUp,
} from "@/lib/operator-step-up";
import { withRlsBypass } from "@/lib/prisma-tenant";

const ORIGIN = "http://localhost:3847";
let SECRET = "";

function seed(id = "op-noe") {
  SECRET = generateSecret();
  h.ops.set(id, {
    id, email: `${id}@example.test`, name: id, passwordHash: "x", role: "super_admin",
    totpEnabled: true, totpSecret: SECRET, totpLastUsedStep: null, failedLoginCount: 0,
    lockedUntil: null, sessionVersion: 0, stepUpNonceHash: null, stepUpExpiresAt: null,
  });
}

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}

type Case = { name: string; action: StepUpAction; file: string; tenant: string; body: Record<string, unknown>; target: string; outcome: string };
const CASES: Case[] = [
  { name: "force-password-reset", action: "owner.force_password_reset", file: "force-password-reset", tenant: "t-a", body: { reason: "verified by call-back" }, target: "t-a", outcome: "admin.owner.force_password_reset" },
  { name: "owner totp-reset", action: "owner.totp_reset", file: "totp-reset", tenant: "t-a", body: { reason: "verified by call-back", confirmName: "Club Name" }, target: "t-a", outcome: "admin.owner.totp_reset" },
  { name: "member-totp-reset", action: "member.totp_reset", file: "member-totp-reset", tenant: "t-a", body: { memberId: "m-1", reason: "verified by call-back", confirmName: "Club Name" }, target: "t-a/m-1", outcome: "admin.member.totp_reset" },
  { name: "transfer-ownership", action: "tenant.transfer_ownership", file: "transfer-ownership", tenant: "t-a", body: { targetUserId: "u-target", reason: "verified by call-back", confirmName: "Club Name" }, target: "t-a/u-target", outcome: "admin.tenant.ownership_transferred" },
  // Review recommendation (lane H, 6 Oct 2026): suspending a club signs out every user and member of it.
  { name: "suspend", action: "tenant.suspend", file: "suspend", tenant: "t-a", body: { reason: "verified by call-back" }, target: "t-a", outcome: "admin.tenant.suspended" },
];

async function route(c: Case) {
  const mod = (await import(`@/app/api/admin/customers/[id]/${c.file}/route`)) as { POST: (r: Request, x: { params: Promise<{ id: string }> }) => Promise<Response> };
  return (grant: string | null, tenant = c.tenant, body = c.body) =>
    mod.POST(
      post(`/api/admin/customers/${tenant}/${c.file}`, body, grant ? { [STEP_UP_HEADER]: grant } : {}),
      { params: Promise.resolve({ id: tenant }) },
    );
}
const nonceHash = () => h.ops.get("op-noe")!.stepUpNonceHash;
const refusals = () => h.audit.filter((a) => a.action === "admin.operator.step_up_refused").map((a) => (a.metadata as { refusal: string }).refusal);

beforeEach(() => {
  h.jar.clear();
  h.ops.clear();
  h.writes.length = 0;
  h.audit.length = 0;
  h.auditFail = false;
  h.ownerSv = 0;
  h.ownerName = "Owner";
  seed();
  h.jar.set("matflow_op_session", issueOperatorSession("op-noe", 0));
  process.env.MATFLOW_ADMIN_SECRET = "step-up-test-shared-secret";
});
afterEach(() => vi.useRealTimers());

describe.each(CASES)("$name", (c) => {
  it("refuses with no grant, and writes nothing to the club", async () => {
    const res = await (await route(c))(null);
    expect(res.status).toBe(403);
    expect((await res.json()).stepUpRequired).toBe(true);
    expect(h.writes).toEqual([]);
  });

  // Flipped 9 Oct 2026 (lane C): the replay used to be a bare 403. It now
  // finds the outcome row by the grant's request id and echoes it — still no
  // further write.
  it("proceeds with a valid grant, once; the replay is answered 'already applied' with no further write", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const call = await route(c);
    const ok = await call(grant);
    expect(ok.status).toBe(200);
    const after = [...h.writes];
    expect(after.length).toBeGreaterThan(0);
    const row = h.audit.find((a) => a.action === c.outcome)!;
    expect(row).toMatchObject({ operatorId: "op-noe", requestId: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const replay = await call(grant);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, alreadyApplied: true, recordedAction: c.outcome });
    expect(h.writes).toEqual(after);
    expect(h.audit.filter((a) => a.action === c.outcome)).toHaveLength(1);
  });

  it("refuses a grant for the same action on ANOTHER target", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-other" + c.target.slice(3) });
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses a grant for a DIFFERENT action on the same target", async () => {
    const other: StepUpAction = c.action === "owner.totp_reset" ? "owner.force_password_reset" : "owner.totp_reset";
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: other, targetId: c.target });
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses an expired grant (older than 5 minutes)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    // Keep the session valid at the new time.
    h.jar.set("matflow_op_session", issueOperatorSession("op-noe", 0));
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("expired");
    expect(h.writes).toEqual([]);
  });

  it("refuses another operator's grant", async () => {
    seed("op-other");
    const { grant } = await issueStepUpGrant({ operatorId: "op-other", action: c.action, targetId: c.target });
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses a grant issued to an EARLIER session of the same operator (wrong_session)", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    // Signed out everywhere and signed in again: new sessionVersion, new cookie.
    h.ops.get("op-noe")!.sessionVersion = 1;
    h.jar.set("matflow_op_session", issueOperatorSession("op-noe", 1));
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("wrong_session");
    expect(h.writes).toEqual([]);
    expect(refusals()).toContain("wrong_session");
  });

  it("refuses the development shared secret (no named operator, no authenticator)", async () => {
    h.jar.clear();
    h.jar.set("matflow_admin", "step-up-test-shared-secret");
    const res = await (await route(c))("anything");
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("an audit failure rolls back the mutation AND the spend: the grant stays usable", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const before = nonceHash();
    h.auditFail = true;
    const res = await (await route(c))(grant);
    expect(res.status).toBe(500);
    expect(h.writes).toEqual([]);
    expect(nonceHash()).toBe(before);
    h.auditFail = false;
    expect((await (await route(c))(grant)).status).toBe(200);
  });
});

describe("substitution of the person inside the club", () => {
  it("a member-totp-reset grant for member m-1 cannot reset member m-2", async () => {
    const c = CASES[2];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-a/m-1" });
    const res = await (await route(c))(grant, "t-a", { ...c.body, memberId: "m-2" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a transfer grant to u-target cannot hand the club to u-someone-else", async () => {
    const c = CASES[3];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-a/u-target" });
    const res = await (await route(c))(grant, "t-a", { ...c.body, targetUserId: "u-someone-else" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a grant for one club cannot be spent on another (tenant substitution)", async () => {
    const c = CASES[1];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-a" });
    const res = await (await route(c))(grant, "t-b");
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("wrong_target");
  });
});

describe("record version (the subject as confirmed)", () => {
  it("the owner's credentials moved after the grant was issued → 409 stale, nothing written, grant NOT spent", async () => {
    const c = CASES[0];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const before = nonceHash();
    h.ownerSv = 7; // e.g. the owner changed their own password meanwhile
    const res = await (await route(c))(grant);
    expect(res.status).toBe(409);
    expect((await res.json()).refusal).toBe("stale");
    expect(h.writes).toEqual([]);
    expect(nonceHash()).toBe(before);
  });

  it("owner-profile: a grant for one name cannot set another (wrong_change); the grant is not spent", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/owner-profile/route");
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.profile", targetId: "t-a/u-owner/name", change: { name: "Ann Smith" } });
    const before = nonceHash();
    const res = await POST(
      post("/api/admin/customers/t-a/owner-profile", { name: "Mallory", reason: "placeholder name at signup" }, { [STEP_UP_HEADER]: grant }),
      { params: Promise.resolve({ id: "t-a" }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("wrong_change");
    expect(nonceHash()).toBe(before);
    expect(h.ownerName).toBe("Owner");
    const ok = await POST(
      post("/api/admin/customers/t-a/owner-profile", { name: "  Ann Smith ", reason: "placeholder name at signup" }, { [STEP_UP_HEADER]: grant }),
      { params: Promise.resolve({ id: "t-a" }) },
    );
    expect(ok.status).toBe(200);
    expect(h.ownerName).toBe("Ann Smith");
  });
});

describe("change binding (requireStepUp)", () => {
  const verify = (grant: string, change: unknown, sessionVersion = 0) =>
    requireStepUp(
      new Request(ORIGIN + "/x", { headers: { [STEP_UP_HEADER]: grant } }),
      { operatorId: "op-noe", named: true, sessionVersion },
      "owner.login_email",
      "t-a/u-owner/change",
      { change },
    );

  it("same operator, same target, DIFFERENT new email → wrong_change", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.login_email", targetId: "t-a/u-owner/change", change: { newEmail: "real@club.test" } });
    const res = await verify(grant, { newEmail: "attacker@evil.test" });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
    expect(await (res as Response).json()).toMatchObject({ refusal: "wrong_change" });
  });

  it("the same address in another case / with spaces is the same change (one normalisation)", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.login_email", targetId: "t-a/u-owner/change", change: { newEmail: "  Real@Club.TEST " } });
    const res = await verify(grant, { newEmail: "real@club.test" });
    expect(res).not.toBeInstanceOf(Response);
    expect((res as VerifiedStepUp).requestId).toBe(nonceHash());
  });

  it("an empty change cannot stand in for a change of address, nor the reverse", async () => {
    const empty = (await issueStepUpGrant({ operatorId: "op-noe", action: "owner.login_email", targetId: "t-a/u-owner/change", change: {} })).grant;
    expect(((await verify(empty, { newEmail: "real@club.test" })) as Response).status).toBe(403);
    const full = (await issueStepUpGrant({ operatorId: "op-noe", action: "owner.login_email", targetId: "t-a/u-owner/change", change: { newEmail: "real@club.test" } })).grant;
    expect(((await verify(full, {})) as Response).status).toBe(403);
  });

  it("the grant payload carries no address (keyed digest only)", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.login_email", targetId: "t-a/u-owner/change", change: { newEmail: "real@club.test" } });
    const payload = Buffer.from(grant.split(".")[0], "base64url").toString("utf8");
    expect(payload).not.toMatch(/real@club\.test|owner@example\.test/);
    expect(JSON.parse(payload)).toMatchObject({ v: 2, sv: 0, chg: expect.stringMatching(/^[a-f0-9]{64}$/), ver: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("requireStepUp spends nothing (verification only)", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.login_email", targetId: "t-a/u-owner/change", change: { newEmail: "real@club.test" } });
    const before = nonceHash();
    await verify(grant, { newEmail: "real@club.test" });
    expect(nonceHash()).toBe(before);
  });

  it("unknown keys or the wrong shape are not a change for the action", () => {
    expect(canonicalStepUpChange("owner.profile", { name: "A", role: "owner" })).toBeNull();
    expect(canonicalStepUpChange("owner.totp_reset", { anything: 1 })).toBeNull();
    expect(canonicalStepUpChange("owner.login_email", { newEmail: "not-an-address" })).toBeNull();
  });
});

describe("single use and replay", () => {
  async function verified(action: StepUpAction = "owner.totp_reset", target = "t-a") {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action, targetId: target });
    const v = await requireStepUp(new Request(ORIGIN, { headers: { [STEP_UP_HEADER]: grant } }), { operatorId: "op-noe", named: true, sessionVersion: 0 }, action, target, { change: {} });
    return { grant, v: v as VerifiedStepUp };
  }

  it("two concurrent spends of one grant: exactly one is spent, the other is refused as used", async () => {
    const { v } = await verified();
    const results = await Promise.allSettled([
      withRlsBypass((tx) => consumeStepUpGrant(tx as never, v)),
      withRlsBypass((tx) => consumeStepUpGrant(tx as never, v)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ reason: "used" });
  });

  it("issuing a new grant supersedes the outstanding one", async () => {
    const first = await verified();
    await issueStepUpGrant({ operatorId: "op-noe", action: "owner.totp_reset", targetId: "t-a" });
    await expect(withRlsBypass((tx) => consumeStepUpGrant(tx as never, first.v))).rejects.toMatchObject({ reason: "used" });
  });

  it("a replayed grant with NO recorded outcome is refused as used (403), nothing written", async () => {
    const c = CASES[1];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    h.ops.get("op-noe")!.stepUpNonceHash = null; // spent elsewhere, its change never committed
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toBe("used");
    expect(h.writes).toEqual([]);
  });

  it("double-click: two concurrent submissions of one grant → ONE mutation, ONE sessionVersion bump", async () => {
    const c = CASES[0];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const call = await route(c);
    const [a, b] = await Promise.all([call(grant), call(grant)]);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()];
    expect(bodies.filter((x) => x.alreadyApplied === true)).toHaveLength(1);
    expect(bodies.filter((x) => typeof x.tempPassword === "string")).toHaveLength(1);
    expect(h.ownerSv).toBe(1);
    expect(h.writes.filter((w) => w.startsWith("user.update:u-owner:"))).toHaveLength(1);
  });

  it("the force-password-reset temporary password carries a 72-hour expiry, and a replay never re-shows it", async () => {
    const c = CASES[0];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const before = Date.now();
    const call = await route(c);
    const res = await call(grant);
    const data = (await res.json()) as { tempPasswordExpiresAt: string };
    const at = new Date(data.tempPasswordExpiresAt).getTime();
    expect(at - before).toBeGreaterThanOrEqual(72 * 3600 * 1000 - 1000);
    expect(at - before).toBeLessThanOrEqual(72 * 3600 * 1000 + 5000);
    expect(h.writes.some((w) => w.startsWith("user.update:u-owner:") && w.includes("tempPasswordExpiresAt"))).toBe(true);
    const replay = (await (await call(grant)).json()) as Record<string, unknown>;
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.tempPassword).toBeUndefined();
    expect(JSON.stringify(h.audit)).not.toContain((data as unknown as { tempPassword: string }).tempPassword);
  });
});

describe("POST /api/admin/auth/step-up", () => {
  async function stepUp(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/admin/auth/step-up/route");
    return POST(post("/api/admin/auth/step-up", body));
  }

  it("issues a grant for a fresh code, and the same code cannot buy a second grant", async () => {
    const code = generateSync({ secret: SECRET });
    const first = await stepUp({ action: "owner.totp_reset", targetId: "t-a", change: {}, code });
    expect(first.status).toBe(200);
    const { grant } = (await first.json()) as { grant: string };
    expect(typeof grant).toBe("string");
    expect(h.audit.map((a) => a.action)).toContain("admin.operator.step_up");

    const again = await stepUp({ action: "owner.totp_reset", targetId: "t-a", change: {}, code });
    expect(again.status).toBe(401);
  });

  it("D5: the issuance row is DURABLE (awaited, throws), written before the grant exists", async () => {
    const code = generateSync({ secret: SECRET });
    const res = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
    expect(res.status).toBe(200);
    const row = h.audit.find((a) => a.action === "admin.operator.step_up");
    expect(row).toMatchObject({ durable: true, tenantId: null, entityId: "op-noe", operatorId: "op-noe" });
  });

  it("D5: if the issuance row cannot be written, no grant is issued or returned", async () => {
    h.auditFail = true;
    const code = generateSync({ secret: SECRET });
    const res = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant).toBeUndefined();
    expect(h.ops.get("op-noe")!.stepUpNonceHash).toBeNull();
  });

  it("an invalid change for the action is refused BEFORE the code is spent", async () => {
    const code = generateSync({ secret: SECRET });
    for (const change of [{ name: "x", role: "owner" }, {}]) {
      const res = await stepUp({ action: "owner.profile", targetId: "t-a/u-owner/name", change, code });
      expect(res.status).toBe(400);
    }
    expect(h.ops.get("op-noe")!.totpLastUsedStep).toBeNull();
    expect((await stepUp({ action: "owner.profile", targetId: "t-a/u-owner/name", change: { name: "Ann" }, code })).status).toBe(200);
  });

  it("refuses unknown body keys (strict)", async () => {
    const code = generateSync({ secret: SECRET });
    expect((await stepUp({ action: "owner.totp_reset", targetId: "t-a", code, operatorId: "op-other" })).status).toBe(400);
  });

  it("refuses a wrong code", async () => {
    expect((await stepUp({ action: "owner.totp_reset", targetId: "t-a", code: "000000" })).status).toBe(401);
    expect(h.ops.get("op-noe")!.stepUpNonceHash).toBeNull();
  });

  it("refuses without a full session: enrolment cookie, shared secret, nothing", async () => {
    const code = generateSync({ secret: SECRET });
    for (const jar of [
      { matflow_op_enrol: issueOperatorEnrolmentSession("op-noe", 0) },
      { matflow_admin: "step-up-test-shared-secret" },
      {},
    ]) {
      h.jar = new Map(Object.entries(jar));
      const res = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
      expect(res.status).toBe(401);
    }
    expect(h.ops.get("op-noe")!.stepUpNonceHash).toBeNull();
  });

  it("refuses a cross-origin request", async () => {
    const { POST } = await import("@/app/api/admin/auth/step-up/route");
    const res = await POST(new Request("https://matflow.studio/api/admin/auth/step-up", {
      method: "POST",
      headers: { origin: "https://evil.matflow.studio", host: "matflow.studio", "content-type": "application/json" },
      body: JSON.stringify({ action: "owner.totp_reset", targetId: "t-a", code: generateSync({ secret: SECRET }) }),
    }));
    expect(res.status).toBe(403);
  });
});

describe("UI grant-request payloads (pinned)", () => {
  const src = (f: string) => readFileSync(`app/admin/tenants/[id]/${f}`, "utf8");
  it("every step-up request declares the canonical change the route re-derives", () => {
    expect(src("DangerZone.tsx")).toMatch(/JSON\.stringify\(\{ action: args\.stepUpAction, targetId: args\.targetId, change: args\.change \?\? \{\}, code: args\.code\.trim\(\) \}\)/);
    expect(src("LoginEmailCard.tsx")).toMatch(/change: mode === "change" \? \{ newEmail: newEmail\.trim\(\) \} : \{\},/);
    expect(src("LoginEmailCard.tsx")).toMatch(/\{ action: mode, reason: reason\.trim\(\), newEmail: newEmail\.trim\(\) \}/);
    expect(src("OwnerProfileCard.tsx")).toMatch(/change: \{ name: trimmed \}/);
    expect(src("OwnerProfileCard.tsx")).toMatch(/JSON\.stringify\(\{ name: trimmed, reason: reason\.trim\(\) \}\)/);
    expect(src("LoginAsOwnerButton.tsx")).toMatch(/change: \{\},/);
  });
});

describe("suspend: step-up on POST only (lane H, 6 Oct 2026)", () => {
  it("DELETE (un-suspend, the recovery direction) does not ask for a step-up grant", async () => {
    const mod = (await import("@/app/api/admin/customers/[id]/suspend/route")) as { DELETE: (r: Request, x: { params: Promise<{ id: string }> }) => Promise<Response> };
    const res = await mod.DELETE(
      new Request(ORIGIN + "/api/admin/customers/t-a/suspend", { method: "DELETE", headers: { origin: ORIGIN, host: "localhost:3847" } }),
      { params: Promise.resolve({ id: "t-a" }) },
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.stepUpRequired).toBeUndefined();
  });

  it("tenant.suspend is a step-up action", async () => {
    const { STEP_UP_ACTIONS } = await import("@/lib/operator-step-up");
    expect(STEP_UP_ACTIONS).toContain("tenant.suspend");
  });
});
