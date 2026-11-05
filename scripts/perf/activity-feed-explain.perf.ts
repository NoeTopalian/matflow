// The body of scripts/perf/activity-feed-explain.mjs — see that file for what this is and how to run it.
//
// Synthetic data only: two clubs named mfv-perf-…, created here, torn down to nothing in afterAll whatever happens.
// Raw SQL appears here and nowhere in the application: EXPLAIN has no Prisma form.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { GET } from "@/app/api/activity/route";

const ROWS = Math.max(1_000, Number(process.env.ROWS ?? 200_000));
const BATCH = 5_000;
const PASS_MS = 300;
const DAY = 86_400_000;
const STAMP = randomUUID().slice(0, 8);
const id = (name: string) => `mfvperf${STAMP}${name}`;

const T1 = id("t1");
const T2 = id("t2");
const OWNER = id("owner");
const MANAGER = id("manager");
const JACK = id("jack");
const BUSY = id("busy");
const NEEDLE = id("needle");
/** An id on a few recent rows that is no member: the page must then ask the log for a recorded name. */
const GONE = id("gone");
const CLS = id("class");
const TIER_A = id("tierA");
const TIER_B = id("tierB");
const PAYMENT = id("payment");
const MEMBERS = Array.from({ length: 300 }, (_, i) => id(`m${i}`));
const SESSIONS = Array.from({ length: 8 }, (_, i) => id(`s${i}`));
const NOW = Date.now();
/** Vitest keeps a passing test's console output to itself; the wrapper reads these lines from stderr. */
const say = (line: string) => void process.stderr.write(`${line}
`);

type AuditInput = { id: string; tenantId: string; action: string; entityType: string; entityId: string; metadata?: object; createdAt: Date; userId: string | null };

/** Row `i` of a club, newest first: a realistic mix, spread evenly over a year. */
function makeRow(tenant: string, i: number): AuditInput {
  const real = tenant === T1;
  const who = (userId: string) => (real ? userId : null);
  const member = i % 300 === 0 ? BUSY : i < 40 && i % 10 === 3 ? GONE : MEMBERS[(i * 7919) % MEMBERS.length];
  const session = SESSIONS[(i * 31) % SESSIONS.length];
  const base = { id: `${tenant}r${i}`, tenantId: tenant, createdAt: new Date(NOW - Math.floor((i * 365 * DAY) / ROWS) - 60_000), userId: null as string | null };
  // One member whose only activity is in the oldest month: the worst case for the member filter.
  if (i > ROWS * 0.92 && i % 400 === 0) return { ...base, action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: `rec${i}`, metadata: { classInstanceId: session, memberId: NEEDLE, method: "self", actorId: NEEDLE } };
  const k = i % 100;
  if (k < 60) return { ...base, action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: `rec${i}`, metadata: { classInstanceId: session, memberId: member, method: "self", actorId: member } };
  if (k < 70) return { ...base, userId: who(JACK), action: "attendance.mark", entityType: "AttendanceRecord", entityId: `${session}:${member}`, metadata: { classInstanceId: session, memberId: member, method: "admin", recordId: `rec${i}`, created: true, ...(i % 7 === 0 ? { acknowledged: ["waiver_unsigned"] } : {}) } };
  if (k < 73) return { ...base, userId: who(JACK), action: "attendance.card_scan", entityType: "ClassInstance", entityId: session, metadata: { classInstanceId: session, scanned: 5, recorded: 5, memberIds: [0, 1, 2, 3, 4].map((n) => MEMBERS[(i + n * 37) % MEMBERS.length]) } };
  if (k < 81) {
    const changes = i % 11 === 0 ? { membershipTierId: { from: TIER_A, to: TIER_B } } : i % 13 === 0 ? { status: { from: "active", to: "cancelled" } } : { phone: { from: "07700 900000", to: "07700 900001" } };
    return { ...base, userId: who(JACK), action: "member.update", entityType: "Member", entityId: member, metadata: { fields: Object.keys(changes), changes } };
  }
  if (k < 89) return { ...base, action: "member.payment.succeeded", entityType: "Member", entityId: member, metadata: { stripeInvoiceId: `in_${tenant}_${i}`, amountPence: 4500, currency: "gbp" } };
  if (k === 89) {
    return i % 1000 === 89
      ? { ...base, userId: who(OWNER), action: "payment.refund", entityType: "Payment", entityId: PAYMENT, metadata: { amountPence: 500, fullyRefunded: false } }
      : { ...base, userId: who(JACK), action: "payment.manual", entityType: "Payment", entityId: `pay${i}`, metadata: { memberId: member, method: "cash", amountPence: 2000 } };
  }
  if (k < 93) return { ...base, userId: who(OWNER), action: "class.updated", entityType: "Class", entityId: CLS, metadata: { fields: ["maxCapacity"] } };
  if (k === 93) return { ...base, action: "waiver.sign", entityType: "Member", entityId: member, metadata: { signedWaiverId: `w${i}`, collectedBy: "self" } };
  if (k < 96) return { ...base, userId: who(OWNER), action: "auth.magic_link.request", entityType: "User", entityId: OWNER };
  if (k === 96) return { ...base, userId: who(OWNER), action: "tenant.settings.update", entityType: "Tenant", entityId: tenant, metadata: { fields: ["name"] } };
  if (k === 97) return { ...base, userId: who(OWNER), action: "undo.member.update", entityType: "Member", entityId: member, metadata: { undoneAuditId: `${tenant}r${i + 1}` } };
  if (k === 98) return { ...base, userId: who(OWNER), action: "staff.update", entityType: "User", entityId: JACK, metadata: { changes: { name: { from: "a", to: "b" } } } };
  return { ...base, userId: who(JACK), action: "member.rank.promote", entityType: "Member", entityId: member, metadata: { fromRankId: null, toRankId: id("rank"), stripes: 0 } };
}

// ── What Prisma sent, replayed under EXPLAIN ─────────────────────────────────

type Sent = { text: string; values: unknown[] };
// Watched, never replaced: the original still runs.
const spy = vi.spyOn(pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }, "query");

function sentSince(): Sent[] {
  return (spy.mock.calls as unknown[][]).flatMap(([config, values]) => {
    if (config && typeof config === "object" && "text" in config) return [{ text: String((config as { text: unknown }).text), values: ((config as { values?: unknown[] }).values ?? (values as unknown[]) ?? []) as unknown[] }];
    return [];
  });
}

function literal(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(",")}]`;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return `'${s.replace(/'/g, "''")}'`;
}

/** The statement with its parameters written in, so it can be explained as one string. Synthetic values only. */
const inline = (sent: Sent) => sent.text.replace(/\$(\d+)\b/g, (_, n: string) => literal(sent.values[Number(n) - 1]));

type PlanNode = { "Node Type": string; "Index Name"?: string; "Actual Rows"?: number; "Rows Removed by Filter"?: number; "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number; Plans?: PlanNode[] };

function describePlan(node: PlanNode): { nodes: string[]; removed: number } {
  const nodes: string[] = [];
  let removed = 0;
  (function walk(n: PlanNode) {
    nodes.push(n["Index Name"] ? `${n["Node Type"]} ${n["Index Name"]}` : n["Node Type"]);
    removed += n["Rows Removed by Filter"] ?? 0;
    for (const child of n.Plans ?? []) walk(child);
  })(node);
  return { nodes, removed };
}

async function explain(tenantId: string, sent: Sent) {
  const rows = await withTenantContext(tenantId, (tx) => tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inline(sent)}`), { timeout: 60_000 });
  const raw = rows[0]["QUERY PLAN"];
  const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: PlanNode; "Execution Time": number; "Planning Time": number }[];
  const { nodes, removed } = describePlan(plan[0].Plan);
  return { execMs: plan[0]["Execution Time"], planMs: plan[0]["Planning Time"], nodes, removed, hit: plan[0].Plan["Shared Hit Blocks"] ?? 0, read: plan[0].Plan["Shared Read Blocks"] ?? 0 };
}

const isAudit = (s: Sent) => /FROM\s+"public"\."AuditLog"/.test(s.text) && !/^\s*EXPLAIN/i.test(s.text);
const pageQuery = (all: Sent[]) => all.find((s) => isAudit(s) && /ORDER BY/.test(s.text) && /LIMIT/.test(s.text));
const undoQuery = (all: Sent[]) => all.find((s) => isAudit(s) && /LIKE/.test(s.text));
const deletedNameQuery = (all: Sent[]) => all.find((s) => isAudit(s) && !/ORDER BY/.test(s.text) && !/LIKE/.test(s.text) && /"entityId" IN/.test(s.text));

type Result = { label: string; status: number; entries: number; execMs: number; planMs: number; wallMs: number; plan: string };
const results: Result[] = [];

const as = (role: "owner" | "manager") => vi.mocked(auth).mockResolvedValue({ user: { id: role === "owner" ? OWNER : MANAGER, role, tenantId: T1 } } as never);

async function scenario(label: string, query: string, role: "owner" | "manager" = "owner", pick: (all: Sent[]) => Sent | undefined = pageQuery) {
  as(role);
  // Once to warm the connection and the plan cache, then the measured call.
  await GET(new Request(`https://test.local/api/activity${query}`));
  spy.mockClear();
  const started = performance.now();
  const res = await GET(new Request(`https://test.local/api/activity${query}`));
  const wallMs = performance.now() - started;
  const body = (await res.json()) as { entries?: unknown[] };
  const sent = pick(sentSince());
  if (!sent) {
    results.push({ label, status: res.status, entries: body.entries?.length ?? 0, execMs: NaN, planMs: NaN, wallMs, plan: "the query was not issued" });
    return;
  }
  const plan = await explain(T1, sent);
  results.push({ label, status: res.status, entries: body.entries?.length ?? 0, execMs: plan.execMs, planMs: plan.planMs, wallMs, plan: `${plan.nodes.join(" > ")} | filtered out ${plan.removed} | buffers hit ${plan.hit} read ${plan.read}` });
}

const dayKey = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);

describe.skipIf(!process.env.ACTIVITY_PERF || !process.env.TEST_DATABASE_URL)("Activity feed — query cost on a year of rows", () => {
  beforeAll(async () => {
    const started = Date.now();
    await withRlsBypass(async (tx) => {
      await tx.tenant.createMany({ data: [T1, T2].map((t, i) => ({ id: t, name: `Synthetic perf ${i + 1} ${STAMP}`, slug: `mfv-perf-${i + 1}-${STAMP}`, timezone: "Europe/London" })) });
      await tx.user.createMany({
        data: [
          { id: OWNER, tenantId: T1, email: `perf-owner-${STAMP}@example.test`, passwordHash: "x", name: "Perf Owner", role: "owner" },
          { id: MANAGER, tenantId: T1, email: `perf-manager-${STAMP}@example.test`, passwordHash: "x", name: "Perf Manager", role: "manager" },
          { id: JACK, tenantId: T1, email: `perf-jack-${STAMP}@example.test`, passwordHash: "x", name: "Perf Coach", role: "coach" },
        ],
      });
      await tx.membershipTier.createMany({ data: [{ id: TIER_A, tenantId: T1, name: "Perf plan A" }, { id: TIER_B, tenantId: T1, name: "Perf plan B" }] });
      await tx.member.createMany({ data: [...MEMBERS, BUSY, NEEDLE].map((m, i) => ({ id: m, tenantId: T1, email: `perf-m${i}-${STAMP}@example.test`, name: `Perf Member ${i}` })) });
      await tx.class.create({ data: { id: CLS, tenantId: T1, name: "Perf class" } });
      await tx.classInstance.createMany({ data: SESSIONS.map((s, i) => ({ id: s, classId: CLS, date: new Date(Date.UTC(2026, 0, 1 + i)), startTime: "19:00" })) });
      await tx.payment.create({ data: { id: PAYMENT, tenantId: T1, memberId: BUSY, amountPence: 4500, currency: "GBP", status: "succeeded" } });
    });
    for (const tenant of [T1, T2]) {
      for (let from = 0; from < ROWS; from += BATCH) {
        const data = Array.from({ length: Math.min(BATCH, ROWS - from) }, (_, n) => makeRow(tenant, from + n));
        await withRlsBypass((tx) => tx.auditLog.createMany({ data }), { timeout: 60_000 });
      }
    }
    say(`SEED ${ROWS} rows in each of 2 clubs in ${Math.round((Date.now() - started) / 1000)} s`);
    // Fresh statistics, as a table that grew over a year would have. Needs the owner role; the wrapper supplies its URL.
    if (process.env.PERF_ANALYZE_URL) {
      const client = new pg.Client({ connectionString: process.env.PERF_ANALYZE_URL });
      try {
        await client.connect();
        await client.query('ANALYZE "AuditLog"');
        say("SEED statistics refreshed (ANALYZE)");
      } catch (e) {
        say(`SEED statistics NOT refreshed: ${e instanceof Error ? e.name : "error"}`);
      } finally {
        await client.end().catch(() => {});
      }
    } else say("SEED statistics NOT refreshed (no owner connection given)");
  });

  afterAll(async () => {
    const tenants = [T1, T2];
    // In slices: one statement deleting 400,000 rows would run past the statement bound.
    for (let slice = 0; slice < 14; slice++) {
      const newest = new Date(NOW - slice * 30 * DAY + DAY);
      const oldest = new Date(NOW - (slice + 1) * 30 * DAY);
      await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: { in: tenants }, createdAt: { gte: oldest, lt: newest } } }), { timeout: 60_000 });
    }
    const left = await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.payment.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.member.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
      return (await tx.auditLog.count({ where: { tenantId: { in: tenants } } })) + (await tx.tenant.count({ where: { id: { in: tenants } } }));
    }, { timeout: 60_000 });
    say(`TEARDOWN rows left: ${left}`);
    expect(left).toBe(0);
  });

  it(`each scenario runs in ${PASS_MS} ms or less`, async () => {
    await scenario("default first page (Club activity)", "");
    await scenario("everything, first page", "?types=all");
    await scenario("one member, active all year", `?types=all&memberId=${BUSY}`);
    await scenario("one member whose rows are all in the oldest month", `?types=all&memberId=${NEEDLE}`);
    await scenario("member page History (20 rows, embedded)", `?types=all&memberId=${BUSY}&take=20&embed=1`);
    await scenario("member page History, oldest-month member", `?types=all&memberId=${NEEDLE}&take=20&embed=1`);
    await scenario("one class", `?types=all&classId=${CLS}`);
    await scenario("one plan", `?types=all&tierId=${TIER_A}`);
    await scenario("one rare type (refunds, 1 row in 1,000)", "?types=refund");
    await scenario("one payment's trail", `?types=all&paymentId=${PAYMENT}`);
    await scenario("done by one staff member", `?types=all&userId=${JACK}`);
    await scenario("deep paging (page 40)", `?types=all&cursor=${T1}r1950`);
    await scenario("jump to a date 300 days back", `?types=all&day=${dayKey(300)}`);
    await scenario("manager, default first page", "", "manager");
    await scenario("manager, one member", `?types=all&memberId=${BUSY}`, "manager");
    await scenario("name lookup for a member who is gone (first page)", "?types=all", "owner", deletedNameQuery);
    for (const days of [30, 180, 364]) await scenario(`already-undone lookup, page ${days} days back`, `?types=all&day=${dayKey(days)}`, "owner", undoQuery);

    for (const r of results) {
      const verdict = Number.isFinite(r.execMs) ? (r.execMs <= PASS_MS ? "pass" : "OVER") : "n/a";
      say(`PERF | ${verdict} | ${r.label} | http ${r.status} | ${r.entries} entries | exec ${Number.isFinite(r.execMs) ? r.execMs.toFixed(1) : "-"} ms | plan ${Number.isFinite(r.planMs) ? r.planMs.toFixed(1) : "-"} ms | wall ${Math.round(r.wallMs)} ms`);
      say(`PLAN |      | ${r.label} | ${r.plan}`);
    }
    expect(results.every((r) => r.status === 200)).toBe(true);
    const over = results.filter((r) => !(r.execMs <= PASS_MS)).map((r) => `${r.label}: ${Number.isFinite(r.execMs) ? `${r.execMs.toFixed(1)} ms` : r.plan}`);
    expect(over, `over the ${PASS_MS} ms line`).toEqual([]);
  });
});
