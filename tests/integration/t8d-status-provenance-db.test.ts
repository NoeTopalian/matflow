// T8d (17 Oct 2026) — status event provenance on a REAL database.
//
//   1. A TeamUp status refresh writes events naming the refresh job as
//      import_refresh; its rollback writes reverse events naming the same job
//      as import_rollback, dated at the forward event (A-9).
//   2. A slice that fails after its events were written leaves neither the
//      member write nor the event behind.
//   3. A write that names neither column (what the previous build's client
//      does) succeeds with both null; the CHECK refuses an unknown action.
//   4. The back-fill tags pre-T8d create events, is idempotent (second run
//      changes 0 rows), and leaves the occurredAt checksum unchanged.
//
// Needs migration 20261017022302_status_event_source_provenance applied. Runs
// only through the guarded runners (a Neon child branch, never production).
// Skips when DATABASE_URL is unset. Prefix t8d-; count-checked teardown of
// this file's clubs only.
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

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { POST as commitPOST } from "@/app/api/admin/import/[id]/commit/route";
import { POST as rollbackPOST } from "@/app/api/admin/import/[id]/rollback/route";
import { parseTeamUp } from "@/lib/importers/teamup";
import { backfillCreateEventProvenance } from "@/lib/status-event-provenance";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `t8d-${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const ORIGIN = { origin: "https://test.local", host: "test.local" };
const req = () => new Request("https://test.local/x", { method: "POST", headers: ORIGIN });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Club = { tenantId: string; userId: string };
const clubs: Club[] = [];
async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "T8d Owner", role: "owner", passwordHash: "x" } });
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
      select: { id: true, fromStatus: true, toStatus: true, reason: true, occurredAt: true, sourceJobId: true, sourceAction: true },
    }),
  );
const checksum = (club: Club) =>
  withRlsBypass(async (tx) => {
    const [r] = await tx.$queryRaw<{ md5: string | null }[]>`
      SELECT md5(string_agg(id || ':' || "occurredAt"::text, ',' ORDER BY id)) AS md5 FROM "MemberStatusEvent" WHERE "tenantId" = ${club.tenantId}`;
    return r?.md5 ?? null;
  });

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

// ── Refresh and rollback ─────────────────────────────────────────────────────

const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
function row(o: { name: string; email: string; status: string; start: string; cancelled?: string }): string {
  return [o.name, o.email, "", "Adults Advanced 2026", "recurring", o.status, "Stripe", o.start, o.start, o.cancelled ?? "", o.cancelled ?? "", "Yes", "", "", "", "", "", "", "GB", "", "", "", "1990-01-01", "", "", ""].join(",");
}

describe.skipIf(!HAS_DB)("T8d: refresh and rollback events carry the job", () => {
  const EXPORT_1 = new Date("2026-10-03T11:39:57.000Z");
  const EXPORT_2 = new Date("2026-10-13T09:00:00.000Z");
  const CANCELLED = "2026-10-09";

  async function setup(label: string) {
    const club = await mkClub(label);
    const file = [HEADER, row({ name: "Cara Cancel", email: E(`${label}-cara`), status: "cancelled", start: "2025-01-01", cancelled: CANCELLED })].join("\n");
    const parsed = parseTeamUp(file);
    const key = parsed.drafts.find((d) => d.name === "Cara Cancel")!.sourceKey!;
    const cara = await mkMember(club, "Cara Cancel", E(`${label}-cara`), {
      billedBy: "teamup", status: "active", paymentStatus: "paid", membershipType: "Adults Advanced 2026", billingStatusAsOf: EXPORT_1, billingStatusSource: "t8d-first-import", externalRef: key,
    });
    await withRlsBypass((tx) => tx.memberStatusEvent.create({ data: { tenantId: club.tenantId, memberId: cara, fromStatus: null, toStatus: "active", reason: "import", occurredAt: EXPORT_1 } }));
    const url = `local-import://${STAMP}-${label}`;
    files.set(url, file);
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({
        data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode: "refresh", fileName: `${label}.csv`, fileBlobUrl: url, status: "preview", fileHash: `${STAMP}-${label}`, sourceExportedAt: EXPORT_2, sourceExportedAtProvenance: "owner_stated", mappingVersion: "teamup@t8d" },
        select: { id: true },
      }),
    );
    return { club, cara, jobId: job.id };
  }

  it("acceptance 1 and 2: the cancellation names the refresh job; the rollback's reverse names it too, at the forward date", async () => {
    const { club, cara, jobId } = await setup("refresh");
    expect(((await commitPOST(req(), params(jobId))) as unknown as { status: number }).status).toBe(200);
    const fwd = (await eventsOf(club, cara)).find((e) => e.toStatus === "cancelled")!;
    expect(fwd).toMatchObject({ fromStatus: "active", reason: "import", sourceJobId: jobId, sourceAction: "import_refresh" });

    expect(((await rollbackPOST(req(), params(jobId))) as unknown as { status: number }).status).toBe(200);
    const back = (await eventsOf(club, cara)).find((e) => e.fromStatus === "cancelled")!;
    expect(back).toMatchObject({ toStatus: "active", reason: "import", sourceJobId: jobId, sourceAction: "import_rollback" });
    expect(back.occurredAt.toISOString()).toBe(fwd.occurredAt.toISOString());
  });

  it("a slice that fails after its events were written leaves neither the member write nor the event", async () => {
    const { club, cara, jobId } = await setup("atomic");
    // The first importJob.update on the refresh path is the slice's manifest
    // write, in the same transaction, straight after the events are written.
    FAULT.current = { model: "importJob", op: "update" };
    const res = (await commitPOST(req(), params(jobId))) as unknown as { status: number };
    expect(res.status).not.toBe(200);
    const evs = await eventsOf(club, cara);
    expect(evs.filter((e) => e.sourceJobId === jobId)).toEqual([]);
    const m = await withRlsBypass((tx) => tx.member.findFirst({ where: { tenantId: club.tenantId, id: cara }, select: { status: true } }));
    expect(m?.status).toBe("active");
  });
});

// ── Previous build and CHECK ─────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("T8d: the previous build's writes still work; the CHECK holds", () => {
  it("an insert naming neither column succeeds with both null; an unknown action is refused", async () => {
    const club = await mkClub("compat");
    const id = await mkMember(club, "Old Build", E("old"), { status: "active" });
    const evId = `${STAMP}-old-ev`;
    await withRlsBypass((tx) =>
      tx.$executeRaw`INSERT INTO "MemberStatusEvent" ("id", "tenantId", "memberId", "fromStatus", "toStatus", "reason") VALUES (${evId}, ${club.tenantId}, ${id}, NULL, 'active', 'staff_edit')`,
    );
    const [row1] = await eventsOf(club, id);
    expect(row1).toMatchObject({ id: evId, sourceJobId: null, sourceAction: null });

    await expect(
      withRlsBypass((tx) =>
        tx.$executeRaw`INSERT INTO "MemberStatusEvent" ("id", "tenantId", "memberId", "fromStatus", "toStatus", "reason", "sourceJobId", "sourceAction") VALUES (${`${evId}-bad`}, ${club.tenantId}, ${id}, 'active', 'cancelled', 'import', 'job', 'import_purge')`,
      ),
    ).rejects.toThrow();
  });
});

// ── Back-fill ────────────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("T8d back-fill: idempotent, occurredAt untouched", () => {
  it("tags pre-T8d create events of imported members only; a second run changes 0 rows; the checksum is unchanged", async () => {
    const club = await mkClub("backfill");
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({
        data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode: "create", fileName: "b.csv", fileBlobUrl: `local-import://${STAMP}-b`, status: "complete", fileHash: `${STAMP}-b`, mappingVersion: "teamup@t8d" },
        select: { id: true },
      }),
    );
    const imported = await mkMember(club, "Imported", E("imp"), { status: "active", importJobId: job.id });
    const desk = await mkMember(club, "Desk", E("desk"), { status: "active" });
    const AT = new Date("2026-10-03T11:39:57.000Z");
    await withRlsBypass(async (tx) => {
      await tx.memberStatusEvent.create({ data: { tenantId: club.tenantId, memberId: imported, fromStatus: null, toStatus: "active", reason: "import", occurredAt: AT } });
      await tx.memberStatusEvent.create({ data: { tenantId: club.tenantId, memberId: desk, fromStatus: null, toStatus: "active", reason: "staff_edit", changedById: club.userId } });
    });
    const before = await checksum(club);

    const preview = await withTenantContext(club.tenantId, (tx) => backfillCreateEventProvenance(tx, club.tenantId, { apply: false }));
    expect(preview).toMatchObject({ candidates: 1, withoutJob: 0, updated: 0 });
    expect((await eventsOf(club, imported))[0].sourceJobId).toBeNull();

    const first = await withTenantContext(club.tenantId, (tx) => backfillCreateEventProvenance(tx, club.tenantId, { apply: true }));
    expect(first.updated).toBe(1);
    expect((await eventsOf(club, imported))[0]).toMatchObject({ sourceJobId: job.id, sourceAction: "import_create" });
    expect((await eventsOf(club, desk))[0]).toMatchObject({ sourceJobId: null, sourceAction: null });

    const second = await withTenantContext(club.tenantId, (tx) => backfillCreateEventProvenance(tx, club.tenantId, { apply: true }));
    expect(second).toMatchObject({ candidates: 0, updated: 0 });
    expect(await checksum(club)).toBe(before);

    const nonImport = await withRlsBypass((tx) => tx.memberStatusEvent.count({ where: { tenantId: club.tenantId, sourceJobId: { not: null }, reason: { not: "import" } } }));
    expect(nonImport).toBe(0);
  });
});
