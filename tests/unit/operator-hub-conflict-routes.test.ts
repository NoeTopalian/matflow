// Admin hub conflict routes (lane F, 9 Oct 2026; ledger AH-04, story I3):
//   POST /api/admin/customers/[id]/login-email/check            (who holds an address)
//   POST /api/admin/customers/[id]/members/[memberId]/contact-email (move a member)
//
// The operator moves a MEMBER's contact address so the owner's intended login
// address becomes free. Pinned here against the REAL route and the REAL
// lib/operator-step-up, lib/login-email, lib/admin-auth, lib/operator-auth,
// lib/csrf and lib/impersonation, over an in-memory club whose transaction
// stand-in undoes every write when the callback throws (the real rollback is
// proven on Postgres in tests/integration/operator-hub-conflict-db.test.ts):
//
//   - refusal classes: anonymous, club session, non-allowlisted operator,
//     support session, shared-secret sentinel, cross-tenant member (404) —
//     each with NOTHING written and the grant left unspent;
//   - harmless preflight before the spend: strict body, same address, held
//     address (operator sees the holder), stale version;
//   - grant bindings: member.contact_email / tenant / member / "change" /
//     the normalised new address / the member's version;
//   - ONE transaction: spend → version re-check → claim → conditional write →
//     token retirement (old + new, this club, sign-in purposes) → sessionVersion
//     bump only when the member can sign in → audit row; a failure anywhere
//     rolls back the write AND the spend;
//   - never touched: externalRef, status, passwordHash, TOTP, memberships;
//   - replay of a consumed grant → alreadyApplied, nothing changed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "operator-hub-contact-email-test-secret-0123456789";
  return {
    jar: new Map<string, string>(),
    ops: new Map<string, Record<string, unknown>>(),
    members: new Map<string, Record<string, unknown>>(),
    users: [] as Array<Record<string, unknown>>,
    resets: [] as Array<Record<string, unknown>>,
    links: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
    auditFail: false,
    auditFailDurable: false,
    memberUpdateError: null as null | Error,
    memberUpdateZero: false,
    emailWheres: [] as Array<Record<string, unknown>>,
    /** Called after each holder read ($queryRaw) — lets a test change the club mid-flight. */
    afterHolderRead: null as null | ((n: number) => void),
    holderReads: 0,
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

// ── a tiny where-matcher over plain rows ────────────────────────────────────
const matcher = vi.hoisted(() => {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [k, cond] of Object.entries(where)) {
      if (k === "OR") {
        if (!(cond as Record<string, unknown>[]).some((c) => matches(row, c))) return false;
        continue;
      }
      const v = row[k];
      if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { lt?: number; gt?: Date; in?: unknown[]; not?: unknown };
        if ("not" in c && c.not === null && (v === null || v === undefined)) return false;
        if (c.in !== undefined && !c.in.includes(v)) return false;
        if (c.lt !== undefined && !(typeof v === "number" && v < c.lt)) return false;
        if (c.gt !== undefined && !(v instanceof Date && v.getTime() > c.gt.getTime())) return false;
        continue;
      }
      if (v !== cond) return false;
    }
    return true;
  };
  const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in (v as Record<string, unknown>)) {
        row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
      } else row[k] = v;
    }
  };
  const pick = (row: Record<string, unknown>, select?: Record<string, unknown>) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };
  return { matches, apply, pick };
});

const opTable = vi.hoisted(() => ({
  findUnique: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
    const r = [...h.ops.values()].find((o) => matcher.matches(o, where));
    return r ? matcher.pick(r, select) : null;
  },
  update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const r = [...h.ops.values()].find((o) => matcher.matches(o, where));
    if (!r) throw new Error("not found");
    matcher.apply(r, data);
    return { ...r };
  },
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of h.ops.values()) if (matcher.matches(r, where)) { matcher.apply(r, data); count++; }
    return { count };
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { operator: opTable } }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: async (a: Record<string, unknown>) => {
    if (h.auditFail && a.tx) throw new Error("audit store unavailable");
    if (h.auditFailDurable && a.durable) throw new Error("audit store unavailable");
    h.audit.push(a);
  },
}));

// The club. Tenants t-a and t-b; owner u-owner in t-a; coach u-coach in t-a.
const club = {
  operator: opTable,
  auditLog: {
    findFirst: async ({ where }: { where: { tenantId: string; requestId: string; action: { in: string[] } } }) => {
      const row = [...h.audit].reverse().find(
        (a) => a.tenantId === where.tenantId && a.requestId === where.requestId && where.action.in.includes(a.action as string),
      );
      return row ? { action: row.action, metadata: row.metadata } : null;
    },
  },
  tenant: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      ["t-a", "t-b"].includes(where.id) ? { id: where.id, name: where.id === "t-a" ? "Club A" : "Club B" } : null,
  },
  user: {
    findFirst: async ({ where, select }: { where: Row; select?: Row }) => {
      const r = h.users.find((u) => matcher.matches(u, where));
      return r ? matcher.pick(r, select) : null;
    },
  },
  member: {
    findFirst: async ({ where, select }: { where: Row; select?: Row }) => {
      const r = [...h.members.values()].find((m) => matcher.matches(m, where));
      return r ? matcher.pick(r, select) : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (h.memberUpdateError && "email" in data) throw h.memberUpdateError;
      if ("email" in data) h.emailWheres.push({ ...where });
      if (h.memberUpdateZero && "email" in data) return { count: 0 };
      let count = 0;
      for (const m of h.members.values()) if (matcher.matches(m, where)) { matcher.apply(m, data); count++; }
      return { count };
    },
  },
  passwordResetToken: {
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const t of h.resets) if (matcher.matches(t, where)) { matcher.apply(t, data); count++; }
      return { count };
    },
    count: async ({ where }: { where: Row }) => h.resets.filter((t) => matcher.matches(t, where)).length,
  },
  magicLinkToken: {
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const t of h.links) if (matcher.matches(t, where)) { matcher.apply(t, data); count++; }
      return { count };
    },
    count: async ({ where }: { where: Row }) => h.links.filter((t) => matcher.matches(t, where)).length,
  },
  $executeRaw: async () => 1,
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    const [tenantId, emails] = values as [string, string[]];
    const key = (e: unknown) => String(e).trim().toLowerCase();
    let out: Row[] = [];
    if (/FROM "User"/.test(sql)) {
      out = h.users
        .filter((u) => u.tenantId === tenantId && emails.includes(key(u.email)))
        .map((u) => ({ id: u.id, name: u.name, role: u.role, key: key(u.email) }));
    } else if (/FROM "Member"/.test(sql)) {
      out = [...h.members.values()]
        .filter((m) => m.tenantId === tenantId && emails.includes(key(m.email)))
        .map((m) => ({ id: m.id, name: m.name, status: m.status, hasPassword: m.passwordHash != null, email: m.email, key: key(m.email) }));
    }
    h.holderReads += 1;
    h.afterHolderRead?.(h.holderReads);
    return out;
  },
};

// Transaction stand-in: one at a time (as two transactions on one Operator row
// are in Postgres), and on a throw every table is restored.
let txChain: Promise<unknown> = Promise.resolve();
function inTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const run = txChain.then(() => inTxNow(fn));
  txChain = run.catch(() => undefined);
  return run;
}
const clone = <T,>(m: Map<string, Record<string, unknown>>) => new Map([...m].map(([k, v]) => [k, { ...v }])) as T;
async function inTxNow<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const snap = {
    ops: clone<Map<string, Row>>(h.ops),
    members: clone<Map<string, Row>>(h.members),
    resets: h.resets.map((t) => ({ ...t })),
    links: h.links.map((t) => ({ ...t })),
    audit: h.audit.length,
  };
  try {
    return await fn(club);
  } catch (e) {
    h.ops.clear(); for (const [k, v] of snap.ops) h.ops.set(k, v);
    h.members.clear(); for (const [k, v] of snap.members) h.members.set(k, v);
    h.resets.splice(0, h.resets.length, ...snap.resets);
    h.links.splice(0, h.links.length, ...snap.links);
    h.audit.length = snap.audit;
    throw e;
  }
}
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) => inTx(fn),
  withTenantContext: async <T,>(_id: string, fn: (tx: unknown) => Promise<T>) => inTx(fn),
}));

import { issueOperatorSession } from "@/lib/operator-auth";
import { emailDigest } from "@/lib/login-email";
import { STEP_UP_ACTIONS, STEP_UP_HEADER, canonicalStepUpChange, issueStepUpGrant, resolveStepUpVersionDigest } from "@/lib/operator-step-up";
import { POST } from "@/app/api/admin/customers/[id]/members/[memberId]/contact-email/route";
import { POST as CHECK } from "@/app/api/admin/customers/[id]/login-email/check/route";

const ORIGIN = "http://localhost:3847";
const OLD = "pat@club.example";
const NEW = "pat.personal@club.example";
const REASON = "verified with the club by phone call-back; ticket 77";
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000);

function seedOperator(id = "op-noe") {
  h.ops.set(id, {
    id, email: `${id}@operator.test`, name: id, passwordHash: "x", role: "super_admin",
    totpEnabled: true, totpSecret: "unused-in-this-suite", totpLastUsedStep: null, failedLoginCount: 0,
    lockedUntil: null, sessionVersion: 0, stepUpNonceHash: null, stepUpExpiresAt: null,
  });
}

function seedClub() {
  h.users = [
    { id: "u-owner", tenantId: "t-a", role: "owner", name: "Owen Owner", email: "owner.old@club.example", createdAt: new Date(0) },
    { id: "u-coach", tenantId: "t-a", role: "coach", name: "Cole Coach", email: "coach@club.example", createdAt: new Date(1) },
  ];
  h.members = new Map<string, Row>([
    // Passwordless, imported: the owner's intended login address is HERS today.
    ["m-pat", { id: "m-pat", tenantId: "t-a", name: "Pat Imported", email: OLD, passwordHash: null, externalRef: "teamup:12345", status: "active", sessionVersion: 0, totpEnabled: false }],
    // Can sign in.
    ["m-quin", { id: "m-quin", tenantId: "t-a", name: "Quin Active", email: "quin@club.example", passwordHash: "$2a$hash", externalRef: "teamup:999", status: "active", sessionVersion: 4, totpEnabled: true }],
    // Another club.
    ["m-other", { id: "m-other", tenantId: "t-b", name: "Pat Elsewhere", email: OLD, passwordHash: null, externalRef: "teamup:12345", status: "active", sessionVersion: 0, totpEnabled: false }],
  ]);
  const t = (tenantId: string, email: string, extra: Row = {}) => ({ id: `${tenantId}:${email}:${Math.random()}`, tenantId, email, used: false, expiresAt: FUTURE(), ...extra });
  h.resets = [t("t-a", OLD), t("t-a", NEW), t("t-b", OLD), t("t-a", "quin@club.example")];
  h.links = [
    t("t-a", OLD, { purpose: "first_time_signup" }),
    t("t-a", OLD, { purpose: "login" }),
    t("t-a", OLD, { purpose: "waiver_open" }),
    t("t-a", NEW, { purpose: "first_time_signup" }),
    t("t-b", OLD, { purpose: "first_time_signup" }),
  ];
}

const target = (tenant: string, memberId: string) => `${tenant}/${memberId}/change`;
const versionOf = (tenant: string, memberId: string) => resolveStepUpVersionDigest("member.contact_email", target(tenant, memberId));
async function grantFor(memberId = "m-pat", newEmail = NEW, tenant = "t-a") {
  return (await issueStepUpGrant({ operatorId: "op-noe", action: "member.contact_email", targetId: target(tenant, memberId), change: { newEmail } })).grant;
}

function call(body: unknown, opts: { grant?: string | null; tenant?: string; memberId?: string; headers?: Record<string, string> } = {}) {
  const tenant = opts.tenant ?? "t-a";
  const memberId = opts.memberId ?? "m-pat";
  return POST(
    new Request(`${ORIGIN}/api/admin/customers/${tenant}/members/${memberId}/contact-email`, {
      method: "POST",
      headers: {
        origin: ORIGIN, host: "localhost:3847", "content-type": "application/json",
        ...(opts.grant ? { [STEP_UP_HEADER]: opts.grant } : {}),
        ...opts.headers,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: tenant, memberId }) },
  );
}
const nonce = () => h.ops.get("op-noe")!.stepUpNonceHash;
const snapshot = () => JSON.stringify({ m: [...h.members.values()], r: h.resets, l: h.links });
const outcomes = () => h.audit.filter((a) => a.action === "admin.member.contact_email.changed");

const savedEnv = { ...process.env };
beforeEach(() => {
  h.jar.clear();
  h.ops.clear();
  h.audit.length = 0;
  h.auditFail = false;
  h.auditFailDurable = false;
  h.memberUpdateError = null;
  h.memberUpdateZero = false;
  h.emailWheres.length = 0;
  h.afterHolderRead = null;
  h.holderReads = 0;
  delete process.env.OPERATOR_ALLOWED_IDS;
  process.env.MATFLOW_ADMIN_SECRET = "hub-test-shared-secret";
  seedOperator();
  seedClub();
  h.jar.set("matflow_op_session", issueOperatorSession("op-noe", 0));
});
afterEach(() => {
  process.env = { ...savedEnv };
  process.env.AUTH_SECRET = "operator-hub-contact-email-test-secret-0123456789";
});

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("member.contact_email step-up action", () => {
  it("is an action the grant route issues, with a strict { newEmail } change", () => {
    expect(STEP_UP_ACTIONS).toContain("member.contact_email");
    expect(canonicalStepUpChange("member.contact_email", { newEmail: "  Pat@Club.Example " })).toEqual({ newEmail: "pat@club.example" });
    expect(canonicalStepUpChange("member.contact_email", {})).toBeNull();
    expect(canonicalStepUpChange("member.contact_email", { newEmail: NEW, externalRef: "x" })).toBeNull();
  });

  it("the member version moves with the address, the import identity, the password and sessionVersion — not with a name edit", async () => {
    const v0 = await versionOf("t-a", "m-pat");
    expect(v0).toMatch(/^[a-f0-9]{64}$/);
    h.members.get("m-pat")!.name = "Renamed";
    expect(await versionOf("t-a", "m-pat")).toBe(v0);
    for (const [k, v] of [["email", "x@club.example"], ["externalRef", "teamup:1"], ["passwordHash", "h"], ["sessionVersion", 9]] as const) {
      seedClub();
      h.members.get("m-pat")![k] = v;
      expect(await versionOf("t-a", "m-pat"), k).not.toBe(v0);
    }
    expect(await versionOf("t-b", "m-pat")).toBeNull(); // another club's id space
  });
});

describe("refusals before anything is read or spent", () => {
  it("anonymous (no operator session): 403, nothing written", async () => {
    h.jar.clear();
    const before = snapshot();
    const res = await call({ newEmail: NEW, reason: REASON, version: "0".repeat(64) });
    expect(res.status).toBe(403);
    expect(snapshot()).toBe(before);
    expect(outcomes()).toHaveLength(0);
  });

  it("a club session (owner cookie, no operator session): 403", async () => {
    h.jar.clear();
    h.jar.set("authjs.session-token", "club-owner-jwt");
    const res = await call({ newEmail: NEW, reason: REASON, version: "0".repeat(64) });
    expect(res.status).toBe(403);
  });

  it("a non-allow-listed operator: generic 403, nothing written, grant unspent", async () => {
    const version = await versionOf("t-a", "m-pat");
    const grant = await grantFor();
    process.env.OPERATOR_ALLOWED_IDS = "op-someone-else";
    const before = snapshot();
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: "Forbidden" });
    expect(snapshot()).toBe(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a support session in this browser: 403 operator-plane message, nothing written, grant unspent", async () => {
    const version = await versionOf("t-a", "m-pat");
    const grant = await grantFor();
    h.jar.set("matflow_impersonation", "any-support-cookie");
    const before = snapshot();
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(403);
    expect(String((await body(res)).error)).toMatch(/end the support session/i);
    expect(snapshot()).toBe(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("the development shared secret (no named operator) cannot step up: 403", async () => {
    h.jar.clear();
    const version = await versionOf("t-a", "m-pat");
    const res = await call({ newEmail: NEW, reason: REASON, version }, { headers: { "x-admin-secret": "hub-test-shared-secret" } });
    expect(res.status).toBe(403);
    expect((await body(res)).stepUpRequired).toBe(true);
    expect(h.members.get("m-pat")!.email).toBe(OLD);
  });

  it("a cross-site request: 403 before the operator gate", async () => {
    const res = await call({ newEmail: NEW, reason: REASON, version: "0".repeat(64) }, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("preflight: answered with nothing written and the grant unspent", () => {
  let version = "";
  let grant = "";
  beforeEach(async () => {
    version = (await versionOf("t-a", "m-pat"))!;
    grant = await grantFor();
  });
  const unspent = () => expect(nonce()).toMatch(/^[a-f0-9]{64}$/);

  it.each([
    ["missing version", { newEmail: NEW, reason: REASON }],
    ["reason too short (after trim)", { newEmail: NEW, reason: "   short   ", version: "v" }],
    ["reason too long", { newEmail: NEW, reason: "x".repeat(501), version: "v" }],
    ["not an address", { newEmail: "not-an-address", reason: REASON, version: "v" }],
    ["oversized address", { newEmail: `${"a".repeat(120)}@club.example`, reason: REASON, version: "v" }],
    ["mass assignment: externalRef", { newEmail: NEW, reason: REASON, version: "v", externalRef: "teamup:0" }],
    ["mass assignment: status", { newEmail: NEW, reason: REASON, version: "v", status: "cancelled" }],
    ["client-chosen tenant", { newEmail: NEW, reason: REASON, version: "v", tenantId: "t-b" }],
  ])("400 on %s", async (_l, b) => {
    const before = snapshot();
    const res = await call(b, { grant });
    expect(res.status).toBe(400);
    expect(snapshot()).toBe(before);
    unspent();
  });

  it("a member of ANOTHER club named under this club: 404 before anything", async () => {
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant, memberId: "m-other" });
    expect(res.status).toBe(404);
    expect(h.members.get("m-other")!.email).toBe(OLD);
    unspent();
  });

  it("an unknown club: 404", async () => {
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant, tenant: "t-missing" });
    expect(res.status).toBe(404);
    unspent();
  });

  it("the same address (case and whitespace variants): 400", async () => {
    const res = await call({ newEmail: "  PAT@Club.Example ", reason: REASON, version }, { grant });
    expect(res.status).toBe(400);
    unspent();
  });

  // Review D1 (9 Oct 2026): records whose address the system manages are never
  // given a contact address here, and such an address is never a target.
  it.each([
    ["an erased record (GDPR sentinel)", "deleted-abc123@deleted.invalid"],
    ["a no-login child placeholder", "kid-m-pat@no-login.matflow.local"],
  ])("%s: 409 managed, nothing written, grant unspent", async (_l, managed) => {
    h.members.get("m-pat")!.email = managed;
    const v = (await versionOf("t-a", "m-pat"))!;
    const g = await grantFor();
    const res = await call({ newEmail: NEW, reason: REASON, version: v }, { grant: g });
    expect(res.status).toBe(409);
    expect((await body(res)).result).toBe("managed");
    expect(h.members.get("m-pat")!.email).toBe(managed);
    expect(outcomes()).toHaveLength(0);
    unspent();
  });

  it.each([
    ["an erasure sentinel", "deleted-zzz@deleted.invalid"],
    ["a no-login placeholder", "someone@no-login.matflow.local"],
  ])("%s as the NEW address: 400, nothing written, grant unspent", async (_l, target) => {
    const g = await grantFor("m-pat", target);
    const res = await call({ newEmail: target, reason: REASON, version }, { grant: g });
    expect(res.status).toBe(400);
    expect(h.members.get("m-pat")!.email).toBe(OLD);
    unspent();
  });

  it("an address someone else in the club holds: 409 naming the holder to the OPERATOR", async () => {
    const res = await call({ newEmail: "coach@club.example", reason: REASON, version }, { grant });
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b.holder).toMatchObject({ kind: "user", id: "u-coach" });
    expect(h.members.get("m-pat")!.email).toBe(OLD);
    unspent();
  });

  it("the member changed since the operator checked (version): 409", async () => {
    h.members.get("m-pat")!.sessionVersion = 1;
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(409);
    expect(String((await body(res)).error)).toMatch(/changed/i);
    unspent();
  });

  it("every response is private, no-store", async () => {
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant, memberId: "m-other" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("grant bindings (verified before the spend)", () => {
  it("no grant: 403 stepUpRequired, nothing written", async () => {
    const version = await versionOf("t-a", "m-pat");
    const res = await call({ newEmail: NEW, reason: REASON, version });
    expect(res.status).toBe(403);
    expect((await body(res)).stepUpRequired).toBe(true);
    expect(h.members.get("m-pat")!.email).toBe(OLD);
  });

  it("a grant for a DIFFERENT new address: 403 wrong_change, grant unspent", async () => {
    const version = await versionOf("t-a", "m-pat");
    const grant = await grantFor("m-pat", "someone.else@club.example");
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(403);
    expect((await body(res)).refusal).toBe("wrong_change");
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a grant for ANOTHER member: 403 wrong_target", async () => {
    const version = await versionOf("t-a", "m-pat");
    const grant = await grantFor("m-quin");
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(403);
    expect((await body(res)).refusal).toBe("wrong_target");
  });

  it("a grant for another action on the same member: 403 wrong_action", async () => {
    const version = await versionOf("t-a", "m-pat");
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "member.totp_reset", targetId: "t-a/m-pat" });
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(403);
    expect((await body(res)).refusal).toBe("wrong_action");
  });
});

describe("the change, in one transaction", () => {
  it("passwordless member: address moved; old + new sign-in tokens retired in THIS club; waiver kept; nothing else touched", async () => {
    const version = (await versionOf("t-a", "m-pat"))!;
    const grant = await grantFor();
    const before = { ...h.members.get("m-pat")! };
    const res = await call({ newEmail: "  Pat.Personal@Club.Example ", reason: `  ${REASON}  `, version }, { grant });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const b = await body(res);
    expect(b).toEqual({ ok: true, memberId: "m-pat", canSignIn: false, retired: { resetCodes: 2, signInLinks: 3 } });

    const after = h.members.get("m-pat")!;
    expect(after.email).toBe(NEW);
    // One write of the address, conditional on THIS club and the address just read.
    expect(h.emailWheres).toEqual([{ id: "m-pat", tenantId: "t-a", email: OLD }]);
    for (const k of ["externalRef", "status", "passwordHash", "sessionVersion", "totpEnabled", "name", "tenantId"]) {
      expect(after[k], k).toEqual(before[k]);
    }
    // Retired: reset codes + login + first_time_signup for OLD and NEW in t-a.
    expect(h.resets.filter((t) => t.tenantId === "t-a" && [OLD, NEW].includes(t.email as string)).every((t) => t.used)).toBe(true);
    expect(h.links.filter((t) => t.tenantId === "t-a" && t.purpose !== "waiver_open").every((t) => t.used)).toBe(true);
    // Kept: the waiver link, the other club's tokens, another member's code.
    expect(h.links.find((t) => t.purpose === "waiver_open")!.used).toBe(false);
    expect(h.resets.filter((t) => t.tenantId === "t-b").every((t) => !t.used)).toBe(true);
    expect(h.links.filter((t) => t.tenantId === "t-b").every((t) => !t.used)).toBe(true);
    expect(h.resets.find((t) => t.email === "quin@club.example")!.used).toBe(false);
    expect(h.members.get("m-other")!.email).toBe(OLD);
    // Grant spent.
    expect(nonce()).toBeNull();

    const rows = outcomes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "t-a",
      entityType: "Member",
      entityId: "m-pat",
      operatorId: "op-noe",
      actAsUserId: "op-noe",
      requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
      metadata: expect.objectContaining({
        reason: REASON,
        oldEmailDigest: emailDigest(OLD),
        newEmailDigest: emailDigest(NEW),
        canSignIn: false,
        unverified: false,
        sessionVersionAfter: 0,
        version,
      }),
    });
    expect(rows[0].tx).toBeDefined(); // written in the change's transaction
    expect(JSON.stringify(rows[0].metadata)).not.toContain("@");
  });

  it("member who can sign in: signed out everywhere (sessionVersion +1), recorded unverified; password untouched", async () => {
    const version = (await versionOf("t-a", "m-quin"))!;
    const grant = await grantFor("m-quin", "quin.new@club.example");
    const res = await call({ newEmail: "quin.new@club.example", reason: REASON, version }, { grant, memberId: "m-quin" });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true, memberId: "m-quin", canSignIn: true });
    const q = h.members.get("m-quin")!;
    expect(q).toMatchObject({ email: "quin.new@club.example", sessionVersion: 5, passwordHash: "$2a$hash", totpEnabled: true, externalRef: "teamup:999" });
    expect(h.resets.find((t) => t.email === "quin@club.example")!.used).toBe(true);
    expect(outcomes()[0].metadata).toMatchObject({ canSignIn: true, unverified: true, sessionVersionAfter: 5 });
  });

  it("replay of the consumed grant (lost response / double click): alreadyApplied, nothing changes", async () => {
    const version = (await versionOf("t-a", "m-quin"))!;
    const grant = await grantFor("m-quin", "quin.new@club.example");
    const first = await call({ newEmail: "quin.new@club.example", reason: REASON, version }, { grant, memberId: "m-quin" });
    expect(first.status).toBe(200);
    const state = snapshot();
    const replay = await call({ newEmail: "quin.new@club.example", reason: REASON, version }, { grant, memberId: "m-quin" });
    expect(replay.status).toBe(200);
    expect(await body(replay)).toMatchObject({ ok: true, alreadyApplied: true, memberId: "m-quin", canSignIn: true, recordedAction: "admin.member.contact_email.changed" });
    expect(snapshot()).toBe(state);
    expect(h.members.get("m-quin")!.sessionVersion).toBe(5); // ONE bump
    expect(outcomes()).toHaveLength(1);
  });

  it("two submissions at once with one grant: ONE change, ONE sessionVersion bump, the other answered from the record", async () => {
    const version = (await versionOf("t-a", "m-quin"))!;
    const grant = await grantFor("m-quin", "quin.new@club.example");
    const b = { newEmail: "quin.new@club.example", reason: REASON, version };
    const [r1, r2] = await Promise.all([call(b, { grant, memberId: "m-quin" }), call(b, { grant, memberId: "m-quin" })]);
    const bodies = [await body(r1), await body(r2)];
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(bodies.filter((x) => x.alreadyApplied === true)).toHaveLength(1);
    expect(h.members.get("m-quin")!.sessionVersion).toBe(5);
    expect(outcomes()).toHaveLength(1);
  });

  it("the record moved after the grant was issued: 409 stale, rolled back, grant unspent", async () => {
    const grant = await grantFor();
    h.members.get("m-pat")!.externalRef = "teamup:changed-by-refresh";
    const version = (await versionOf("t-a", "m-pat"))!; // a fresh check, but the GRANT is older
    const before = snapshot();
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(409);
    expect((await body(res)).refusal).toBe("stale");
    expect(snapshot()).toBe(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("the address is taken between preflight and the transaction: 409, rolled back, grant unspent", async () => {
    const version = (await versionOf("t-a", "m-pat"))!;
    const grant = await grantFor();
    // The preflight read is the first holder read; a member takes NEW right after it.
    h.afterHolderRead = (n) => {
      if (n === 2) h.members.set("m-late", { id: "m-late", tenantId: "t-a", name: "Late Comer", email: NEW, passwordHash: null, status: "active", sessionVersion: 0 });
    };
    const before = { ...h.members.get("m-pat")! };
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(409);
    expect(h.members.get("m-pat")).toEqual(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
    expect(outcomes()).toHaveLength(0);
  });

  it("a unique-constraint race (P2002) on the write: 409, rolled back, grant unspent", async () => {
    const version = (await versionOf("t-a", "m-pat"))!;
    const grant = await grantFor();
    h.memberUpdateError = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const before = snapshot();
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(409);
    expect(snapshot()).toBe(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("the conditional write matches nothing (address moved under it): 409, rolled back, grant unspent", async () => {
    const version = (await versionOf("t-a", "m-pat"))!;
    const grant = await grantFor();
    h.memberUpdateZero = true;
    const res = await call({ newEmail: NEW, reason: REASON, version }, { grant });
    expect(res.status).toBe(409);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
    expect(h.resets.every((t) => !t.used)).toBe(true);
  });

  it("the audit row cannot be written: 500, NOTHING changed (address, tokens, sessionVersion) and the grant is still usable", async () => {
    const version = (await versionOf("t-a", "m-quin"))!;
    const grant = await grantFor("m-quin", "quin.new@club.example");
    const before = snapshot();
    h.auditFail = true;
    const res = await call({ newEmail: "quin.new@club.example", reason: REASON, version }, { grant, memberId: "m-quin" });
    expect(res.status).toBe(500);
    expect(snapshot()).toBe(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
    h.auditFail = false;
    const retry = await call({ newEmail: "quin.new@club.example", reason: REASON, version }, { grant, memberId: "m-quin" });
    expect(retry.status).toBe(200);
    expect(h.members.get("m-quin")!.sessionVersion).toBe(5);
  });
});

describe("contact-email: the replay answer is never invented", () => {
  it("a grant for this member whose change never committed does not turn a refusal into alreadyApplied", async () => {
    const version = (await versionOf("t-a", "m-pat"))!;
    const grant = await grantFor("m-pat", OLD.toUpperCase()); // same address: refused in preflight
    const res = await call({ newEmail: OLD, reason: REASON, version }, { grant });
    expect(res.status).toBe(400);
    expect((await body(res)).alreadyApplied).toBeUndefined();
  });
});

// ── POST …/login-email/check ────────────────────────────────────────────────
function check(payload: unknown, opts: { tenant?: string; headers?: Record<string, string> } = {}) {
  const tenant = opts.tenant ?? "t-a";
  return CHECK(
    new Request(`${ORIGIN}/api/admin/customers/${tenant}/login-email/check`, {
      method: "POST",
      headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id: tenant }) },
  );
}
const checkedRows = () => h.audit.filter((a) => a.action === "admin.login_email.checked");

describe("login-email/check: refusals", () => {
  it.each([
    ["anonymous", () => h.jar.clear()],
    ["a club session", () => { h.jar.clear(); h.jar.set("authjs.session-token", "club-owner-jwt"); }],
    ["a non-allow-listed operator", () => { process.env.OPERATOR_ALLOWED_IDS = "op-someone-else"; }],
  ])("%s: 403 Forbidden, no holder data, no check row", async (_l, setup) => {
    setup();
    const res = await check({ email: OLD });
    expect(res.status).toBe(403);
    expect(await body(res)).toEqual({ error: "Forbidden" });
    expect(checkedRows()).toHaveLength(0);
  });

  it("a support session in this browser: 403, no holder data", async () => {
    h.jar.set("matflow_impersonation", "any-support-cookie");
    const res = await check({ email: OLD });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await body(res))).not.toMatch(/m-pat|Pat/);
    expect(checkedRows()).toHaveLength(0);
  });

  it("a cross-site request: 403", async () => {
    const res = await check({ email: OLD }, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it.each([
    ["no body", null],
    ["not an address", { email: "nope" }],
    ["oversized", { email: `${"a".repeat(120)}@club.example` }],
    ["unknown key", { email: OLD, tenantId: "t-b" }],
    ["two addresses", { email: [OLD, NEW] }],
  ])("400 on %s", async (_l, payload) => {
    const res = await check(payload);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("an unknown club, or a club with no owner: 404", async () => {
    expect((await check({ email: OLD }, { tenant: "t-missing" })).status).toBe(404);
    expect((await check({ email: OLD }, { tenant: "t-b" })).status).toBe(404); // t-b has no owner in the fixture
  });
});

describe("login-email/check: answers", () => {
  it("free: tenant and owner resolved on the server; private, no-store; the check row holds the keyed digest only", async () => {
    const res = await check({ email: "  Brand.New@Club.Example " });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await body(res)).toEqual({
      ok: true, free: true, sameAsOwner: false,
      tenant: { id: "t-a", name: "Club A" },
      owner: { id: "u-owner", name: "Owen Owner" },
    });
    const rows = checkedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "t-a", entityType: "Tenant", entityId: "t-a", durable: true, operatorId: "op-noe", actAsUserId: "op-noe",
      metadata: { emailDigest: emailDigest("brand.new@club.example"), result: "free", holderId: null },
    });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("@");
  });

  it("the owner's own address is free for the owner (sameAsOwner)", async () => {
    const res = await check({ email: "OWNER.OLD@club.example" });
    expect(await body(res)).toMatchObject({ free: true, sameAsOwner: true });
  });

  it("a passwordless member with a live invite: held, can ACTIVATE; link and opaque version, no address echoed", async () => {
    const res = await check({ email: OLD });
    const b = await body(res);
    expect(b).toMatchObject({
      ok: true, free: false,
      holder: {
        kind: "member", id: "m-pat", name: "Pat Imported", status: "active",
        canSignIn: true, access: "activation_pending", link: "/dashboard/members/m-pat",
        version: await versionOf("t-a", "m-pat"),
      },
    });
    expect(JSON.stringify(b.holder)).not.toContain("@");
    expect(checkedRows()[0].metadata).toMatchObject({ result: "member", holderId: "m-pat" });
  });

  it("the same member once every credential for the address is used or expired: cannot sign in", async () => {
    for (const t of h.resets) if (t.email === OLD) t.used = true;
    for (const t of h.links) if (t.email === OLD && t.tenantId === "t-a") t.expiresAt = new Date(Date.now() - 1000);
    // Club B still has a live invite to the same address: another person, it does not count here.
    const b = await body(await check({ email: OLD }));
    expect(b.holder).toMatchObject({ kind: "member", id: "m-pat", canSignIn: false, access: "none" });
  });

  it("a waiver link alone is not a sign-in credential", async () => {
    for (const t of h.resets) if (t.email === OLD) t.used = true;
    for (const t of h.links) if (t.email === OLD && t.tenantId === "t-a" && t.purpose !== "waiver_open") t.used = true;
    expect((await body(await check({ email: OLD }))).holder).toMatchObject({ canSignIn: false, access: "none" });
  });

  it("a member with a password: can sign in (password)", async () => {
    const b = await body(await check({ email: "quin@club.example" }));
    expect(b.holder).toMatchObject({ kind: "member", id: "m-quin", canSignIn: true, access: "password" });
  });

  it("a staff account: kind user, its role as status", async () => {
    const b = await body(await check({ email: "COACH@club.example" }));
    expect(b.holder).toEqual({ kind: "user", id: "u-coach", name: "Cole Coach", status: "coach", canSignIn: true, access: "password", link: "/dashboard/staff" });
  });

  it("a legacy duplicate (two rows on one canonical address): kind many with a count, nobody picked", async () => {
    h.members.set("m-dup", { id: "m-dup", tenantId: "t-a", name: "Pat Duplicate", email: " PAT@club.example", passwordHash: null, status: "active", sessionVersion: 0 });
    const b = await body(await check({ email: OLD }));
    expect(b).toMatchObject({ free: false, holder: { kind: "many", count: 2 } });
    expect(JSON.stringify(b.holder)).not.toMatch(/m-pat|m-dup/);
  });

  it("an address held only in ANOTHER club is free here (no cross-club answer)", async () => {
    h.members.delete("m-pat");
    const b = await body(await check({ email: OLD }));
    expect(b).toMatchObject({ free: true });
  });

  it("the check row cannot be written: 500 and NO holder data", async () => {
    h.auditFailDurable = true;
    const res = await check({ email: OLD });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await body(res))).not.toMatch(/m-pat|Pat|holder/);
  });

  it("a check writes nothing to the club and spends nothing", async () => {
    await grantFor();
    const before = snapshot();
    await check({ email: OLD });
    expect(snapshot()).toBe(before);
    expect(nonce()).toMatch(/^[a-f0-9]{64}$/);
  });
});
