// Round 4 (10 Nov 2026): a payment reminder sent twice by a double click or a
// retried request reaches the member once. Real handler and the real
// rate-limit store on the Neon TEST branch, both database roles
// (db-tests.mjs). Email is stubbed and counted; nothing is sent. Synthetic
// club (r4c-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number; headers?: HeadersInit }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers(init?.headers) }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const gate = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: vi.fn(async () => gate.value) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));
const mail = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async (e: Record<string, unknown>) => { mail.calls.push(e); return { ok: true }; }) }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as chase } from "@/app/api/payments/chase/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4c${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!HAS_DB)("payment chase: one reminder per click burst", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  let memberId = "";
  const as = (k: "A" | "B") => { gate.value = { ok: true, tenantId: club[k], userId: owner[k], role: "owner" }; };
  const send = () => chase(new Request("https://test.local/api/payments/chase", {
    method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify({ memberId }),
  })) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}` } });
        club[k] = t.id;
        owner[k] = (await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } })).id;
      }
      memberId = (await tx.member.create({ data: { tenantId: club.A, name: `${STAMP} member`, email: `${STAMP}-m@example.test` } })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.rateLimitHit.deleteMany({ where: { bucket: { contains: club.A } } });
      await tx.member.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("another club cannot chase this member (and sends nothing)", async () => {
    as("B");
    mail.calls.length = 0;
    expect((await send()).status).toBe(404);
    expect(mail.calls).toHaveLength(0);
  });

  it("two chases at once (a double click): one email, and the second is told a reminder was just started", async () => {
    as("A");
    mail.calls.length = 0;
    audit.calls.length = 0;
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect((await refused.json()).reason).toBe("chase_just_sent");
    expect(mail.calls).toHaveLength(1);
    expect(audit.calls.filter((c) => c.action === "payment.chase")).toHaveLength(1);
  });

  it("a retry seconds later still sends nothing more", async () => {
    as("A");
    mail.calls.length = 0;
    expect((await send()).status).toBe(409);
    expect(mail.calls).toHaveLength(0);
  });
});
