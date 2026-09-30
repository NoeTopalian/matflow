/**
 * End-user round 2 (30 Sep 2026) — the server-side and pure halves of what the
 * desk and the member app found. Screens are covered in
 * end-user-round2-screens.test.tsx.
 *
 *  - "Buy a pack" at a pay-at-desk club (3.8 / 6.4)
 *  - staff keep the owner's temporary password (2.1)
 *  - Edit Waiver opens empty (1.9)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { authMock, updateManyMock, findFirstMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  updateManyMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("$2a$12$hashed") } }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ user: { updateMany: updateManyMock, findFirst: findFirstMock } }),
}));

import { checkinRefusal } from "@/lib/checkin-refusal";
import { waiverEditorStart, waiverSaveValues, defaultWaiverText } from "@/lib/waiver-editor";
import { buildDefaultWaiverContent, buildDefaultKidsWaiverContent } from "@/lib/default-waiver";
import { PATCH as patchStaff } from "@/app/api/staff/[id]/route";

describe("no plan at a pay-at-desk club", () => {
  it("says to ask the desk, never to buy a pack the club does not sell online", () => {
    const r = checkinRefusal({ kind: "no_coverage" }, { paymentRail: "pay_at_desk" })!;
    expect(r.status).toBe(402);
    expect(r.body).toEqual({ error: "No plan yet — ask the desk to add one.", reason: "no_coverage" });
    expect(r.body.error).not.toMatch(/buy a pack/i);
  });

  it("a club that sells online keeps the pack sentence", () => {
    expect(checkinRefusal({ kind: "no_coverage" }, { paymentRail: "stripe" })!.body.error).toMatch(/Buy a pack/);
    expect(checkinRefusal({ kind: "no_coverage" })!.body.error).toMatch(/Buy a pack/);
  });
});

describe("an owner-chosen staff password is temporary", () => {
  function patchReq(body: Record<string, unknown>) {
    return new Request("http://localhost/api/staff/u-staff", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  const params = { params: Promise.resolve({ id: "u-staff" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "t-1" } });
    updateManyMock.mockResolvedValue({ count: 1 });
    findFirstMock.mockResolvedValue({ id: "u-staff", name: "Della", email: "della@example.test", role: "manager" });
  });

  it("an owner reset sets mustChangePassword, so the staff member picks their own at sign-in", async () => {
    const res = await patchStaff(patchReq({ newPassword: "TempPass123" }), params);
    expect(res.status).toBe(200);
    const data = updateManyMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.mustChangePassword).toBe(true);
    expect(data.passwordHash).toBe("$2a$12$hashed");
  });

  it("an edit that does not touch the password does not set it", async () => {
    await patchStaff(patchReq({ name: "Della Desk" }), params);
    const data = updateManyMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("mustChangePassword");
  });

  it("the write can never reach the owner's own row", async () => {
    await patchStaff(patchReq({ newPassword: "TempPass123" }), params);
    const where = updateManyMock.mock.calls[0][0].where as { role: unknown };
    expect(where.role).toEqual({ not: "owner" });
  });
});

describe("Edit Waiver opens with the text the owner is looking at", () => {
  it("with no custom waiver: the default the server would record, with the club's name", () => {
    const start = waiverEditorStart("adult", { title: null, content: null }, "Kestrel Grappling");
    expect(start.title).toBe("Liability Waiver & Assumption of Risk");
    expect(start.content).toBe(buildDefaultWaiverContent("Kestrel Grappling"));
    expect(start.content).toContain("Kestrel Grappling");
  });

  it("with a custom waiver: the club's own title and text", () => {
    const start = waiverEditorStart("adult", { title: "Kestrel Mat Waiver", content: "KESTREL TEXT" }, "Kestrel");
    expect(start).toEqual({ title: "Kestrel Mat Waiver", content: "KESTREL TEXT" });
  });

  it("the parent/guardian editor opens with the guardian default", () => {
    const start = waiverEditorStart("kids", { title: "", content: "" }, "Kestrel");
    expect(start.title).toBe("Parent/Guardian Liability Waiver");
    expect(start.content).toBe(buildDefaultKidsWaiverContent("Kestrel"));
  });

  it("saving the default unchanged stays on the default (null), an edit is saved as written", () => {
    const d = defaultWaiverText("adult", "Kestrel");
    expect(waiverSaveValues("adult", d, "Kestrel")).toEqual({ title: null, content: null });
    expect(waiverSaveValues("adult", { title: d.title, content: "Our own words" }, "Kestrel")).toEqual({
      title: null,
      content: "Our own words",
    });
    expect(waiverSaveValues("adult", { title: "", content: "" }, "Kestrel")).toEqual({ title: null, content: null });
  });
});
