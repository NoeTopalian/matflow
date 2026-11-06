// The members' timetable reads against real Postgres (the Neon TEST branch), as both roles:
//   node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/member-timetable-db.test.ts
// A member of club A, through the real route handlers, never receives club B's mats, mat names or mat ids, from
// GET /api/member/timetable or from GET /api/member/schedule. Synthetic data only; skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as timetableGET } from "@/app/api/member/timetable/route";
import { GET as scheduleGET } from "@/app/api/member/schedule/route";

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!HAS_DB)("the members' timetable — real database", () => {
  const tenants: string[] = [];
  const ids = { A: "", B: "", memberA: "", matsA: [] as string[], matsB: [] as string[] };

  async function club(label: string, matNames: string[]) {
    const tenant = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `Synthetic member timetable ${label}`, slug: `mfv-mt-${randomUUID()}` } }));
    tenants.push(tenant.id);
    const mats: string[] = [];
    for (const [i, name] of matNames.entries()) {
      const mat = await withRlsBypass((tx) => tx.mat.create({ data: { tenantId: tenant.id, name, nameKey: name.toLowerCase(), sortOrder: i }, select: { id: true } }));
      mats.push(mat.id);
      await withRlsBypass((tx) =>
        tx.class.create({
          data: {
            tenantId: tenant.id, name: `${label} class on ${name}`, location: name, matId: mat.id, duration: 60,
            schedules: { create: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] },
          },
        }),
      );
    }
    return { id: tenant.id, mats };
  }

  beforeAll(async () => {
    const a = await club("A", ["Mat 1", "Mat 2"]);
    const b = await club("B", ["Cage B", "Upstairs B"]);
    ids.A = a.id; ids.B = b.id; ids.matsA = a.mats; ids.matsB = b.mats;
    const member = await withRlsBypass((tx) => tx.member.create({ data: { tenantId: a.id, name: "Synthetic Member", email: `member-${randomUUID()}@example.test` }, select: { id: true } }));
    ids.memberA = member.id;
    vi.mocked(auth).mockResolvedValue({ user: { id: `synthetic-member-${member.id}`, role: "member", tenantId: a.id, memberId: member.id } } as never);
  });

  afterAll(async () => {
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.mat.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.member.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  it("GET /api/member/timetable gives the member's own club's mats in order, split by mat, and nothing of the other club", async () => {
    const res = await timetableGET();
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { layout: string; mats: { id: string; name: string }[] };
    expect(body.mats).toEqual([{ id: ids.matsA[0], name: "Mat 1" }, { id: ids.matsA[1], name: "Mat 2" }]);
    expect(body.layout).toBe("mat");
    for (const id of ids.matsB) expect(text).not.toContain(id);
    expect(text).not.toContain("Cage B");
    expect(text).not.toContain("Upstairs B");
  });

  it("GET /api/member/schedule lists only the member's own club's classes, each with its own club's mat id", async () => {
    const res = await scheduleGET(new Request("https://test.local/api/member/schedule"));
    expect(res.status).toBe(200);
    const text = await res.text();
    const rows = JSON.parse(text) as { name: string; matId: string | null }[];
    expect(rows.map((r) => r.name).sort()).toEqual(["A class on Mat 1", "A class on Mat 2"]);
    expect(rows.every((r) => r.matId !== null && ids.matsA.includes(r.matId))).toBe(true);
    for (const id of ids.matsB) expect(text).not.toContain(id);
    expect(text).not.toContain("B class");
  });
});
