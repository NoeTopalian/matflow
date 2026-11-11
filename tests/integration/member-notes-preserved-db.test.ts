// Hotfix (10 Nov 2026): a member edit that does not send notes must keep the
// member's internal notes. On main since 39385235 (1 Jun 2026) the notes
// field's transform turned an ABSENT key into null, so every profile, plan or
// status save erased them. Real PATCH /api/members/[id], Neon TEST branch,
// both database roles (db-tests.mjs). Synthetic clubs (hfn-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `hfn${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

const NOTE = "Injured left knee — no takedowns until December";

describe.skipIf(!HAS_DB)("member edits keep internal notes they do not send", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  let coachA = "";
  let memberId = "";
  let tierId = "";
  const as = (k: "A" | "B", role = "owner", id = owner[k]) => mockAuth.mockResolvedValue({ user: { id, tenantId: club[k], role, email: `${STAMP}-${k}-${role}@example.test` } } as never);
  const patch = async (body: unknown) => {
    const r = (await patchMember(
      new Request("https://test.local/", { method: "PATCH", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: memberId }) },
    )) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const row = () => withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { notes: true, phone: true, status: true, membershipTierId: true, updatedAt: true } }));
  const setNotes = (notes: string | null) => withRlsBypass((tx) => tx.member.update({ where: { id: memberId }, data: { notes } }));
  const lastUpdateAudit = () => [...audit.calls].reverse().find((c) => c.action === "member.update") as { metadata?: { fields?: string[] } } | undefined;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        club[k] = (await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}`, onboardingCompleted: true } })).id;
        owner[k] = (await tx.user.create({ data: { tenantId: club[k], email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } })).id;
      }
      coachA = (await tx.user.create({ data: { tenantId: club.A, email: `${STAMP}-coach@example.test`, passwordHash: "x", name: "Coach A", role: "coach" } })).id;
      tierId = (await tx.membershipTier.create({ data: { tenantId: club.A, name: `${STAMP} Adult`, pricePence: 6500, currency: "GBP", billingCycle: "monthly" } })).id;
      memberId = (await tx.member.create({ data: { tenantId: club.A, name: `${STAMP} member`, email: `${STAMP}-m@example.test`, notes: NOTE } })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.member.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("a profile save that omits notes keeps them (the screen's own body), and its audit does not list notes", async () => {
    as("A");
    await setNotes(NOTE);
    const { updatedAt } = await row();
    expect((await patch({ updatedAt: updatedAt.toISOString(), name: `${STAMP} member`, phone: "07700900222", emergencyContactName: null })).status).toBe(200);
    expect((await row()).notes).toBe(NOTE);
    expect(lastUpdateAudit()?.metadata?.fields ?? []).not.toContain("notes");
  });

  it("a plan change that omits notes keeps them", async () => {
    as("A");
    await setNotes(NOTE);
    expect((await patch({ membershipTierId: tierId })).status).toBe(200);
    const r = await row();
    expect([r.notes, r.membershipTierId]).toEqual([NOTE, tierId]);
  });

  it("a status change that omits notes keeps them", async () => {
    as("A");
    await setNotes(NOTE);
    expect((await patch({ status: "inactive" })).status).toBe(200);
    expect(await row()).toMatchObject({ notes: NOTE, status: "inactive" });
    await patch({ status: "active" });
  });

  it("explicitly changing notes still works, and its audit lists notes", async () => {
    as("A");
    await setNotes(NOTE);
    expect((await patch({ notes: "Back to full training" })).status).toBe(200);
    expect((await row()).notes).toBe("Back to full training");
    expect(lastUpdateAudit()?.metadata?.fields).toContain("notes");
  });

  it("explicitly clearing notes still clears them (null, blank and whitespace-only, as before)", async () => {
    as("A");
    for (const cleared of [null, "", "   \n  "]) {
      await setNotes(NOTE);
      expect((await patch({ notes: cleared })).status).toBe(200);
      expect((await row()).notes).toBeNull();
    }
  });

  it("notes are still sanitised when sent (control and zero-width characters stripped, trimmed)", async () => {
    as("A");
    expect((await patch({ notes: "  Pays​ cash\u0007  " })).status).toBe(200);
    expect((await row()).notes).toBe("Pays cash");
  });

  it("a coach cannot edit the member, and nothing changes", async () => {
    as("A", "coach", coachA);
    await setNotes(NOTE);
    expect((await patch({ notes: "coach edit" })).status).toBe(403);
    expect((await row()).notes).toBe(NOTE);
  });

  it("another club cannot edit this member's notes or profile", async () => {
    as("B");
    await setNotes(NOTE);
    expect((await patch({ notes: "cross-club" })).status).toBe(404);
    expect((await patch({ phone: "07700900333" })).status).toBe(404);
    expect((await row()).notes).toBe(NOTE);
  });
});
