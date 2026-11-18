// Round 4 close-out (11 Nov 2026): MEASURED cost of the settings precondition
// (club row FOR NO KEY UPDATE + compare), against the Neon TEST branch, real
// PATCH /api/settings. Runs only when R4_PERF_OUT names a file to write the
// timings to; it asserts nothing about speed (network latency to the test
// branch dominates and varies), it records numbers for the evidence doc.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { writeFileSync } from "node:fs";

vi.mock("next/server", () => {
  class NR extends Response {
    static json(body: unknown, init?: { status?: number }) {
      return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json" } });
    }
  }
  return { NextRequest: class extends Request {}, NextResponse: NR };
});
const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/support-refusal-audit", () => ({ recordSupportRefusal: vi.fn(async () => {}), refusedFieldsOf: vi.fn(async () => []) }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH as settingsPatch } from "@/app/api/settings/route";

const HAS_DB = !!process.env.DATABASE_URL;
const OUT = process.env.R4_PERF_OUT;
const STAMP = `r4perf${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 600_000 });

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

describe.skipIf(!HAS_DB || !OUT)("Round 4 precondition cost (measured)", () => {
  let tenantId = "";
  let ownerId = "";
  beforeAll(async () => {
    tenantId = (await withRlsBypass((tx) => tx.tenant.create({ data: { name: `${STAMP}`, slug: STAMP, primaryColor: "#111111" } }))).id;
    ownerId = (await withRlsBypass((tx) => tx.user.create({ data: { tenantId, email: `${STAMP}@example.test`, passwordHash: "x", name: "Owner", role: "owner" } }))).id;
    authState.session = { user: { id: ownerId, tenantId, role: "owner", email: `${STAMP}@example.test` } };
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => { await tx.user.deleteMany({ where: { tenantId } }); await tx.tenant.deleteMany({ where: { id: tenantId } }); });
  });

  it("records save latency with and without `expected`, and a burst of 10 concurrent same-field saves", async () => {
    const save = async (body: unknown) => {
      const t0 = performance.now();
      const r = await settingsPatch(new Request("https://test.local/api/settings", { method: "PATCH", body: JSON.stringify(body) }));
      return { ms: performance.now() - t0, status: r.status };
    };
    const N = 20;
    const plain: number[] = [];
    const withExpected: number[] = [];
    let colour = 0x111111;
    const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
    for (let i = 0; i < 3; i++) await save({ primaryColor: hex(++colour) }); // warm up the pool
    for (let i = 0; i < N; i++) {
      plain.push((await save({ primaryColor: hex(++colour) })).ms);
      const prev = hex(colour);
      withExpected.push((await save({ primaryColor: hex(++colour), expected: { primaryColor: prev } })).ms);
    }
    const base = hex(colour);
    const t0 = performance.now();
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => save({ primaryColor: hex(0xa00000 + i), expected: { primaryColor: base } })));
    const burstMs = performance.now() - t0;
    const result = {
      measuredAt: new Date().toISOString(),
      note: "Local machine to the Neon test branch over the internet; per-request time includes network round trips. Each save is sequential except the burst.",
      n: N,
      plainMs: { p50: Math.round(pct(plain, 50)), p95: Math.round(pct(plain, 95)) },
      withExpectedMs: { p50: Math.round(pct(withExpected, 50)), p95: Math.round(pct(withExpected, 95)) },
      burst10: { totalMs: Math.round(burstMs), statuses: burst.map((b) => b.status).sort(), slowestMs: Math.round(Math.max(...burst.map((b) => b.ms))) },
    };
    writeFileSync(OUT!, JSON.stringify(result, null, 2));
    expect(burst.filter((b) => b.status === 200)).toHaveLength(1);
  });
});
