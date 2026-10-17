import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  recordStatusEvent,
  recordStatusEventsBulk,
  MEMBER_STATUS_EVENT_REASONS,
  MEMBER_STATUS_EVENT_SOURCE_ACTIONS,
  clampOccurredAt,
} from "@/lib/member-status";

// recordStatusEvent is the single writer for the conversion funnel. It takes a
// tx (never opens its own) and must be idempotent-friendly: a no-op transition
// (from === to) writes nothing. We drive it with a fake tx so the invariants
// are proven without a database.

function makeTx() {
  const create = vi.fn(async (_args: { data: Record<string, unknown>; select?: unknown }) => ({ id: "evt-1" }));
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  return {
    tx: { memberStatusEvent: { create, createMany } } as never,
    create,
    createMany,
  };
}

describe("recordStatusEvent (single writer)", () => {
  let harness: ReturnType<typeof makeTx>;
  beforeEach(() => {
    harness = makeTx();
  });

  it("writes exactly one row for a real transition", async () => {
    const result = await recordStatusEvent(harness.tx, {
      tenantId: "t1",
      memberId: "m1",
      fromStatus: "taster",
      toStatus: "active",
      reason: "staff_edit",
      changedById: "u1",
    });

    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create).toHaveBeenCalledWith({
      data: {
        tenantId: "t1",
        memberId: "m1",
        fromStatus: "taster",
        toStatus: "active",
        reason: "staff_edit",
        changedById: "u1",
      },
      select: { id: true },
    });
    expect(result).toEqual({ id: "evt-1" });
  });

  it("writes the create-start event where fromStatus is null", async () => {
    await recordStatusEvent(harness.tx, {
      tenantId: "t1",
      memberId: "m1",
      fromStatus: null,
      toStatus: "taster",
      reason: "staff_edit",
      changedById: "u1",
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create.mock.calls[0][0].data.fromStatus).toBeNull();
  });

  it("is a no-op when fromStatus === toStatus", async () => {
    const result = await recordStatusEvent(harness.tx, {
      tenantId: "t1",
      memberId: "m1",
      fromStatus: "active",
      toStatus: "active",
      reason: "staff_edit",
      changedById: "u1",
    });
    expect(harness.create).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("defaults changedById to null for webhook / import writes", async () => {
    await recordStatusEvent(harness.tx, {
      tenantId: "t1",
      memberId: "m1",
      fromStatus: "active",
      toStatus: "cancelled",
      reason: "stripe_webhook",
    });
    expect(harness.create.mock.calls[0][0].data.changedById).toBeNull();
  });

  it("exposes the four CHECK-constrained reasons", () => {
    expect([...MEMBER_STATUS_EVENT_REASONS]).toEqual([
      "staff_edit",
      "stripe_webhook",
      "import",
      "self_signup",
    ]);
  });
});

describe("recordStatusEventsBulk (importer variant)", () => {
  it("filters out no-op transitions before createMany", async () => {
    const { tx, createMany } = makeTx();
    const count = await recordStatusEventsBulk(tx, [
      { tenantId: "t1", memberId: "m1", fromStatus: null, toStatus: "active", reason: "import" },
      { tenantId: "t1", memberId: "m2", fromStatus: "active", toStatus: "active", reason: "import" },
      { tenantId: "t1", memberId: "m3", fromStatus: "taster", toStatus: "active", reason: "import" },
    ]);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(count).toBe(2);
  });

  it("skips createMany entirely when every row is a no-op", async () => {
    const { tx, createMany } = makeTx();
    const count = await recordStatusEventsBulk(tx, [
      { tenantId: "t1", memberId: "m1", fromStatus: "active", toStatus: "active", reason: "import" },
    ]);
    expect(createMany).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});

// T8a: an optional occurredAt, clamped to [member's latest event, now]. With no
// occurredAt the insert is byte-for-byte what it was (the cases above), and no
// lookup runs.
describe("occurredAt (T8a)", () => {
  function makeDatedTx(latest: Date | null, groups: Array<{ memberId: string; _max: { occurredAt: Date | null } }> = []) {
    const create = vi.fn(async (_args: { data: Record<string, unknown>; select?: unknown }) => ({ id: "evt-1" }));
    const createMany = vi.fn(async (args: { data: Array<Record<string, unknown>> }) => ({ count: args.data.length }));
    const findFirst = vi.fn(async (_args: unknown) => (latest ? { occurredAt: latest } : null));
    const groupBy = vi.fn(async (_args: unknown) => groups);
    return { tx: { memberStatusEvent: { create, createMany, findFirst, groupBy } } as never, create, createMany, findFirst, groupBy };
  }
  const base = { tenantId: "t1", memberId: "m1", fromStatus: "active", toStatus: "cancelled", reason: "import" as const };

  it("passes a supplied date through when it is after the latest event and not in the future", async () => {
    const h = makeDatedTx(new Date("2026-10-03T11:39:57Z"));
    const at = new Date("2026-10-05T00:00:00Z");
    await recordStatusEvent(h.tx, { ...base, occurredAt: at });
    expect(h.findFirst).toHaveBeenCalledTimes(1);
    expect(h.findFirst.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1", memberId: "m1" } });
    expect(h.create.mock.calls[0][0].data.occurredAt).toEqual(at);
  });

  it("clamps a date earlier than the member's latest event up to that event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const latest = new Date("2026-10-10T09:00:00Z");
    const h = makeDatedTx(latest);
    await recordStatusEvent(h.tx, { ...base, occurredAt: new Date("2026-10-05T00:00:00Z") });
    expect(h.create.mock.calls[0][0].data.occurredAt).toEqual(latest);
    // Structured warning: tenant and count only, no personal data.
    expect(warn).toHaveBeenCalledWith("[member-status] supplied occurredAt clamped", { tenantId: "t1", count: 1 });
    warn.mockRestore();
  });

  it("clamps a future date down to now", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeDatedTx(null);
    const before = Date.now();
    await recordStatusEvent(h.tx, { ...base, occurredAt: new Date(Date.now() + 86_400_000) });
    const at = h.create.mock.calls[0][0].data.occurredAt as Date;
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
    warn.mockRestore();
  });

  it("writes nothing and looks nothing up for a no-op transition, date or not", async () => {
    const h = makeDatedTx(null);
    await recordStatusEvent(h.tx, { ...base, toStatus: "active", occurredAt: new Date("2026-10-05T00:00:00Z") });
    expect(h.findFirst).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("bulk: one groupBy for the whole batch, clamps per member, and leaves undated rows alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeDatedTx(null, [
      { memberId: "m1", _max: { occurredAt: new Date("2026-10-10T00:00:00Z") } },
      { memberId: "m2", _max: { occurredAt: new Date("2026-10-01T00:00:00Z") } },
    ]);
    const source = new Date("2026-10-05T00:00:00Z");
    await recordStatusEventsBulk(h.tx, [
      { ...base, memberId: "m1", occurredAt: source },
      { ...base, memberId: "m2", occurredAt: source },
      { ...base, memberId: "m3" },
    ]);
    expect(h.groupBy).toHaveBeenCalledTimes(1);
    expect(h.groupBy.mock.calls[0][0]).toMatchObject({
      by: ["memberId"],
      where: { tenantId: { in: ["t1"] }, memberId: { in: ["m1", "m2"] } },
      _max: { occurredAt: true },
    });
    const rows = h.createMany.mock.calls[0][0].data;
    expect(rows[0].occurredAt).toEqual(new Date("2026-10-10T00:00:00Z"));
    expect(rows[1].occurredAt).toEqual(source);
    expect("occurredAt" in rows[2]).toBe(false);
    expect(warn).toHaveBeenCalledWith("[member-status] supplied occurredAt clamped", { tenantId: "t1", count: 1 });
    warn.mockRestore();
  });

  it("bulk: two dated rows for one member in one batch keep their order (the floor moves with the batch)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeDatedTx(null, [{ memberId: "m1", _max: { occurredAt: new Date("2026-10-01T00:00:00Z") } }]);
    await recordStatusEventsBulk(h.tx, [
      { ...base, fromStatus: "active", toStatus: "inactive", occurredAt: new Date("2026-10-08T00:00:00Z") },
      { ...base, fromStatus: "inactive", toStatus: "cancelled", occurredAt: new Date("2026-10-05T00:00:00Z") },
    ]);
    const rows = h.createMany.mock.calls[0][0].data;
    expect(rows[0].occurredAt).toEqual(new Date("2026-10-08T00:00:00Z"));
    // Clamped up to the first row, not to the pre-batch latest (1 Oct).
    expect(rows[1].occurredAt).toEqual(new Date("2026-10-08T00:00:00Z"));
    expect(warn).toHaveBeenCalledWith("[member-status] supplied occurredAt clamped", { tenantId: "t1", count: 1 });
    warn.mockRestore();
  });

  it("bulk: no lookup at all when no row carries a date", async () => {
    const h = makeDatedTx(null);
    await recordStatusEventsBulk(h.tx, [{ ...base }]);
    expect(h.groupBy).not.toHaveBeenCalled();
    expect("occurredAt" in h.createMany.mock.calls[0][0].data[0]).toBe(false);
  });

  it("clampOccurredAt: an equal date is kept (ties sort on createdAt, then id)", () => {
    const latest = new Date("2026-10-10T00:00:00Z");
    expect(clampOccurredAt(new Date(latest), latest, new Date("2026-10-20T00:00:00Z"))).toEqual(latest);
  });
});

// T8d: provenance. Optional sourceJobId + sourceAction pass straight through on
// import events; absent, the insert is exactly what it was (the cases above,
// whose four-reason assertion is unchanged). Anything else is refused.
describe("provenance (T8d)", () => {
  const imp = { tenantId: "t1", memberId: "m1", fromStatus: "active", toStatus: "cancelled", reason: "import" as const };

  it("exposes the CHECK-constrained source actions (T8d's three, plus T8b's import_backfill)", () => {
    expect([...MEMBER_STATUS_EVENT_SOURCE_ACTIONS]).toEqual(["import_create", "import_refresh", "import_rollback", "import_backfill"]);
  });

  it("single writer: passes both through on an import event", async () => {
    const { tx, create } = makeTx();
    await recordStatusEvent(tx, { ...imp, sourceJobId: "job_1", sourceAction: "import_refresh" });
    expect(create.mock.calls[0][0].data).toMatchObject({ reason: "import", sourceJobId: "job_1", sourceAction: "import_refresh" });
  });

  it("bulk writer: passes both through per row, and leaves them out of rows that carry none", async () => {
    const { tx, createMany } = makeTx();
    await recordStatusEventsBulk(tx, [
      { ...imp, fromStatus: null, toStatus: "active", sourceJobId: "job_c", sourceAction: "import_create" },
      { ...imp, memberId: "m2", sourceJobId: "job_r", sourceAction: "import_rollback" },
      { ...imp, memberId: "m3" },
    ]);
    const rows = createMany.mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ fromStatus: null, sourceJobId: "job_c", sourceAction: "import_create" });
    expect(rows[1]).toMatchObject({ sourceJobId: "job_r", sourceAction: "import_rollback" });
    expect("sourceJobId" in rows[2]).toBe(false);
    expect("sourceAction" in rows[2]).toBe(false);
  });

  it("refuses provenance on a non-import event, half a pair, or an unknown action; nothing is written", async () => {
    const { tx, create, createMany } = makeTx();
    await expect(
      recordStatusEvent(tx, { ...imp, reason: "staff_edit", changedById: "u1", sourceJobId: "job_1", sourceAction: "import_refresh" }),
    ).rejects.toThrow(/import events only/);
    await expect(recordStatusEvent(tx, { ...imp, sourceJobId: "job_1" })).rejects.toThrow(/together/);
    await expect(recordStatusEvent(tx, { ...imp, sourceAction: "import_refresh" })).rejects.toThrow(/together/);
    await expect(recordStatusEvent(tx, { ...imp, sourceJobId: "", sourceAction: "import_refresh" })).rejects.toThrow(/together/);
    await expect(
      recordStatusEventsBulk(tx, [{ ...imp, sourceJobId: "job_1", sourceAction: "import_purge" as never }]),
    ).rejects.toThrow(/unknown sourceAction/);
    // Even a no-op transition is checked: a bad caller is caught on every call.
    await expect(
      recordStatusEventsBulk(tx, [{ ...imp, toStatus: "active", fromStatus: "active", reason: "stripe_webhook", sourceJobId: "j", sourceAction: "import_create" }]),
    ).rejects.toThrow(/import events only/);
    expect(create).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });
});
