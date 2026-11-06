/**
 * GET /api/member/timetable (plan §5.6): the split in effect and the club's
 * mats, for the members' day. Pins: signed out is 401; only the caller's own
 * club is read; nothing is cached; the demo club is by time without touching
 * the database; the layout is the club's saved choice, else worked out from
 * the mats in use (lib/timetable-layout.ts); a failure says so and is not
 * cached.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { session, store, tenantsRead } = vi.hoisted(() => ({
  session: { value: null as null | { user: { tenantId: string } } },
  store: { mats: {} as Record<string, { id: string; name: string; sortOrder: number }[]>, stored: {} as Record<string, string | null>, inUse: {} as Record<string, number>, fail: false },
  tenantsRead: [] as string[],
}));

vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.value) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (tenantId: string, fn: (tx: unknown) => unknown) => {
    tenantsRead.push(tenantId);
    if (store.fail) throw new Error("connection reset");
    return fn({ tenantId });
  },
}));
vi.mock("@/lib/mats-store", async () => {
  const { effectiveLayout } = await import("@/lib/timetable-layout");
  return {
    listMats: async (_tx: unknown, tenantId: string) => store.mats[tenantId] ?? [],
    readLayout: async (_tx: unknown, tenantId: string) => {
      const stored = (store.stored[tenantId] ?? null) as "mat" | "time" | null;
      return { stored, effective: effectiveLayout(stored, store.inUse[tenantId] ?? 0) };
    },
  };
});

import { GET } from "@/app/api/member/timetable/route";

beforeEach(() => {
  session.value = { user: { tenantId: "club-a" } };
  store.mats = {
    "club-a": [{ id: "a1", name: "Mat 1", sortOrder: 0 }, { id: "a2", name: "Mat 2", sortOrder: 1 }],
    "club-b": [{ id: "b1", name: "Cage", sortOrder: 0 }],
  };
  store.stored = {};
  store.inUse = { "club-a": 2, "club-b": 1 };
  store.fail = false;
  tenantsRead.length = 0;
});

describe("GET /api/member/timetable", () => {
  it("signed out: 401, nothing read", async () => {
    session.value = null;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(tenantsRead).toEqual([]);
  });

  it("returns the caller's own club's mats in order, ids and names only, and is never cached", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.mats).toEqual([{ id: "a1", name: "Mat 1" }, { id: "a2", name: "Mat 2" }]);
    expect(tenantsRead).toEqual(["club-a"]);
    expect(JSON.stringify(body)).not.toContain("Cage");
  });

  it("nothing saved and two mats in use: by mat", async () => {
    expect((await (await GET()).json()).layout).toBe("mat");
  });

  it("nothing saved and one mat in use: by time", async () => {
    store.inUse["club-a"] = 1;
    expect((await (await GET()).json()).layout).toBe("time");
  });

  it("saved 'mat' with no mat in use: by time", async () => {
    store.stored["club-a"] = "mat";
    store.inUse["club-a"] = 0;
    expect((await (await GET()).json()).layout).toBe("time");
  });

  it("saved 'time' beats two mats in use", async () => {
    store.stored["club-a"] = "time";
    expect((await (await GET()).json()).layout).toBe("time");
  });

  it("the demo club is by time with no mats, and the database is not touched", async () => {
    session.value = { user: { tenantId: "demo-tenant" } };
    const res = await GET();
    expect(await res.json()).toEqual({ layout: "time", mats: [] });
    expect(tenantsRead).toEqual([]);
  });

  it("a failed read is a 500 with a sentence, not cached", async () => {
    store.fail = true;
    const res = await GET();
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await res.json()).error).toBe("Couldn't load the timetable layout.");
  });
});
