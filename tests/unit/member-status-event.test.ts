import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  recordStatusEvent,
  recordStatusEventsBulk,
  MEMBER_STATUS_EVENT_REASONS,
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
