import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * T8a acceptance 3 — the attribution epoch effect of the new status events.
 *
 * The epoch (lib/attribution.ts) is the earliest NON-import status event that
 * touches a taster (from taster, or to taster/active), folded with the earliest
 * attributed trial's joinedAt. T8a adds two writers whose events can qualify:
 *   - a guardian's child-create in the portal (none -> active, self_signup);
 *   - the DSAR erase of a taster (taster -> cancelled, staff_edit).
 * On a club whose only events are imports (Total BJJ today), either can become
 * the first qualifying event and so START the epoch. That is the documented
 * rule applied as written, and it is pinned here so a change to it is a
 * decision, not an accident. A child-create is never a trial conversion: a new
 * child has no trialRunById, so it never enters a coach's row.
 */

type Ev = { tenantId: string; memberId: string; fromStatus: string | null; toStatus: string; reason: string; occurredAt: Date };
type Mem = { id: string; tenantId: string; trialRunById: string | null; creditedToUserId: string | null; status: string; joinedAt: Date };

const state = vi.hoisted(() => ({ events: [] as Ev[], members: [] as Mem[] }));

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as { not?: unknown; in?: unknown[] };
    if ("not" in c) return c.not === null ? value !== null : value !== c.not;
    if ("in" in c) return c.in!.includes(value);
  }
  return value === cond;
}

function whereMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => whereMatches(row, w));
    return fieldMatches(row[k], v);
  });
}

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      user: { findMany: async () => [{ id: "coach", name: "Coach" }] },
      member: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          state.members.filter((m) => whereMatches(m as unknown as Record<string, unknown>, where)),
      },
      memberStatusEvent: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          state.events.filter((e) => whereMatches(e as unknown as Record<string, unknown>, where)),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          state.events
            .filter((e) => whereMatches(e as unknown as Record<string, unknown>, where))
            .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0] ?? null,
      },
    }),
}));

import { getAttributionData } from "@/lib/attribution";

const IMPORT_DAY = new Date("2026-10-03T11:39:57Z");

beforeEach(() => {
  state.members = [
    { id: "imported", tenantId: "t1", trialRunById: null, creditedToUserId: null, status: "active", joinedAt: new Date("2025-01-01T00:00:00Z") },
  ];
  state.events = [
    { tenantId: "t1", memberId: "imported", fromStatus: null, toStatus: "active", reason: "import", occurredAt: IMPORT_DAY },
  ];
});

describe("attribution epoch after T8a's new events", () => {
  it("a club whose only events are imports has no epoch", async () => {
    const data = await getAttributionData("t1");
    expect(data.epochStart).toBeNull();
  });

  it("a guardian's child-create (self_signup, none -> active) starts the epoch, and is not a conversion", async () => {
    const childDay = new Date("2026-10-20T09:00:00Z");
    state.members.push({ id: "kid", tenantId: "t1", trialRunById: null, creditedToUserId: null, status: "active", joinedAt: childDay });
    state.events.push({ tenantId: "t1", memberId: "kid", fromStatus: null, toStatus: "active", reason: "self_signup", occurredAt: childDay });

    const data = await getAttributionData("t1");
    expect(data.epochStart).toBe(childDay.toISOString());
    // No trialRunById: nobody's trial, so no coach row and no conversion.
    expect(data.rows).toEqual([]);
    expect(data.overall.trials).toBe(0);
    expect(data.overall.converted).toBe(0);
  });

  it("the DSAR erase of a taster (staff_edit, taster -> cancelled) starts the epoch", async () => {
    const eraseDay = new Date("2026-10-21T15:00:00Z");
    state.members.push({ id: "taster", tenantId: "t1", trialRunById: null, creditedToUserId: null, status: "cancelled", joinedAt: new Date("2026-10-10T00:00:00Z") });
    state.events.push({ tenantId: "t1", memberId: "taster", fromStatus: "taster", toStatus: "cancelled", reason: "staff_edit", occurredAt: eraseDay });

    const data = await getAttributionData("t1");
    expect(data.epochStart).toBe(eraseDay.toISOString());
  });

  it("the erase of an active member (active -> cancelled) does not touch the epoch", async () => {
    state.events.push({ tenantId: "t1", memberId: "imported", fromStatus: "active", toStatus: "cancelled", reason: "staff_edit", occurredAt: new Date("2026-10-21T15:00:00Z") });
    const data = await getAttributionData("t1");
    expect(data.epochStart).toBeNull();
  });
});
