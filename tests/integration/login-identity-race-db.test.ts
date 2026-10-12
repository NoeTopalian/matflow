// Cross-table login-identity claims under real concurrency (admin hub ledger
// AH-01, 9 Oct 2026).
//
// A login address is one identity per club across BOTH tables: auth.ts looks
// the address up in User and in Member and a User row wins. `User.email` and
// `Member.email` each carry their own `@@unique([tenantId, email])`, and two
// separate unique indexes do not make the PAIR unique — before the claim lock,
// a staff writer and a member writer that each checked the other table found
// nothing (the other side was uncommitted), and both committed.
//
// Shape of every cell: the HOLDER is a real route handler paused INSIDE its
// own transaction just after its write (a hook on a call it makes inside the
// transaction); the COMPETITOR is a second real route handler on its own
// connection. The barrier is deterministic: the competitor is either seen
// blocked on a lock in pg_stat_activity, or it has already finished — only
// then is the holder released. The assertions are on the database afterwards.
//
// Red run (before claimLoginIdentity existed, 9 Oct 2026): the cross-table
// cells committed BOTH writers — the address had two holders. Kept as the
// history of this file; the cells now assert the protection.
//
// Synthetic clubs only (unique slugs, example.test addresses), removed in
// afterAll through the tenant purge path. Run with the TEST-branch runners
// (owner role AND restricted matflow_app role); skips without a DB.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// One pause point armed at a time; the first call of the armed kind waits.
const pause = {
  armed: null as null | "status" | "statusBulk" | "auditTx",
  held: deferred(),
  release: deferred(),
};
function arm(kind: "status" | "statusBulk" | "auditTx") {
  pause.armed = kind;
  pause.held = deferred();
  pause.release = deferred();
}
async function maybePause(kind: "status" | "statusBulk" | "auditTx") {
  if (pause.armed !== kind) return;
  pause.armed = null;
  pause.held.resolve();
  await pause.release.promise;
}

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...mod, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 })) };
});
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (args: { tx?: unknown }) => {
    if (args && args.tx) await maybePause("auditTx");
  }),
}));
vi.mock("@/lib/member-status", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/member-status")>();
  return {
    ...mod,
    recordStatusEvent: vi.fn(async (...args: Parameters<typeof mod.recordStatusEvent>) => {
      await maybePause("status");
      return mod.recordStatusEvent(...args);
    }),
    recordStatusEventsBulk: vi.fn(async (...args: Parameters<typeof mod.recordStatusEventsBulk>) => {
      await maybePause("statusBulk");
      return mod.recordStatusEventsBulk(...args);
    }),
  };
});
const FILES = new Map<string, string>();
vi.mock("@/lib/import-storage", () => ({
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));
const gate = { tenantId: "", userId: "" };
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: { user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } } })),
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined), get: vi.fn(async () => null) }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: false, status: 500, error: "no Stripe in tests" })),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { purgeTenantById } from "@/lib/tenant-purge";
import { POST as createMember } from "@/app/api/members/route";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";
import { POST as createStaff } from "@/app/api/staff/route";
import { PATCH as patchStaff } from "@/app/api/staff/[id]/route";
import { POST as commitImport } from "@/app/api/admin/import/[id]/commit/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `lir${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const STRONG = "Race-Temp-Pass-42";
const created: string[] = [];
let seq = 0;
const addr = (label: string) => `${STAMP}-${label}-${++seq}@example.test`;

type Club = { tenantId: string; ownerId: string; coachId: string; coachEmail: string; memberId: string; memberEmail: string };

async function mkClub(label: string): Promise<Club> {
  return withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, onboardingCompleted: true } });
    created.push(t.id);
    const owner = await tx.user.create({ data: { tenantId: t.id, email: addr("owner"), name: "Owner Synthetic", role: "owner", passwordHash: "x" } });
    const coachEmail = addr("coach");
    const coach = await tx.user.create({ data: { tenantId: t.id, email: coachEmail, name: "Coach Synthetic", role: "coach", passwordHash: "x" } });
    const memberEmail = addr("member");
    const member = await tx.member.create({ data: { tenantId: t.id, name: "Member Synthetic", email: memberEmail } });
    return { tenantId: t.id, ownerId: owner.id, coachId: coach.id, coachEmail, memberId: member.id, memberEmail };
  });
}

function signInAsOwner(c: Club) {
  mockAuth.mockResolvedValue({ user: { id: c.ownerId, tenantId: c.tenantId, role: "owner", email: "owner" } } as never);
  gate.tenantId = c.tenantId;
  gate.userId = c.ownerId;
}

function req(method: string, body: unknown): Request {
  return new Request("https://test.local/api/x", {
    method,
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Every row in this club that holds `email` as a login, across both tables. */
async function holders(tenantId: string, email: string) {
  return withRlsBypass(async (tx) => {
    const [users, members] = await Promise.all([
      tx.user.findMany({ where: { tenantId, email }, select: { id: true } }),
      tx.member.findMany({ where: { tenantId, email }, select: { id: true } }),
    ]);
    return [...users.map((u) => ({ kind: "user", id: u.id })), ...members.map((m) => ({ kind: "member", id: m.id }))];
  });
}

/**
 * Resolves "blocked" once some backend in this database is waiting on a lock
 * for the advisory claim or a Member write, unless `stop()` is called first.
 */
function lockWaiter() {
  let stopped = false;
  const done = (async () => {
    const deadline = Date.now() + 15_000;
    while (!stopped) {
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()
          AND (query ILIKE '%pg_advisory_xact_lock%' OR query ILIKE '%"Member"%' OR query ILIKE '%"User"%')`;
      if (Number(rows[0]?.n ?? 0) > 0) return "blocked" as const;
      if (Date.now() > deadline) return "timeout" as const;
      await new Promise((r) => setTimeout(r, 40));
    }
    return "stopped" as const;
  })();
  return { done, stop: () => { stopped = true; } };
}

type Res = { status: number; json: () => Promise<unknown> };

/**
 * Start `holder`, wait until it is paused inside its transaction, start
 * `competitor`, wait until the competitor is blocked on a lock or finished,
 * then release the holder. Returns both responses and how the competitor was
 * observed ("blocked" proves it waited for the holder's transaction).
 */
async function race(kind: "status" | "statusBulk" | "auditTx", holder: () => Promise<Res>, competitor: () => Promise<Res>) {
  arm(kind);
  const h = holder();
  const reached = await Promise.race([
    pause.held.promise.then(() => true),
    h.then(() => false, () => false),
  ]);
  if (!reached) {
    pause.armed = null;
    const early = await h.catch((e) => ({ status: -1, json: async () => String(e) }));
    throw new Error(`holder finished without reaching its pause point: ${early.status} ${JSON.stringify(await early.json())}`);
  }
  const c = competitor();
  const waiter = lockWaiter();
  const how = await Promise.race([c.then(() => "finished" as const, () => "finished" as const), waiter.done]);
  waiter.stop();
  pause.release.resolve();
  const [hr, cr] = await Promise.all([h, c]);
  return { holder: hr, competitor: cr, how };
}

describe.skipIf(!HAS_DB)("login identity: concurrent claims across User and Member", () => {
  beforeAll(async () => {
    await withRlsBypass((tx) => tx.tenant.findFirst({ select: { id: true } }));
  });

  afterAll(async () => {
    const purgeNow = new Date(Date.now() + 365 * DAY_MS);
    for (const id of created) {
      await withRlsBypass((tx) => tx.tenant.updateMany({ where: { id }, data: { deletedAt: new Date(Date.now() - 40 * DAY_MS) } }));
      const out = await purgeTenantById(id, purgeNow, () => false);
      if (out.kind !== "purged" && out.kind !== "gone-during-purge") console.error(`[login-identity-race cleanup] ${id}: ${out.kind}`);
    }
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { action: "admin.tenant.hard_deleted", entityId: { in: created } } }));
  }, 600_000); // the tenant purge path runs 2–3 minutes through the pooler (review D2)

  it("member create (holding) vs staff email change to the same address: one holder, the staff change is refused", async () => {
    const c = await mkClub("mc-se");
    signInAsOwner(c);
    const x = addr("x");
    const out = await race(
      "status",
      () => createMember(req("POST", { name: "Race Member", email: x }) as never) as Promise<Res>,
      () => patchStaff(req("PATCH", { email: x }) as never, params(c.coachId)) as Promise<Res>,
    );
    expect(out.holder.status).toBe(201);
    const h = await holders(c.tenantId, x);
    expect(h).toHaveLength(1);
    expect(h[0].kind).toBe("member");
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
    expect(out.competitor.status).toBe(409);
  }, 60_000);

  it("staff email change (holding) vs member create with the same address: one holder, the member create is refused", async () => {
    const c = await mkClub("se-mc");
    signInAsOwner(c);
    const x = addr("x");
    const out = await race(
      "auditTx",
      () => patchStaff(req("PATCH", { email: x }) as never, params(c.coachId)) as Promise<Res>,
      () => createMember(req("POST", { name: "Race Member", email: x }) as never) as Promise<Res>,
    );
    expect(out.holder.status).toBe(200);
    const h = await holders(c.tenantId, x);
    expect(h).toEqual([{ kind: "user", id: c.coachId }]);
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
    expect(out.competitor.status).toBe(409);
  }, 60_000);

  it("member create (holding) vs staff create with the same address: one holder, the staff create is refused", async () => {
    const c = await mkClub("mc-sc");
    signInAsOwner(c);
    const x = addr("x");
    const out = await race(
      "status",
      () => createMember(req("POST", { name: "Race Member", email: x }) as never) as Promise<Res>,
      () => createStaff(req("POST", { name: "Race Staff", email: x, role: "coach", password: STRONG }) as never) as Promise<Res>,
    );
    expect(out.holder.status).toBe(201);
    const h = await holders(c.tenantId, x);
    expect(h).toHaveLength(1);
    expect(h[0].kind).toBe("member");
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
    expect(out.competitor.status).toBe(409);
  }, 60_000);

  it("member email change (holding) vs staff create with the same address: one holder, the staff create is refused", async () => {
    const c = await mkClub("mp-sc");
    signInAsOwner(c);
    const x = addr("x");
    const out = await race(
      "status",
      () => patchMember(req("PATCH", { email: x }) as never, params(c.memberId)) as Promise<Res>,
      () => createStaff(req("POST", { name: "Race Staff", email: x, role: "coach", password: STRONG }) as never) as Promise<Res>,
    );
    expect(out.holder.status).toBe(200);
    expect(await holders(c.tenantId, x)).toEqual([{ kind: "member", id: c.memberId }]);
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
    expect(out.competitor.status).toBe(409);
  }, 60_000);

  async function mkImportJob(c: Club, csv: string) {
    const url = `https://blob.test.local/${STAMP}/${Math.random().toString(36).slice(2)}.csv`;
    FILES.set(url, csv);
    return withRlsBypass((tx) => tx.importJob.create({ data: { tenantId: c.tenantId, createdById: c.ownerId, source: "generic", fileName: "race.csv", fileBlobUrl: url, status: "preview" } }));
  }

  it("bulk import (holding) vs staff create with the same address: one holder, the staff create is refused", async () => {
    const c = await mkClub("imp-sc");
    signInAsOwner(c);
    const x = addr("x");
    const job = await mkImportJob(c, `Name,Email\nImported Synthetic,${x}\nSecond Synthetic,${addr("y")}\n`);
    const out = await race(
      "statusBulk",
      () => commitImport(req("POST", {}) as never, params(job.id)) as Promise<Res>,
      () => createStaff(req("POST", { name: "Race Staff", email: x, role: "coach", password: STRONG }) as never) as Promise<Res>,
    );
    expect(out.holder.status).toBe(200);
    const h = await holders(c.tenantId, x);
    expect(h).toHaveLength(1);
    expect(h[0].kind).toBe("member");
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
    expect(out.competitor.status).toBe(409);
  }, 60_000);

  it("staff email change (holding) vs bulk import of the same address: the import refuses that row, one holder", async () => {
    const c = await mkClub("se-imp");
    signInAsOwner(c);
    const x = addr("x");
    const y = addr("y");
    const job = await mkImportJob(c, `Name,Email\nImported Synthetic,${x}\nSecond Synthetic,${y}\n`);
    const out = await race(
      "auditTx",
      () => patchStaff(req("PATCH", { email: x }) as never, params(c.coachId)) as Promise<Res>,
      () => commitImport(req("POST", {}) as never, params(job.id)) as Promise<Res>,
    );
    expect(out.holder.status).toBe(200);
    expect(await holders(c.tenantId, x)).toEqual([{ kind: "user", id: c.coachId }]);
    // The other row of the file still lands; the refused row is reported, not hidden.
    expect(await holders(c.tenantId, y)).toHaveLength(1);
    const row = await withRlsBypass((tx) => tx.importJob.findUnique({ where: { id: job.id }, select: { errorRows: true, importedRows: true } }));
    expect(row?.importedRows).toBe(1);
    expect(row?.errorRows).toBeGreaterThanOrEqual(1);
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
  }, 60_000);

  it("member email change (holding) vs bulk import of the same address: one member holds it (same-table unique, regression)", async () => {
    const c = await mkClub("mp-imp");
    signInAsOwner(c);
    const x = addr("x");
    const job = await mkImportJob(c, `Name,Email\nImported Synthetic,${x}\n`);
    const out = await race(
      "status",
      () => patchMember(req("PATCH", { email: x }) as never, params(c.memberId)) as Promise<Res>,
      () => commitImport(req("POST", {}) as never, params(job.id)) as Promise<Res>,
    );
    expect(out.holder.status).toBe(200);
    expect(await holders(c.tenantId, x)).toEqual([{ kind: "member", id: c.memberId }]);
    // The barrier held: the competitor waited for the holder, then was refused.
    expect(out.how).toBe("blocked");
  }, 60_000);
});
