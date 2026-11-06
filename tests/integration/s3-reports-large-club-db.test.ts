// S3 review M1 (6 Nov 2026): the whole Reports load now runs in ONE tenant transaction with ONE budget
// (lib/reports.ts getReportsData), where its reads used to have a budget each. This times the full load, uncached, on
// a large synthetic club — 1,000 members, about 51,000 check-ins over 24 months (MatFlow and imported), four classes —
// over the longest period the page allows (24 months) and a filtered 12-month view, and asserts every load finishes
// inside its budget with no budget error. The review's rule: over 15 s, the budget is raised (45–55 s, under the 60 s
// statement bound) and this is run again. With S3_OUT_DIR set the timings are written there.
//
// Neon TEST branch (both roles through db-tests.mjs) and CI's Postgres. Synthetic fixture: prefix s3l-, example.test
// addresses, explicit ids, torn down by tenant id.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn, revalidateTag: vi.fn() }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { REPORTS_TX_BUDGET_MS, getReportsData } from "@/lib/reports";

const HAS_DB = !!process.env.DATABASE_URL;
const OUT_DIR = process.env.S3_OUT_DIR;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `s3l-${Date.now().toString(36)}`;
const TENANT_ID = `${STAMP}-tenant`;
const DAY = 86_400_000;
const MEMBERS = 1000;
const DAYS = 730;
const PER_SESSION = 35;
/** The report's budget (lib/reports.ts getReportsData). */
const BUDGET_MS = REPORTS_TX_BUDGET_MS;
/** Above this the review asks for a larger budget. */
const REVIEW_LINE_MS = 15_000;

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

async function chunks<T>(rows: T[], size: number, write: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

const timings: Record<string, number[]> = {};
let checkIns = 0;

describe.skipIf(!HAS_DB)("Reports on a large club fits its one-transaction budget (S3 review M1)", () => {
  beforeAll(async () => {
    const now = Date.now();
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT_ID, name: "S3 Large Club", slug: STAMP, timezone: "Europe/London", onboardingCompleted: true } });
      await tx.importJob.create({
        data: { id: `${STAMP}-job`, tenantId: TENANT_ID, createdById: STAMP, source: "teamup-attendance", fileName: `${STAMP}.csv`, fileBlobUrl: "none", status: "complete" },
      });
      await tx.class.createMany({
        data: ["Gi", "No-Gi", "Juniors", "Open Mat"].map((name, i) => ({ id: `${STAMP}-c${i}`, tenantId: TENANT_ID, name, duration: 60, maxCapacity: 40 })),
      });
    });
    const kinds = [
      { status: "active", accountType: "adult" },
      { status: "active", accountType: "adult" },
      { status: "active", accountType: "junior" },
      { status: "inactive", accountType: "adult" },
      { status: "cancelled", accountType: "adult" },
      { status: "taster", accountType: "adult" },
      { status: "active", accountType: "parent" },
    ];
    const members = Array.from({ length: MEMBERS }, (_, i) => ({
      id: `${STAMP}-m${String(i).padStart(4, "0")}`,
      tenantId: TENANT_ID,
      name: `Large ${i}`,
      email: `${STAMP}-m${i}@example.test`,
      joinedAt: new Date(now - ((i * 7) % (DAYS + 200)) * DAY),
      cancelledAt: kinds[i % kinds.length].status === "cancelled" ? new Date(now - ((i * 3) % 300) * DAY) : null,
      paymentStatus: i % 11 === 0 ? "overdue" : "paid",
      ...kinds[i % kinds.length],
    }));
    const instances: { id: string; classId: string; date: Date; startTime: string; endTime: string }[] = [];
    const records: { id: string; tenantId: string; memberId: string; classInstanceId: string; checkInTime: Date; checkInMethod: string; importJobId: string | null }[] = [];
    for (let d = 0; d < DAYS; d += 1) {
      for (const slot of [0, 1]) {
        const at = new Date(now - d * DAY);
        at.setUTCHours(slot ? 19 : 12, 0, 0, 0);
        const inst = { id: `${STAMP}-i${d}-${slot}`, classId: `${STAMP}-c${(d + slot) % 4}`, date: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())), startTime: slot ? "19:00" : "12:00", endTime: slot ? "20:00" : "13:00" };
        instances.push(inst);
        const imported = d > 365;
        for (let k = 0; k < PER_SESSION; k += 1) {
          const m = (d * 37 + slot * 101 + k * 29) % MEMBERS;
          records.push({
            id: `${inst.id}-r${k}`,
            tenantId: TENANT_ID,
            memberId: members[m].id,
            classInstanceId: inst.id,
            checkInTime: new Date(at.getTime() + k * 30_000),
            checkInMethod: imported ? "import" : k % 3 ? "kiosk" : "admin",
            importJobId: imported ? `${STAMP}-job` : null,
          });
        }
      }
    }
    // (memberId, classInstanceId) is unique: the stride above never repeats a member inside one session.
    checkIns = records.length;
    const write = (fn: Parameters<typeof withRlsBypass>[0]) => withRlsBypass(fn, { maxWait: 10_000, timeout: 120_000 });
    await chunks(members, 1000, (part) => write((tx) => tx.member.createMany({ data: part })));
    await chunks(instances, 2000, (part) => write((tx) => tx.classInstance.createMany({ data: part })));
    await chunks(records, 5000, (part) => write((tx) => tx.attendanceRecord.createMany({ data: part })));
  }, 600_000);

  afterAll(async () => {
    await withRlsBypass(
      async (tx) => {
        await tx.attendanceRecord.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId: TENANT_ID } } });
        await tx.class.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.importJob.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.member.deleteMany({ where: { tenantId: TENANT_ID } });
        await tx.tenant.deleteMany({ where: { id: TENANT_ID } });
      },
      { maxWait: 10_000, timeout: 120_000 },
    );
    if (OUT_DIR) {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(path.join(OUT_DIR, `s3-reports-timing-${ROLE}.json`), JSON.stringify({ checkIns, members: MEMBERS, timings }, null, 2));
    }
  }, 300_000);

  const now = new Date();
  const from24 = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1)));
  const from12 = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)));
  const to = monthKey(now);
  const loads: [string, Parameters<typeof getReportsData>[1], number][] = [
    ["24 months, whole club", { period: { period: "custom", from: from24, to } }, 5],
    ["12 months, adults, one class", { period: { period: "custom", from: from12, to }, ageGroup: "adult", classId: `${STAMP}-c0` }, 3],
    ["this month (the default)", {}, 3],
  ];

  it.each(loads)("%s: every uncached load finishes inside the budget", async (name, options, runs) => {
    expect(checkIns).toBeGreaterThan(50_000);
    const ms: number[] = [];
    for (let r = 0; r < runs; r += 1) {
      const t0 = performance.now();
      const data = await getReportsData(TENANT_ID, options);
      ms.push(Math.round(performance.now() - t0));
      expect(data.summary.totalMembers).toBeGreaterThan(0);
    }
    timings[name] = ms;
    console.log(`[s3-m1] ${ROLE} ${name}: ${ms.join(", ")} ms (review line ${REVIEW_LINE_MS} ms, budget ${BUDGET_MS} ms)`);
    for (const t of ms) expect(t).toBeLessThan(BUDGET_MS);
  }, 300_000);
});
