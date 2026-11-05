import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { POST, GET } from "@/app/api/classes/route";
import { PATCH } from "@/app/api/classes/[id]/route";
import { GET as memberSchedule } from "@/app/api/member/schedule/route";

const slot = (dayOfWeek: number, startTime = "18:00", endTime = "19:00") => ({ dayOfWeek, startTime, endTime });
const request = (path: string, method = "GET", body?: unknown) => new Request(`https://test.local${path}`, {
  method, headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
// Sean (Total BJJ) set Gi on Monday and Tuesday and saw one. This pins the
// server half: both create paths store and serve both days, sessions land on
// the club's own weekdays (a zone far from UTC included), and editing Tuesday
// keeps Monday. The display half is tests/unit/timetable-snapshot.test.tsx.
describe.skipIf(!process.env.TEST_DATABASE_URL)("Gi Monday/Tuesday persistence", () => {
describe.each(["Europe/London", "Pacific/Auckland"])("club zone %s", (timezone) => {
  let tenantId: string;
  beforeAll(async () => {
    const tenant = await withRlsBypass(tx => tx.tenant.create({ data: {
      name: "Synthetic Gi regression", slug: `mfv-gi-${randomUUID()}`, timezone,
    } }));
    tenantId = tenant.id;
    vi.mocked(auth).mockResolvedValue({ user: { id: "synthetic-owner", role: "owner", tenantId } } as never);
  });
  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async tx => {
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });
  async function create(days: number[]) {
    const response = await POST(request("/api/classes", "POST", { name: "Gi", duration: 60, schedules: days.map(day => slot(day)) }));
    expect(response.status).toBe(201);
    return response.json();
  }
  async function assertPersisted(id: string, days: number[]) {
    const rows = await withTenantContext(tenantId, tx => tx.classSchedule.findMany({
      where: { classId: id, class: { tenantId }, isActive: true }, orderBy: { dayOfWeek: "asc" },
    }));
    expect(rows.map(s => s.dayOfWeek)).toEqual(days);
    const instances = await withTenantContext(tenantId, tx => tx.classInstance.findMany({ where: { classId: id, class: { tenantId } } }));
    expect([...new Set(instances.map(i => i.date.getUTCDay()))].sort()).toEqual(days);
    expect(instances).toHaveLength(days.length * 8);
    const fetched = await (await GET(request("/api/classes"))).json();
    expect(fetched.find((c: { id: string }) => c.id === id).schedules.map((s: { dayOfWeek: number }) => s.dayOfWeek)).toEqual(days);
    const member = await (await memberSchedule(request("/api/member/schedule"))).json();
    expect(member.filter((c: { classId: string }) => c.classId === id).map((s: { dayOfWeek: number }) => s.dayOfWeek).sort()).toEqual(days);
  }
  it("persists both slots and sessions; editing Tuesday preserves Monday", async () => {
    const cls = await create([1, 2]);
    await assertPersisted(cls.id, [1, 2]);
    const response = await PATCH(request(`/api/classes/${cls.id}`, "PATCH", {
      schedules: [slot(1), slot(2, "19:00", "20:00")],
    }), { params: Promise.resolve({ id: cls.id }) });
    expect(response.status).toBe(200);
    await assertPersisted(cls.id, [1, 2]);
    const data = await response.json();
    expect(data.schedules.find((s: { dayOfWeek: number }) => s.dayOfWeek === 1)).toMatchObject(slot(1));
    expect(data.schedules.find((s: { dayOfWeek: number }) => s.dayOfWeek === 2)).toMatchObject(slot(2, "19:00", "20:00"));
  });
  it("persists two independent Gi classes and keeps Monday when Tuesday changes", async () => {
    const monday = await create([1]);
    const tuesday = await create([2]);
    expect(monday.id).not.toBe(tuesday.id);
    await assertPersisted(monday.id, [1]);
    await assertPersisted(tuesday.id, [2]);
    const response = await PATCH(request(`/api/classes/${tuesday.id}`, "PATCH", { schedules: [slot(2, "19:00", "20:00")] }), { params: Promise.resolve({ id: tuesday.id }) });
    expect(response.status).toBe(200);
    await assertPersisted(monday.id, [1]);
    await assertPersisted(tuesday.id, [2]);
  }, 120_000);
});
});
