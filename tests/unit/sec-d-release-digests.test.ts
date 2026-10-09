/**
 * Security lane D (9 Oct 2026, third pass, reviewer R SF-54): every path that RELEASES a login address writes
 * releasedEmailSha256 = emailDigest(address) into its audit metadata, and the attendance import reads it
 * (lib/attendance-import.ts loadClubInputs). Behavioural for staff DELETE; source assertions for the three larger
 * routes (members DELETE is exercised for real in tests/integration/sec-d-attendance-misbinding-db.test.ts).
 */
import { vi, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) } }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: vi.fn(() => null) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u_owner", tenantId: "t_secd", role: "owner" } })) }));
const audit = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (a: Record<string, unknown>) => { audit.rows.push(a); }) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>) =>
    fn({ user: { findFirst: async () => ({ email: "secd-coach@example.test" }), deleteMany: async () => ({ count: 1 }) } }),
}));

import { DELETE as deleteStaff } from "@/app/api/staff/[id]/route";
import { emailDigest } from "@/lib/login-email";

describe("SF-54 release paths record the released address", () => {
  it("staff DELETE: the audit row carries releasedEmailSha256 = emailDigest(address)", async () => {
    const res = (await deleteStaff(new Request("https://test.local/api/staff/u_coach", { method: "DELETE" }), { params: Promise.resolve({ id: "u_coach" }) } as never)) as unknown as { status: number };
    expect(res.status).toBe(200);
    const row = audit.rows.find((r) => r.action === "staff.delete");
    expect((row?.metadata as Record<string, unknown>)?.releasedEmailSha256).toBe(emailDigest("secd-coach@example.test"));
  });

  const ROOT = path.resolve(__dirname, "../..");
  for (const [route, action] of [
    ["app/api/members/[id]/route.ts", "member.delete"],
    ["app/api/admin/dsar/erase/route.ts", "member.dsar_erase"],
    ["app/api/admin/import/[id]/rollback/route.ts", "import.rollback"],
  ] as const) {
    it(`${route}: the ${action} audit metadata writes releasedEmailSha256 through emailDigest`, () => {
      const src = readFileSync(path.join(ROOT, route), "utf8");
      const at = src.indexOf(`action: "${action}"`);
      expect(at, `${action} audit call`).toBeGreaterThan(-1);
      const block = src.slice(at, at + 1500);
      expect(block).toMatch(/releasedEmailSha256:[^\n]*emailDigest\(/);
    });
  }

  it("the importer reads every release form (keyed, unkeyed, DSAR hashToken, releasedEmailSha256 lists)", () => {
    const src = readFileSync(path.join(ROOT, "lib/attendance-import.ts"), "utf8");
    for (const k of ["oldEmailSha256", "oldEmailDigest", "originalEmailHash", "releasedEmailSha256"]) expect(src).toContain(`'${k}'`);
    expect(src).toMatch(/createHash\("sha256"\)\.update\(normalised\)/);
    expect(src).toMatch(/hashToken\(normalised\)/);
  });
});

describe("SF-54 buildPlan compares every recorded release form (holder existed BEFORE the bookings)", () => {
  it.each(["keyed", "unkeyed", "hashToken"] as const)("a release recorded in the %s form refuses the name+address fallback", async (form) => {
    const { buildPlan } = await import("@/lib/attendance-import");
    const { createHash } = await import("node:crypto");
    const { hashToken } = await import("@/lib/token-hash");
    const addr = "bea.old@example.test";
    const digest = form === "keyed" ? emailDigest(addr) : form === "unkeyed" ? createHash("sha256").update(addr).digest("hex") : hashToken(addr);
    const csv = ["Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status", ["Bea Lane", addr, "2025-11-03T18:00:00+00:00", "Adults Gi", "Main", "Attended"].join(",")].join("\n");
    const inputs = (released: Record<string, string[]>) => ({
      timezone: "Europe/London",
      members: [{ id: "m_other", name: "Bea Lane", email: addr, externalRef: null, createdAt: new Date("2025-01-01T00:00:00Z") }],
      classes: [{ id: "cls_1", name: "Adults Gi", isActive: true, historical: false, locationId: null }],
      locations: [{ id: "loc_1", name: "Main" }],
      decisions: { person: {}, offering: { "Adults Gi": { action: "class" as const, targetId: "cls_1" } }, venue: { Main: { action: "location" as const, targetId: "loc_1" } } },
      released,
    });
    const control = buildPlan(csv, inputs({}), new Date("2026-10-09T00:00:00Z"));
    if (control.errors) throw new Error(control.errors.join(" "));
    expect(control.plan.people[0].matchMethod, "positive control: no release → name_and_email").toBe("name_and_email");
    const refused = buildPlan(csv, inputs({ [digest]: ["m_orig"] }), new Date("2026-10-09T00:00:00Z"));
    if (refused.errors) throw new Error(refused.errors.join(" "));
    expect(refused.plan.people[0].memberId).toBeNull();
  });
});
