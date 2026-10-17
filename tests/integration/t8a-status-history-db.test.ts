// T8a (17 Oct 2026) — status history writers on a REAL database.
//
//   1. DSAR erase records exactly one status event (staff_edit, the owner) and
//      stamps cancelledAt, in the erase transaction; an already-cancelled member
//      writes no event and keeps its cancelledAt; a throw part-way through the
//      erase leaves no event, no status change and no cancelledAt — including
//      the guardian-with-child cascade path.
//   2. A TeamUp status refresh dates its events by the source (the file's
//      Cancelled Date, else the export time), clamped to the member's latest
//      event; a rollback's reverse events carry the forward dates, and replay
//      for any date returns the pre-refresh status. The latest event's toStatus
//      equals Member.status for every touched member.
//
// Runs only through the guarded runners (TEST branch, never production). Skips
// when DATABASE_URL is unset. Prefix t8a-; count-checked teardown of this
// file's clubs only.
import { vi, describe, it, expect, afterAll } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers(init?.headers) }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", () => ({
  importStorageAvailable: () => true,
  readImportFile: async (url: string) => files.get(url) ?? null,
  deleteImportFile: async (url: string) => { files.delete(url); },
}));
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string } }));
const sessionOf = () => (gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } : null);
vi.mock("@/auth", () => ({ auth: vi.fn(async () => sessionOf()), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: sessionOf() };
  };
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok), requireApiRole: vi.fn(ok) };
});

// One-shot fault: the next tx.<model>.<op> call throws, inside the caller's transaction.
const FAULT = vi.hoisted(() => ({ current: null as null | { model: string; op: string } }));
vi.mock("@/lib/prisma-tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prisma-tenant")>();
  const wrap = <T extends object>(tx: T): T =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (typeof v === "function") return v.bind(t);
        if (v && typeof v === "object" && typeof p === "string") {
          return new Proxy(v as object, {
            get(d, op) {
              const f = Reflect.get(d, op);
              if (typeof f !== "function") return f;
              return async (args: unknown) => {
                const fault = FAULT.current;
                if (fault && fault.model === p && fault.op === op) {
                  FAULT.current = null;
                  throw new Error(`injected fault at ${p}.${String(op)}`);
                }
                return f.call(d, args);
              };
            },
          });
        }
        return v;
      },
    });
  return {
    ...real,
    withTenantContext: (tenantId: string, fn: (tx: never) => Promise<unknown>, opts?: unknown) =>
      real.withTenantContext(tenantId, (tx) => fn(wrap(tx) as never), opts as never),
  };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";
import { POST as commitPOST } from "@/app/api/admin/import/[id]/commit/route";
import { POST as rollbackPOST } from "@/app/api/admin/import/[id]/rollback/route";
import { parseTeamUp } from "@/lib/importers/teamup";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `t8a-${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const ORIGIN = { origin: "https://test.local", host: "test.local" };

type Club = { tenantId: string; userId: string };
const clubs: Club[] = [];
async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "T8a Owner", role: "owner", passwordHash: "x" } });
    return { tenantId: t.id, userId: u.id };
  });
  clubs.push(club);
  gate.current = club;
  return club;
}
const mkMember = (club: Club, name: string, email: string, extra: Record<string, unknown> = {}) =>
  withRlsBypass((tx) => tx.member.create({ data: { tenantId: club.tenantId, name, email, ...extra }, select: { id: true } })).then((r) => r.id);

const eventsOf = (club: Club, memberId: string) =>
  withRlsBypass((tx) =>
    tx.memberStatusEvent.findMany({
      where: { tenantId: club.tenantId, memberId },
      orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { fromStatus: true, toStatus: true, reason: true, changedById: true, occurredAt: true, createdAt: true },
    }),
  );
const memberRow = (club: Club, id: string) =>
  withRlsBypass((tx) => tx.member.findFirst({ where: { tenantId: club.tenantId, id }, select: { status: true, cancelledAt: true, email: true } }));
const erase = (memberId: string, query = "") =>
  dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${memberId}${query}`, { method: "POST", headers: ORIGIN })) as unknown as Promise<{ status: number }>;

/** The status a member had at `at`, replayed in (occurredAt, createdAt, id) order. */
function statusAt(events: Awaited<ReturnType<typeof eventsOf>>, at: Date): string | null {
  let s: string | null = null;
  for (const e of events) if (e.occurredAt <= at) s = e.toStatus;
  return s;
}

afterAll(async () => {
  if (!HAS_DB) return;
  FAULT.current = null;
  const ids = clubs.map((c) => c.tenantId);
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.importedMembership.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    members: await tx.member.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0 });
});

describe.skipIf(!HAS_DB)("T8a: DSAR erase records its status event and cancelledAt", () => {
  it("an active member: exactly one active -> cancelled event by the owner, and cancelledAt stamped", async () => {
    const club = await mkClub("erase-active");
    const id = await mkMember(club, "T8a Active", E("active"), { status: "active" });
    const res = await erase(id);
    expect(res.status).toBe(200);

    const evs = await eventsOf(club, id);
    expect(evs.map(({ fromStatus, toStatus, reason, changedById }) => ({ fromStatus, toStatus, reason, changedById })))
      .toEqual([{ fromStatus: "active", toStatus: "cancelled", reason: "staff_edit", changedById: club.userId }]);
    const row = await memberRow(club, id);
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelledAt).toBeInstanceOf(Date);
  });

  it("an already-cancelled member: no new event, and cancelledAt stays as it was", async () => {
    const club = await mkClub("erase-cancelled");
    const D = new Date("2026-09-01T00:00:00.000Z");
    const id = await mkMember(club, "T8a Left", E("left"), { status: "cancelled", cancelledAt: D });
    const res = await erase(id);
    expect(res.status).toBe(200);
    expect(await eventsOf(club, id)).toEqual([]);
    expect((await memberRow(club, id))?.cancelledAt?.toISOString()).toBe(D.toISOString());
  });

  it("a throw after the scrub and the event leaves nothing behind: no event, no status change, no cancelledAt", async () => {
    const club = await mkClub("erase-atomic");
    const id = await mkMember(club, "T8a Atomic", E("atomic"), { status: "active" });
    // memberPhoto.deleteMany runs straight after the member update and the status event.
    FAULT.current = { model: "memberPhoto", op: "deleteMany" };
    const res = await erase(id);
    expect(res.status).toBe(500);
    expect(await eventsOf(club, id)).toEqual([]);
    const row = await memberRow(club, id);
    expect(row).toMatchObject({ status: "active", cancelledAt: null, email: E("atomic") });
    const audit = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: club.tenantId, action: "member.dsar_erase", entityId: id } }));
    expect(audit).toBe(0);
  });

  it("a guardian erased with ?strategy=cascade: a throw after the child cascade rolls the child back too", async () => {
    const club = await mkClub("erase-guardian");
    const parent = await mkMember(club, "T8a Guardian", E("guardian"), { status: "active" });
    const child = await mkMember(club, "T8a Child", E("child"), { status: "active", accountType: "kids", parentMemberId: parent });
    FAULT.current = { model: "memberPhoto", op: "deleteMany" };
    const res = await erase(parent, "&strategy=cascade");
    expect(res.status).toBe(500);
    expect(await eventsOf(club, parent)).toEqual([]);
    expect(await memberRow(club, parent)).toMatchObject({ status: "active", cancelledAt: null });
    expect(await memberRow(club, child)).toMatchObject({ status: "active" });

    // And without the fault: the guardian's event is written; the child is gone with its history.
    const ok = await erase(parent, "&strategy=cascade");
    expect(ok.status).toBe(200);
    expect((await eventsOf(club, parent)).map((e) => e.toStatus)).toEqual(["cancelled"]);
    expect(await memberRow(club, child)).toBeNull();
  });
});

// ── Refresh and rollback dating ──────────────────────────────────────────────

const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
function row(o: { name: string; email: string; status: string; start: string; cancelled?: string }): string {
  return [o.name, o.email, "", "Adults Advanced 2026", "recurring", o.status, "Stripe", o.start, o.start, o.cancelled ?? "", o.cancelled ?? "", "Yes", "", "", "", "", "", "", "GB", "", "", "", "1990-01-01", "", "", ""].join(",");
}

describe.skipIf(!HAS_DB)("T8a: refresh events are source-dated and clamped; rollback mirrors them", () => {
  const EXPORT_1 = new Date("2026-10-03T11:39:57.000Z");
  const EXPORT_2 = new Date("2026-10-20T08:00:00.000Z");
  const CANCELLED = "2026-10-05";

  async function setup(label: string) {
    const club = await mkClub(label);
    const file = [
      HEADER,
      row({ name: "Cara Cancel", email: E(`${label}-cara`), status: "cancelled", start: "2025-01-01", cancelled: CANCELLED }),
      row({ name: "Stan Staff", email: E(`${label}-stan`), status: "cancelled", start: "2025-01-01", cancelled: CANCELLED }),
      row({ name: "Una Same", email: E(`${label}-una`), status: "active", start: "2025-01-01" }),
    ].join("\n");
    const parsed = parseTeamUp(file);
    const key = (name: string) => parsed.drafts.find((d) => d.name === name)!.sourceKey!;
    const base = { billedBy: "teamup", status: "active", paymentStatus: "paid", membershipType: "Adults Advanced 2026", billingStatusAsOf: EXPORT_1, billingStatusSource: "t8a-first-import" };
    const cara = await mkMember(club, "Cara Cancel", E(`${label}-cara`), { ...base, externalRef: key("Cara Cancel") });
    const stan = await mkMember(club, "Stan Staff", E(`${label}-stan`), { ...base, externalRef: key("Stan Staff") });
    const una = await mkMember(club, "Una Same", E(`${label}-una`), { ...base, externalRef: key("Una Same") });
    // The first import's events (3 Oct), and a staff edit on Stan on 10 Oct.
    const STAFF = new Date("2026-10-10T09:00:00.000Z");
    await withRlsBypass(async (tx) => {
      for (const memberId of [cara, stan, una]) {
        await tx.memberStatusEvent.create({ data: { tenantId: club.tenantId, memberId, fromStatus: null, toStatus: "active", reason: "import", occurredAt: EXPORT_1 } });
      }
      await tx.memberStatusEvent.create({ data: { tenantId: club.tenantId, memberId: stan, fromStatus: "active", toStatus: "inactive", reason: "staff_edit", changedById: club.userId, occurredAt: new Date("2026-10-09T09:00:00.000Z") } });
      await tx.memberStatusEvent.create({ data: { tenantId: club.tenantId, memberId: stan, fromStatus: "inactive", toStatus: "active", reason: "staff_edit", changedById: club.userId, occurredAt: STAFF } });
    });
    const url = `local-import://${STAMP}-${label}`;
    files.set(url, file);
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({
        data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode: "refresh", fileName: `${label}.csv`, fileBlobUrl: url, status: "preview", fileHash: `${STAMP}-${label}`, sourceExportedAt: EXPORT_2, sourceExportedAtProvenance: "owner_stated", mappingVersion: "teamup@t8a" },
        select: { id: true },
      }),
    );
    return { club, cara, stan, una, jobId: job.id, STAFF };
  }

  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("dates Cara's cancellation 5 Oct (createdAt = now), clamps Stan's to his 10 Oct staff edit, and keeps the latest-event invariant", async () => {
    const { club, cara, stan, una, jobId, STAFF } = await setup("refresh");
    const before = Date.now();
    const res = (await commitPOST(new Request("https://test.local/x", { method: "POST", headers: ORIGIN }), params(jobId))) as unknown as { status: number };
    expect(res.status).toBe(200);

    const caraEvents = await eventsOf(club, cara);
    const caraCancel = caraEvents.find((e) => e.toStatus === "cancelled")!;
    expect(caraCancel.occurredAt.toISOString()).toBe(`${CANCELLED}T00:00:00.000Z`);
    expect(caraCancel.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    const stanCancel = (await eventsOf(club, stan)).find((e) => e.toStatus === "cancelled")!;
    expect(stanCancel.occurredAt.toISOString()).toBe(STAFF.toISOString());

    for (const id of [cara, stan, una]) {
      const evs = await eventsOf(club, id);
      expect(evs[evs.length - 1].toStatus).toBe((await memberRow(club, id))!.status);
    }
  });

  it("a rollback's reverse events carry the forward dates; replay for any date equals the pre-refresh status", async () => {
    const { club, cara, stan, jobId } = await setup("rollback");
    const preRefresh = new Map<string, Awaited<ReturnType<typeof eventsOf>>>();
    for (const id of [cara, stan]) preRefresh.set(id, await eventsOf(club, id));

    const req = () => new Request("https://test.local/x", { method: "POST", headers: ORIGIN });
    expect(((await commitPOST(req(), params(jobId))) as unknown as { status: number }).status).toBe(200);
    expect(((await rollbackPOST(req(), params(jobId))) as unknown as { status: number }).status).toBe(200);

    const probes = [EXPORT_1, new Date("2026-10-05T00:00:00Z"), new Date("2026-10-09T12:00:00Z"), new Date("2026-10-10T09:00:00Z"), new Date()];
    for (const id of [cara, stan]) {
      const evs = await eventsOf(club, id);
      const forward = evs.find((e) => e.toStatus === "cancelled")!;
      const reverse = evs.find((e) => e.fromStatus === "cancelled")!;
      expect(reverse.occurredAt.toISOString()).toBe(forward.occurredAt.toISOString());
      expect(reverse.createdAt.getTime()).toBeGreaterThanOrEqual(forward.createdAt.getTime());
      for (const at of probes) expect(statusAt(evs, at)).toBe(statusAt(preRefresh.get(id)!, at));
      expect(evs[evs.length - 1].toStatus).toBe((await memberRow(club, id))!.status);
    }
  });
});
