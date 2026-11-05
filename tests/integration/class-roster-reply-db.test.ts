import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/classes/route";
import { PATCH } from "@/app/api/classes/[id]/route";

// A squad (roster) class must read back as the squad it is. The create and
// update replies used to carry no roster, so the timetable reopened a
// just-saved squad as open to everyone; and switching a squad back with no
// rank chosen left the squad in force. This pins the server half.
const request = (path: string, method: string, body: unknown) => new Request(`https://test.local${path}`, {
  method, headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
  body: JSON.stringify(body),
});
const slot = { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" };

describe.skipIf(!process.env.TEST_DATABASE_URL)("class roster in the create and update replies", () => {
  let tenantId: string;
  let a: string;
  let b: string;
  let blue: string;
  let ownerId: string;
  beforeAll(async () => {
    const tag = randomUUID().slice(0, 8);
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: "Synthetic roster reply", slug: `mfv-roster-${tag}`, timezone: "Europe/London" } })).id;
      // A real user: roster rows record who added each member (a foreign key).
      ownerId = (await tx.user.create({ data: { tenantId, email: `roster-owner-${tag}@example.test`, name: "Owner", role: "owner", passwordHash: "x" } })).id;
      a = (await tx.member.create({ data: { tenantId, name: "Squad A", email: `roster-a-${tag}@example.test` } })).id;
      b = (await tx.member.create({ data: { tenantId, name: "Squad B", email: `roster-b-${tag}@example.test` } })).id;
      blue = (await tx.rankSystem.create({ data: { tenantId, discipline: "BJJ", name: "Blue", order: 2 } })).id;
    });
    vi.mocked(auth).mockResolvedValue({ user: { id: ownerId, role: "owner", tenantId } } as never);
  });
  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.classRoster.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.rankSystem.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  const rosterRows = (classId: string) =>
    withTenantContext(tenantId, (tx) => tx.classRoster.count({ where: { classId, tenantId } }));
  const patch = async (id: string, body: unknown) => {
    const res = await PATCH(request(`/api/classes/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    return res.json();
  };
  const byId = <T extends { memberId: string }>(r: T[]) => [...r].sort((x, y) => x.memberId.localeCompare(y.memberId));

  it("create replies with the squad it wrote, by name; an open class replies with none", async () => {
    const squad = await POST(request("/api/classes", "POST", { name: "Comp", duration: 60, schedules: [slot], roster: [{ memberId: a }] }));
    expect(squad.status).toBe(201);
    const s = await squad.json();
    expect(s.roster).toEqual([{ memberId: a, name: "Squad A" }]);
    expect(await rosterRows(s.id)).toBe(1);
    const open = await POST(request("/api/classes", "POST", { name: "Open", duration: 60, schedules: [slot] }));
    expect((await open.json()).roster).toEqual([]);
  });

  it("update replies with the squad after the save, including an edit that does not touch it", async () => {
    const created = await (await POST(request("/api/classes", "POST", { name: "Squad", duration: 60, schedules: [slot] }))).json();
    const both = await patch(created.id, { roster: [{ memberId: a }, { memberId: b }] });
    expect(byId(both.roster)).toEqual(byId([{ memberId: a, name: "Squad A" }, { memberId: b, name: "Squad B" }]));
    const renamed = await patch(created.id, { name: "Squad renamed" });
    expect(byId(renamed.roster)).toEqual(byId(both.roster));
    expect(await rosterRows(created.id)).toBe(2);
  });

  it("an empty roster with no rank clears the squad (the form's switch back to open)", async () => {
    const created = await (await POST(request("/api/classes", "POST", { name: "Back", duration: 60, schedules: [slot], roster: [{ memberId: a }] }))).json();
    const cleared = await patch(created.id, { roster: [], requiredRankId: null, maxRankId: null });
    expect(cleared.roster).toEqual([]);
    expect(await rosterRows(created.id)).toBe(0);
  });

  it("choosing a rank clears the squad and keeps the rank (the form omits the roster)", async () => {
    const created = await (await POST(request("/api/classes", "POST", { name: "Ranked", duration: 60, schedules: [slot], roster: [{ memberId: a }] }))).json();
    const ranked = await patch(created.id, { requiredRankId: blue, maxRankId: null });
    expect(ranked.requiredRankId).toBe(blue);
    expect(ranked.roster).toEqual([]);
    expect(await rosterRows(created.id)).toBe(0);
  });
});
