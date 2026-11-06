// /dashboard/attendance?instance=<id> — the server half. The session is looked
// up THROUGH its class's tenant (ClassInstance has no tenantId column), its
// check-ins are read with an explicit tenantId, and a malformed or unknown id
// falls back to the recent list instead of an empty page.
import { describe, it, expect, vi, beforeEach } from "vitest";

// S3: the aggregate statements, answered through the faked Prisma delegates (see the support file).
vi.mock("@/lib/aggregate-counts", () => import("./support/aggregate-counts-via-prisma"));

const { tx } = vi.hoisted(() => ({
  tx: {
    attendanceRecord: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    classInstance: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/authz", () => ({
  requireStaff: vi.fn(async () => ({ session: { user: { tenantId: "t1", primaryColor: "#123456" } } })),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
}));
vi.mock("@/components/dashboard/AttendanceView", () => ({ default: () => null }));

import AttendancePage from "@/app/dashboard/attendance/page";

type Props = { records: unknown[]; session?: { id: string; label: string } | null; sessionNotFound?: boolean };
const run = async (params: Record<string, string | string[] | undefined>) =>
  ((await AttendancePage({ searchParams: Promise.resolve(params) })) as { props: Props }).props;

beforeEach(() => {
  vi.clearAllMocks();
  tx.attendanceRecord.findMany.mockResolvedValue([]);
  tx.attendanceRecord.count.mockResolvedValue(0);
  tx.attendanceRecord.groupBy.mockResolvedValue([]);
  tx.classInstance.findFirst.mockResolvedValue(null);
});

describe("AttendancePage ?instance=", () => {
  it("without the param reads the recent list and looks no session up", async () => {
    const props = await run({});
    expect(tx.classInstance.findFirst).not.toHaveBeenCalled();
    const arg = tx.attendanceRecord.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: "t1" });
    expect(arg.take).toBe(100);
    expect(props.session ?? null).toBeNull();
    expect(props.sessionNotFound ?? false).toBe(false);
  });

  it("reads that session's check-ins, scoped to the club", async () => {
    tx.classInstance.findFirst.mockResolvedValue({
      id: "inst1",
      date: new Date("2026-11-04T00:00:00.000Z"),
      startTime: "19:00",
      isCancelled: false,
      class: { name: "Advanced No-Gi" },
    });
    const props = await run({ instance: "inst1" });
    expect(tx.classInstance.findFirst.mock.calls[0][0].where).toEqual({ id: "inst1", class: { tenantId: "t1" } });
    const arg = tx.attendanceRecord.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: "t1", classInstanceId: "inst1" });
    expect(arg.take).toBe(1000);
    expect(props.session).toEqual({ id: "inst1", label: "Advanced No-Gi · Wed 4 Nov, 19:00" });
    expect(props.sessionNotFound ?? false).toBe(false);
  });

  it("says when the session was cancelled", async () => {
    tx.classInstance.findFirst.mockResolvedValue({
      id: "inst1",
      date: new Date("2026-11-04T00:00:00.000Z"),
      startTime: "19:00",
      isCancelled: true,
      class: { name: "Advanced No-Gi" },
    });
    const props = await run({ instance: "inst1" });
    expect(props.session?.label).toBe("Advanced No-Gi · Wed 4 Nov, 19:00 (cancelled)");
  });

  it("accepts the readable ids seeded data uses", async () => {
    await run({ instance: "inst-seed-t1-AdvancedNoGi-2026-11-04-19:00" });
    expect(tx.classInstance.findFirst.mock.calls[0][0].where).toEqual({
      id: "inst-seed-t1-AdvancedNoGi-2026-11-04-19:00",
      class: { tenantId: "t1" },
    });
  });

  it("an id that is not this club's session falls back to the recent list and says so", async () => {
    const props = await run({ instance: "someoneelses" });
    expect(tx.classInstance.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.attendanceRecord.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    expect(props.session ?? null).toBeNull();
    expect(props.sessionNotFound).toBe(true);
  });

  it("ignores a malformed param without a lookup", async () => {
    const props = await run({ instance: "x';drop" });
    expect(tx.classInstance.findFirst).not.toHaveBeenCalled();
    expect(props.session ?? null).toBeNull();
    expect(props.sessionNotFound ?? false).toBe(false);
    const repeated = await run({ instance: ["a", "b"] });
    expect(repeated.session ?? null).toBeNull();
  });
});
