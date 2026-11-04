import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/classes/route";
import { PATCH, STALE_SCHEDULES_REFUSAL } from "@/app/api/classes/[id]/route";

// P6 (lost update): PATCH used to take the submitted schedule list as the whole
// truth, so a tab that never saw a day added elsewhere deactivated it on any
// save. The form now sends the slot ids it loaded with (`baseScheduleIds`) and
// the server refuses with 409 when they no longer match; a client that sends
// no base keeps the old behaviour.
const slot = (dayOfWeek: number, startTime = "18:00", endTime = "19:00") => ({ dayOfWeek, startTime, endTime });
const request = (path: string, method = "GET", body?: unknown) => new Request(`https://test.local${path}`, {
  method, headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const patch = (id: string, body: unknown, query = "") => PATCH(request(`/api/classes/${id}${query}`, "PATCH", body), { params: Promise.resolve({ id }) });

describe.skipIf(!process.env.TEST_DATABASE_URL)("P6 — a stale tab cannot delete a day it never saw", () => {
  let tenantId: string;
  beforeAll(async () => {
    const tenant = await withRlsBypass(tx => tx.tenant.create({ data: {
      name: "Synthetic lost-update regression", slug: `mfv-p6-${randomUUID()}`, timezone: "Europe/London",
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
  const activeSlots = (id: string) => withTenantContext(tenantId, tx => tx.classSchedule.findMany({
    where: { classId: id, class: { tenantId }, isActive: true }, orderBy: { dayOfWeek: "asc" }, select: { id: true, dayOfWeek: true },
  }));
  const className = (id: string) => withTenantContext(tenantId, tx => tx.class.findFirst({ where: { id, tenantId }, select: { name: true } }));

  it("tab A saves a rename with Monday only after tab B added Tuesday: refused, Tuesday kept, name unchanged; a fresh base saves", async () => {
    const created = await (await POST(request("/api/classes", "POST", { name: "Gi", duration: 60, schedules: [slot(1)] }))).json();
    const tabA = await activeSlots(created.id); // what tab A loaded: [Mon]

    // Tab B adds Tuesday, with its own (identical, still fresh) base.
    const b = await patch(created.id, { schedules: [slot(1), slot(2)], baseScheduleIds: tabA.map(s => s.id) });
    expect(b.status).toBe(200);
    expect((await activeSlots(created.id)).map(s => s.dayOfWeek)).toEqual([1, 2]);

    // Tab A, unaware, renames and resends only Monday.
    const stale = await patch(created.id, { name: "Gi (renamed)", schedules: [slot(1)], baseScheduleIds: tabA.map(s => s.id) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: STALE_SCHEDULES_REFUSAL, reason: "stale_schedules" });
    expect((await activeSlots(created.id)).map(s => s.dayOfWeek)).toEqual([1, 2]);
    expect((await className(created.id))?.name).toBe("Gi");

    // The dry-run preview is refused the same way, so the owner never gets as far as a confirmation.
    const preview = await patch(created.id, { name: "Gi (renamed)", schedules: [slot(1)], baseScheduleIds: tabA.map(s => s.id) }, "?dryRun=1");
    expect(preview.status).toBe(409);

    // After a reload tab A holds both ids; the same rename, with Tuesday in the list, saves.
    const fresh = await activeSlots(created.id);
    const ok = await patch(created.id, { name: "Gi (renamed)", schedules: [slot(1), slot(2)], baseScheduleIds: fresh.map(s => s.id) });
    expect(ok.status).toBe(200);
    expect((await className(created.id))?.name).toBe("Gi (renamed)");
    expect((await activeSlots(created.id)).map(s => s.dayOfWeek)).toEqual([1, 2]);
  }, 120_000);

  it("a removed day is also a change: a base that still lists it is refused", async () => {
    const created = await (await POST(request("/api/classes", "POST", { name: "No-Gi", duration: 60, schedules: [slot(1), slot(3)] }))).json();
    const base = await activeSlots(created.id);
    const removed = await patch(created.id, { schedules: [slot(1)], baseScheduleIds: base.map(s => s.id) });
    expect(removed.status).toBe(200);
    const stale = await patch(created.id, { schedules: [slot(1), slot(3)], baseScheduleIds: base.map(s => s.id) });
    expect(stale.status).toBe(409);
    expect((await activeSlots(created.id)).map(s => s.dayOfWeek)).toEqual([1]);
  }, 120_000);

  it("a save that does not touch the days ignores the base; a client with no base keeps the old whole-truth behaviour", async () => {
    const created = await (await POST(request("/api/classes", "POST", { name: "Kids", duration: 45, schedules: [slot(1)] }))).json();
    const base = await activeSlots(created.id);
    await patch(created.id, { schedules: [slot(1), slot(2)], baseScheduleIds: base.map(s => s.id) });
    // Rename only — no `schedules` — with the stale base: fine, nothing about the days is claimed.
    const rename = await patch(created.id, { name: "Little Kids", baseScheduleIds: base.map(s => s.id) });
    expect(rename.status).toBe(200);
    expect((await activeSlots(created.id)).map(s => s.dayOfWeek)).toEqual([1, 2]);
    // Legacy client (no base): the list is the truth, as before — documented, not recommended.
    const legacy = await patch(created.id, { schedules: [slot(1)] });
    expect(legacy.status).toBe(200);
    expect((await activeSlots(created.id)).map(s => s.dayOfWeek)).toEqual([1]);
  }, 120_000);
});
