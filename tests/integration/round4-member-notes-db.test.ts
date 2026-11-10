// Round 4 (10 Nov 2026): a member's internal notes are not silently
// overwritten by a stale or retried save. Real PATCH /api/members/[id], Neon
// TEST branch, both database roles (db-tests.mjs). Synthetic clubs (r4n-),
// torn down here.

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
const STAMP = `r4n${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

type Res = { status: number; body: Record<string, unknown> };

describe.skipIf(!HAS_DB)("member notes: a newer note is never silently overwritten", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  let memberId = "";
  const as = (k: "A" | "B") => mockAuth.mockResolvedValue({ user: { id: owner[k], tenantId: club[k], role: "owner", email: `${STAMP}-${k}@example.test` } } as never);
  const patch = async (body: unknown): Promise<Res> => {
    const r = (await patchMember(
      new Request("https://test.local/", { method: "PATCH", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: memberId }) },
    )) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const row = () => withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { notes: true, phone: true, updatedAt: true } }));
  const setNotes = (notes: string | null) => withRlsBypass((tx) => tx.member.update({ where: { id: memberId }, data: { notes } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}`, onboardingCompleted: true } });
        club[k] = t.id;
        owner[k] = (await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } })).id;
      }
      memberId = (await tx.member.create({ data: { tenantId: club.A, name: `${STAMP} member`, email: `${STAMP}-m@example.test`, notes: "Start" } })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.member.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("reproduction, the body the notes box sent before Round 4: a stale save silently replaces newer notes", async () => {
    as("A");
    await setNotes("Start");
    expect((await patch({ notes: "Admin A's injury note" })).status).toBe(200);
    expect((await patch({ notes: "Admin B, from a page opened earlier" })).status).toBe(200);
    // Kept as the documented legacy behaviour of a body without `expectedNotes`.
    expect((await row()).notes).toBe("Admin B, from a page opened earlier");
  });

  it("a stale save is refused with the current notes; the newer notes stay", async () => {
    as("A");
    await setNotes("Start");
    expect((await patch({ notes: "Admin A's injury note", expectedNotes: "Start" })).status).toBe(200);
    audit.calls.length = 0;
    const stale = await patch({ notes: "Admin B's note", expectedNotes: "Start" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_notes", currentNotes: "Admin A's injury note" });
    expect((await row()).notes).toBe("Admin A's injury note");
    expect(audit.calls).toHaveLength(0);
  });

  it("a retry after a lost reply succeeds without writing again", async () => {
    as("A");
    await setNotes("Start");
    const save = { notes: "Retried note", expectedNotes: "Start" };
    expect((await patch(save)).status).toBe(200);
    const first = await row();
    audit.calls.length = 0;
    const retry = await patch(save);
    expect(retry.status).toBe(200);
    const after = await row();
    expect(after.notes).toBe("Retried note");
    expect(after.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(audit.calls).toHaveLength(0);
  });

  it("two saves at once from the same notes: exactly one is written, the other is told", async () => {
    as("A");
    await setNotes("Start");
    const results = await Promise.all([
      patch({ notes: "Coach one", expectedNotes: "Start" }),
      patch({ notes: "Coach two", expectedNotes: "Start" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? "Coach one" : "Coach two";
    expect((await row()).notes).toBe(winner);
  });

  it("a notes save and a phone change at once: whatever was answered 200 is what is stored", async () => {
    as("A");
    await setNotes("Start");
    const { updatedAt } = await row();
    const [notes, phone] = await Promise.all([
      patch({ notes: "Parallel note", expectedNotes: "Start" }),
      patch({ updatedAt: updatedAt.toISOString(), name: `${STAMP} member`, phone: "07700900123" }),
    ]);
    const after = await row();
    if (notes.status === 200) expect(after.notes).toBe("Parallel note");
    if (phone.status === 200) expect(after.phone).toBe("+447700900123"); // stored as E.164
    for (const r of [notes, phone]) expect([200, 409]).toContain(r.status);
    expect(notes.status).toBe(200); // the notes precondition does not depend on the phone edit
  });

  it("another club cannot write this member's notes", async () => {
    as("B");
    await setNotes("Start");
    expect((await patch({ notes: "Cross-club", expectedNotes: "Start" })).status).toBe(404);
    expect((await row()).notes).toBe("Start");
  });
});
