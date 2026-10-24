// D6 (24 Oct 2026): the card scanner's server path, through the real route
// handler and engine on real Postgres.
//  1. Concurrent requests for the same card and session: exactly one
//     success, every other answer "duplicate", one attendance row, one
//     attendance.card_scan audit row.
//  2. Card revocation is judged under the Member lock: a card revoked while
//     its scan waits on that lock is refused, not admitted on the version the
//     route read before the lock.
//  3. The round trips one scan costs, counted at the pg driver (every query
//     the Prisma adapter sends, BEGIN/COMMIT and set_config included), written
//     to a NOTE file in the OS temp directory for the report.
// Synthetic data; skips without DATABASE_URL.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { signCardToken } from "@/lib/card-token";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-authz", () => ({
  requireApiStaff: vi.fn(async () => ({ ok: true, tenantId: state.tenantId, userId: state.userId, role: "coach" })),
}));
const state = vi.hoisted(() => ({ tenantId: "", userId: "" }));

import { POST as cardRoute } from "@/app/api/checkin/card/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "card-scan-concurrency-synthetic-secret";

type ScanBody = { results: Array<{ status: string; memberId?: string }>; recorded: number };
async function scan(classInstanceId: string, token: string): Promise<ScanBody> {
  const res = (await cardRoute(
    new Request("http://test/api/checkin/card", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ classInstanceId, tokens: [token] }),
    }),
  )) as unknown as { status: number; json: () => Promise<ScanBody> };
  return res.json();
}

/** Every query any pg client sends while `fn` runs. */
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; count: number; kinds: Record<string, number> }> {
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const original = proto.query;
  let count = 0;
  const kinds: Record<string, number> = {};
  proto.query = function patched(this: unknown, ...args: unknown[]) {
    count += 1;
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | null)?.text ?? "";
    const kind = text.trim().split(/\s+/)[0]?.toUpperCase() || "?";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    return original.apply(this, args);
  };
  try {
    const result = await fn();
    return { result, count, kinds };
  } finally {
    proto.query = original;
  }
}

const MEMBER_LOCK_SQL = '%FROM "Member" WHERE "id"%UPDATE%';
async function waitForLockWaiters(pattern: string, n: number, withinMs = 8_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE ${pattern}
    `;
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const seen = await prisma.$queryRaw<{ s: string }[]>`
    SELECT coalesce(wait_event_type, '-') || '/' || coalesce(state, '-') || ': ' || regexp_replace(left(query, 70), '\s+', ' ', 'g') AS s
      FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
  `;
  throw new Error(`timed out waiting for ${n} backend(s) blocked on ${pattern}; active: ${seen.map((r) => r.s).join(" | ")}`);
}

describe.skipIf(!HAS_DB)("card scan server path — real database", () => {
  let classId = "";
  let tierId = "";
  let day = 0;
  const newSession = () =>
    withRlsBypass(async (tx) => (await tx.classInstance.create({
      data: { classId, date: new Date(Date.UTC(2032, 1, 1 + day++)), startTime: "18:00", endTime: "19:00" },
    })).id);
  const newMember = (name: string) =>
    withRlsBypass(async (tx) => (await tx.member.create({
      data: { tenantId: state.tenantId, name, email: `card-cc-${name.toLowerCase().replace(/\s+/g, "-")}-${STAMP}@example.test`, membershipTierId: tierId, waiverAccepted: true, paymentStatus: "paid" },
    })).id);
  const cardAudits = (classInstanceId: string) =>
    withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: state.tenantId, action: "attendance.card_scan", entityId: classInstanceId } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      state.tenantId = (await tx.tenant.create({ data: { name: `Card cc ${STAMP}`, slug: `card-cc-${STAMP}` } })).id;
      state.userId = (await tx.user.create({ data: { tenantId: state.tenantId, email: `card-cc-coach-${STAMP}@example.test`, name: "Coach", role: "coach", passwordHash: "x" } })).id;
      tierId = (await tx.membershipTier.create({ data: { tenantId: state.tenantId, name: "Unlimited" } })).id;
      classId = (await tx.class.create({ data: { tenantId: state.tenantId, name: "Card class", duration: 60, maxCapacity: 50 } })).id;
    });
  }, 60_000);

  afterAll(async () => {
    if (!state.tenantId) return;
    const tenantId = state.tenantId;
    await new Promise((r) => setTimeout(r, 1_500)); // best-effort audit rows still landing
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.rateLimitHit.deleteMany({ where: { bucket: { contains: tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 60_000);

  it("six concurrent scans of one card: one success, five duplicates, one attendance row, one audit row", async () => {
    const memberId = await newMember("Concurrent One");
    const sessionId = await newSession();
    const token = signCardToken({ tenantId: state.tenantId, memberId, cardVersion: 1 });
    const answers = await Promise.all(Array.from({ length: 6 }, () => scan(sessionId, token)));
    const statuses = answers.map((a) => a.results[0].status).sort();
    expect(statuses).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "success"]);
    expect(answers.reduce((n, a) => n + a.recorded, 0)).toBe(1);
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId, classInstanceId: sessionId } }))).toBe(1);
    // The audit row is best-effort (written after the response); wait for it to land, then make sure no second one does.
    const deadline = Date.now() + 8_000;
    while ((await cardAudits(sessionId)) < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await cardAudits(sessionId)).toBe(1);
  }, 120_000);

  it("a card revoked while its scan waits on the Member lock is refused as revoked, and records nothing", async () => {
    const memberId = await newMember("Revoked Midway");
    const sessionId = await newSession();
    const token = signCardToken({ tenantId: state.tenantId, memberId, cardVersion: 1 });
    // The revocation (cardVersion + 1, as the revoke route writes it) is in
    // flight: it holds the Member row, uncommitted, while the scan runs.
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const isReady = new Promise<void>((r) => { ready = r; });
    // A long budget: from this machine one scan is ~50 round trips at ~0.2 s,
    // so it reaches the Member lock 10 s or more after it starts.
    const revoke = withRlsBypass(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`UPDATE "Member" SET "cardVersion" = "cardVersion" + 1 WHERE "id" = ${memberId}`;
      ready();
      await released;
    }, { timeout: 90_000 });
    await isReady;
    const pending = scan(sessionId, token); // the route reads version 1 (the committed row), then parks on the lock
    try {
      await waitForLockWaiters(MEMBER_LOCK_SQL, 1, 60_000);
    } finally {
      release();
      await revoke;
    }
    const answer = await pending;
    expect(answer.results[0].status).toBe("revoked");
    expect(answer.recorded).toBe(0);
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId, classInstanceId: sessionId } }))).toBe(0);
  }, 120_000);

  it("NOTE: round trips for one scan (admitted) and one repeat (duplicate)", async () => {
    const memberId = await newMember("Round Trips");
    const sessionId = await newSession();
    const token = signCardToken({ tenantId: state.tenantId, memberId, cardVersion: 1 });
    await scan(await newSession(), token); // warm the pool and the code paths
    // Each window includes the best-effort audit write the scan starts (it lands within the second).
    const settle = <T,>(p: Promise<T>) => p.then(async (v) => { await new Promise((r) => setTimeout(r, 1_000)); return v; });
    const admitted = await countQueries(() => settle(scan(sessionId, token)));
    expect(admitted.result.results[0].status).toBe("success");
    const repeat = await countQueries(() => settle(scan(sessionId, token)));
    expect(repeat.result.results[0].status).toBe("duplicate");
    const role = (() => { try { return new URL(process.env.DATABASE_URL ?? "").username; } catch { return "unknown"; } })();
    const note = { at: new Date().toISOString(), role, admitted: { count: admitted.count, kinds: admitted.kinds }, duplicate: { count: repeat.count, kinds: repeat.kinds } };
    fs.writeFileSync(path.join(os.tmpdir(), `matflow-card-roundtrips-${role}.json`), JSON.stringify(note, null, 2));
    expect(admitted.count).toBeGreaterThan(0);
  }, 120_000);
});
