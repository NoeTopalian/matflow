// S3 measurement (6 Nov 2026): how many statements, transactions and connections each page's load sends, counted at
// the driver (every pg Client.query) while the page's own server code runs against a seeded synthetic club. The same
// file runs on the base commit and on S3's head, so the numbers in the PR body are measured, not estimated.
//
// It also asserts S3's promise on the head: each page opens exactly ONE tenant transaction (one connection), and
// Reports and the timetable no longer hold several at once. With S3_OUT_DIR set it writes the counts, and each page's
// output (the props it hands its components, ids normalised), to that folder: diffing the base and head files shows
// every number on every page unchanged.
//
// Neon TEST branch only, both roles through db-tests.mjs. Synthetic fixture: prefix s3m-, example.test addresses,
// explicit ids, torn down by tenant id.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const STAMP = `s3m-${Date.now().toString(36)}`;
const TENANT_ID = `${STAMP}-tenant`;
const USER_ID = `${STAMP}-user`;

const SESSION = {
  user: {
    id: USER_ID,
    tenantId: TENANT_ID,
    role: "owner",
    name: "S3 Owner",
    tenantName: "S3 Measure Club",
    primaryColor: "#3b82f6",
    secondaryColor: "#111827",
    textColor: "#ffffff",
    totpEnabled: true,
  },
};

vi.mock("@/lib/authz", () => ({
  requireStaff: async () => ({ session: SESSION, tenantId: TENANT_ID, userId: USER_ID, role: "owner" }),
  requireSession: async () => ({ session: SESSION, tenantId: TENANT_ID, userId: USER_ID, role: "owner" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn, revalidateTag: vi.fn(), revalidatePath: vi.fn() }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import DashboardPage from "@/app/dashboard/page";
import DashboardLayout from "@/app/dashboard/layout";
import TimetablePage from "@/app/dashboard/timetable/page";
import AttendancePage from "@/app/dashboard/attendance/page";
import { getReportsData } from "@/lib/reports";

const HAS_DB = !!process.env.DATABASE_URL;
const OUT_DIR = process.env.S3_OUT_DIR;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const DAY = 86_400_000;

type Count = { statements: number; transactions: number; maxOpenTransactions: number; savepoints: number; other: number; sample: string[] };

/** Runs `load` and counts every statement the pg driver sends meanwhile. */
async function measure<T>(load: () => Promise<T>): Promise<{ count: Count; out: T }> {
  const original = pg.Client.prototype.query;
  const count: Count = { statements: 0, transactions: 0, maxOpenTransactions: 0, savepoints: 0, other: 0, sample: [] };
  let open = 0;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string };
    const text = (typeof first === "string" ? first : first?.text ?? "").trim();
    count.statements += 1;
    if (/^BEGIN\b/i.test(text)) {
      count.transactions += 1;
      open += 1;
      count.maxOpenTransactions = Math.max(count.maxOpenTransactions, open);
    } else if (/^(COMMIT|ROLLBACK)\s*;?$/i.test(text)) {
      open -= 1;
    } else if (/SAVEPOINT/i.test(text)) {
      count.savepoints += 1;
    } else {
      count.other += 1;
    }
    count.sample.push(text.replace(/\s+/g, " ").slice(0, 90));
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  try {
    const out = await load();
    return { count, out };
  } finally {
    pg.Client.prototype.query = original;
  }
}

/** A React element tree as plain data: component names and their serialisable props. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === "function") return undefined;
  if (typeof v === "symbol") return undefined;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const o = v as Record<string, unknown> & { $$typeof?: unknown; type?: unknown; props?: unknown };
    if (o.$$typeof) {
      const t = o.type as { name?: string; displayName?: string } | string | undefined;
      return { el: typeof t === "string" ? t : t?.displayName ?? t?.name ?? "?", props: plain(o.props) };
    }
    const r: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) if (k !== "generatedAt") r[k] = plain(val);
    return r;
  }
  return v;
}

const results: Record<string, Count> = {};
const outputs: Record<string, unknown> = {};

async function seed() {
  const now = Date.now();
  const at = (daysAgo: number, h = 18) => new Date(now - daysAgo * DAY + (h - 12) * 3_600_000);
  await withRlsBypass(
    async (tx) => {
      await tx.tenant.create({
        data: { id: TENANT_ID, name: "S3 Measure Club", slug: STAMP, timezone: "Europe/London", onboardingCompleted: true, reviewLockedAt: new Date(now - 5 * DAY), contactEmail: `${STAMP}@example.test` },
      });
      await tx.importJob.create({
        data: { id: `${STAMP}-job`, tenantId: TENANT_ID, createdById: USER_ID, source: "teamup", fileName: `${STAMP}.csv`, fileBlobUrl: "none", status: "complete" },
      });
      await tx.rankSystem.create({ data: { id: `${STAMP}-rank`, tenantId: TENANT_ID, discipline: "BJJ", name: "White", order: 0 } });
      await tx.membershipTier.createMany({ data: [0, 1].map((i) => ({ id: `${STAMP}-tier-${i}`, tenantId: TENANT_ID, name: `Tier ${i}` })) });
      await tx.mat.createMany({ data: [0, 1].map((i) => ({ id: `${STAMP}-mat-${i}`, tenantId: TENANT_ID, name: `Mat ${i + 1}`, nameKey: `mat ${i + 1}`, sortOrder: i })) });
      const kinds = [
        { status: "active", accountType: "adult" },
        { status: "active", accountType: "kids" },
        { status: "taster", accountType: "adult" },
        { status: "inactive", accountType: "adult" },
        { status: "active", accountType: "parent" },
        { status: "cancelled", accountType: "adult" },
      ];
      await tx.member.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          id: `${STAMP}-m${String(i).padStart(2, "0")}`,
          tenantId: TENANT_ID,
          name: `Member ${i}`,
          email: `${STAMP}-m${i}@example.test`,
          phone: i % 3 === 0 ? null : `0770090${String(i).padStart(4, "0")}`,
          waiverAccepted: i % 2 === 0,
          joinedAt: new Date(now - (i % 4 === 0 ? 3 : 200) * DAY),
          ...kinds[i % kinds.length],
          // A kids account must have a parent (CHECK Member_kids_must_have_parent): member 4 is a parent account.
          ...(kinds[i % kinds.length].accountType === "kids" ? { parentMemberId: `${STAMP}-m04` } : {}),
        })),
      });
      const classes = [
        { id: `${STAMP}-c-gi`, name: "Gi", matId: `${STAMP}-mat-0`, location: "Mat 1" },
        { id: `${STAMP}-c-nogi`, name: "No-Gi", matId: `${STAMP}-mat-1`, location: "Mat 2" },
        { id: `${STAMP}-c-kids`, name: "Kids", isKids: true },
        { id: `${STAMP}-c-paused`, name: "Paused", isActive: false },
      ];
      await tx.class.createMany({ data: classes.map((c) => ({ tenantId: TENANT_ID, duration: 60, maxCapacity: 20, ...c })) });
      await tx.classSchedule.createMany({
        data: classes.map((c, i) => ({ id: `${c.id}-s`, classId: c.id, dayOfWeek: (i % 5) + 1, startTime: "18:00", endTime: "19:00" })),
      });
      // 40 days of sessions on the live classes, check-ins recorded in MatFlow, plus imported history before that.
      const instances: { id: string; classId: string; date: Date; startTime: string; endTime: string }[] = [];
      const records: { id: string; tenantId: string; memberId: string; classInstanceId: string; checkInTime: Date; checkInMethod: string; importJobId: string | null }[] = [];
      for (let d = 0; d < 60; d += 1) {
        const cls = classes[d % 3];
        const when = at(d);
        const inst = { id: `${STAMP}-i${String(d).padStart(2, "0")}`, classId: cls.id, date: new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate())), startTime: "18:00", endTime: "19:00" };
        instances.push(inst);
        const imported = d >= 40;
        for (let m = 0; m < 12; m += 1) {
          if ((m + d) % 3 !== 0) continue;
          records.push({
            id: `${STAMP}-r${String(d).padStart(2, "0")}-${m}`,
            tenantId: TENANT_ID,
            memberId: `${STAMP}-m${String(m).padStart(2, "0")}`,
            classInstanceId: inst.id,
            checkInTime: new Date(when.getTime() + m * 60_000),
            checkInMethod: imported ? "import" : m % 2 ? "kiosk" : "admin",
            importJobId: imported ? `${STAMP}-job` : null,
          });
        }
      }
      await tx.classInstance.createMany({ data: instances });
      await tx.attendanceRecord.createMany({ data: records });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

describe.skipIf(!HAS_DB)("statements per page (S3 measurement)", () => {
  beforeAll(async () => {
    await seed();
    // Warm the pool and the driver once so the first page is not charged for the connection set-up.
    await withRlsBypass((tx) => tx.tenant.count({ where: { id: TENANT_ID } }));
  }, 180_000);

  afterAll(async () => {
    await withRlsBypass(
      async (tx) => {
        await tx.attendanceRecord.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId: TENANT_ID } } });
        await tx.classSchedule.deleteMany({ where: { class: { tenantId: TENANT_ID } } });
        await tx.class.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.mat.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.importJob.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.membershipTier.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.rankSystem.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.member.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.tenant.deleteMany({ where: { id: TENANT_ID } });
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    expect(await withRlsBypass((tx) => tx.tenant.count({ where: { id: TENANT_ID } }))).toBe(0);
    if (OUT_DIR) {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(path.join(OUT_DIR, `s3-counts-${ROLE}.json`), JSON.stringify(results, null, 2));
      writeFileSync(path.join(OUT_DIR, `s3-pages-${ROLE}.json`), JSON.stringify(outputs, null, 2).replaceAll(STAMP, "S"));
    }
  }, 120_000);

  const pages: [string, () => Promise<unknown>][] = [
    ["dashboard layout", () => DashboardLayout({ children: null })],
    ["dashboard", () => DashboardPage({})],
    ["timetable", () => TimetablePage()],
    ["attendance", () => AttendancePage({ searchParams: Promise.resolve({}) })],
    ["reports (default period)", () => getReportsData(TENANT_ID, {})],
    ["reports (3 months, kids, one class)", () => getReportsData(TENANT_ID, { period: { period: "3m" }, ageGroup: "kids", classId: `${STAMP}-c-kids` })],
  ];

  it.each(pages)("%s", async (name, load) => {
    const { count, out } = await measure(load);
    results[name] = count;
    outputs[name] = plain(out);
    // S3: one tenant transaction per page or route, so never more than one connection held at once.
    expect([name, count.transactions, count.maxOpenTransactions]).toEqual([name, 1, 1]);
  });
});
