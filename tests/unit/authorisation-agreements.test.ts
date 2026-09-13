// Two surfaces governing one capability must not disagree about who may use it.
//
// A sweep of the API found thirteen places where they did. These are the three
// that cost the most, and they fail in two opposite directions — which is why a
// single rule of thumb ("tighten everything") would be the wrong fix:
//
//   * /api/checkin admitted ALL FOUR staff roles with no instructor narrowing,
//     while the manual toggle on the coach register — the same action, one
//     screen over — refuses a coach who is not the instructor. So a coach
//     calling the API directly could check any member into any class.
//
//   * GET /api/settings blocked only `role === "member"`, handing every coach
//     and admin the club's subscriptionStatus, subscriptionTier and member /
//     staff / class counts — through a route whose PATCH half has always been
//     owner-only, and whose sibling settings/kiosk is owner-only on both verbs.
//
//   * GET /api/payments stayed owner-only after the payments PAGE and its
//     outstanding / chase / export siblings were widened to owner + manager. A
//     manager opened the hub and watched its own main table 403 — which reads
//     as "this club has no payments", not "you may not see this". That drift
//     was introduced by this project, which is the argument for asserting the
//     agreements rather than remembering them.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));

const { authMock, memberFindFirstMock, instanceFindFirstMock, performCheckinMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  instanceFindFirstMock: vi.fn(),
  performCheckinMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: memberFindFirstMock },
      classInstance: { findFirst: instanceFindFirstMock },
    }),
}));
vi.mock("@/lib/checkin", () => ({
  performCheckin: performCheckinMock,
  restorePackCreditsForAttendance: vi.fn(),
}));

function session(role: string, userId = "user-1") {
  return { user: { id: userId, role, tenantId: "tenant-A", email: "s@x.com" } };
}

function checkinReq() {
  return {
    json: async () => ({ classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }),
    headers: new Headers(),
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  memberFindFirstMock.mockResolvedValue({ id: "mem-1" });
  performCheckinMock.mockResolvedValue({ kind: "ok", attendanceId: "att-1" });
});

describe("check-in: a coach may only mark their own classes", () => {
  it("refuses a coach for a class they do not teach", async () => {
    authMock.mockResolvedValue(session("coach"));
    // The narrowed lookup finds nothing, because the class has another
    // instructor. This is the whole defect: there used to be no such lookup.
    instanceFindFirstMock.mockResolvedValue(null);

    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(checkinReq());

    // 404 rather than 403, matching the coach register — a coach must not be
    // able to probe which classes exist in the club.
    expect(res.status).toBe(404);
    expect(performCheckinMock).not.toHaveBeenCalled();
  });

  it("narrows the lookup by instructorId for a coach", async () => {
    authMock.mockResolvedValue(session("coach", "coach-9"));
    instanceFindFirstMock.mockResolvedValue({ id: "inst-1" });

    const { POST } = await import("@/app/api/checkin/route");
    await POST(checkinReq());

    const where = instanceFindFirstMock.mock.calls[0][0].where as {
      class: { instructorId?: string };
    };
    // Dropping this would make the guard vacuous while still looking present.
    expect(where.class.instructorId).toBe("coach-9");
  });

  it("does NOT narrow for owner, manager or admin", async () => {
    for (const role of ["owner", "manager", "admin"]) {
      vi.clearAllMocks();
      memberFindFirstMock.mockResolvedValue({ id: "mem-1" });
      performCheckinMock.mockResolvedValue({ kind: "ok", attendanceId: "att-1" });
      authMock.mockResolvedValue(session(role));
      instanceFindFirstMock.mockResolvedValue({ id: "inst-1" });

      const { POST } = await import("@/app/api/checkin/route");
      await POST(checkinReq());

      const where = instanceFindFirstMock.mock.calls[0][0].where as {
        class: { instructorId?: string };
      };
      expect(where.class.instructorId, `${role} was narrowed`).toBeUndefined();
    }
  });

  it("still refuses a non-staff caller outright", async () => {
    authMock.mockResolvedValue(session("member"));

    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(checkinReq());
    expect(res.status).toBe(403);
  });
});

// ── the gates two surfaces must agree on ─────────────────────────────────────

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("a page and the API behind it agree", () => {
  it("payments: the hub's own data is readable by everyone the page admits", () => {
    // The page is requireOwnerOrManager. Leaving the API owner-only is how a
    // manager gets a screen that 403s its own contents.
    expect(code("app/dashboard/payments/page.tsx")).toContain("requireOwnerOrManager(");
    for (const route of [
      "app/api/payments/route.ts",
      "app/api/payments/outstanding/route.ts",
      "app/api/payments/chase/route.ts",
      "app/api/payments/export.csv/route.ts",
    ]) {
      const src = code(route);
      // The CALL, not merely the name — an unchanged import line would satisfy
      // a `toContain("requireApiOwnerOrManager")` while the call underneath had
      // been narrowed back to owner-only. That is the vacuous shape these
      // tests exist to catch, and it caught itself here.
      expect(src, `${route} drifted`).toContain("requireApiOwnerOrManager()");
      expect(src, `${route} still gates on owner alone`).not.toMatch(/await requireApiOwner\(\)/);
    }
  });

  it("settings: reading the club's commercial state is owner-only, like writing it", () => {
    const settings = code("app/api/settings/route.ts");
    expect(settings).toContain("requireApiOwner()");
    // The old shape. A role-string comparison here is how "everyone but a
    // member" came to mean "every coach in the club".
    expect(settings).not.toMatch(/role\s*===\s*"member"/);
  });

  it("check-in: the API narrows a coach, as the sibling register does", () => {
    const checkin = code("app/api/checkin/route.ts");
    expect(checkin).toContain("instructorId");
    // Both files must express the same rule, so a change to one is visible as a
    // difference from the other.
    expect(code("app/api/coach/instances/[id]/attendance/route.ts")).toContain("instructorId");
  });
});

describe("the second-factor and lockout pair", () => {
  it("both are owner + manager, because together they are one attack", () => {
    // Clearing a brute-force lockout and stripping a second factor are the two
    // halves of the same thing: whoever can do both gets unlimited password
    // guesses against a member with no second factor behind them. The lockout
    // exists to cap those guesses; letting the same people clear it hands the
    // cap back. Both admitted all four staff roles.
    for (const file of [
      "app/api/members/[id]/totp-reset/route.ts",
      "app/api/members/[id]/unlock/route.ts",
    ]) {
      const src = code(file);
      expect(src, `${file} is not senior-gated`).toContain("requireApiOwnerOrManager()");
      expect(src, `${file} still admits every staff role`).not.toMatch(/requireApiStaff\(\)/);
      expect(src, `${file} still hand-rolls a staff list`).not.toMatch(/STAFF_ROLES\.includes/);
    }
  });

  it("the page hides the reset it can no longer perform", () => {
    // This page is requireStaff(). Narrowing the API alone would leave a coach
    // looking at a button that 403s — the defect class this branch removes.
    const page = code("app/dashboard/members/[id]/page.tsx");
    expect(page).toContain("canResetTotp");
    expect(page).toMatch(/totpEnabled\s*&&\s*canResetTotp/);
  });
});

describe("promote and demote are symmetric", () => {
  it("neither can award a belt the other cannot take back", () => {
    // They were DISJOINT: promote was ["owner","manager","coach"] and demote
    // ["owner","manager","admin"]. So a coach could award a belt and not undo
    // their own mistake, and an admin could remove one they could never give.
    // Whichever list is right, both cannot be.
    const promote = code("app/api/members/[id]/rank/route.ts");
    const demote = code("app/api/members/[id]/rank/demote/route.ts");
    for (const [name, src] of [["promote", promote], ["demote", demote]] as const) {
      expect(src, `${name} still hard-codes a role list`).not.toMatch(/\["owner",\s*"manager",\s*"(coach|admin)"\]/);
      expect(src, `${name} does not use the shared constant`).toContain("STAFF_ROLES.includes");
    }
  });
});

describe("a finding that did not survive re-derivation", () => {
  it("revenue/summary being owner-only is correct, not drift", () => {
    // The audit claimed a manager could generate a report whose revenue figure
    // 403s inside it, because reports/generate is owner+manager while
    // revenue/summary is owner-only. Checked: revenue/summary has exactly one
    // caller, SettingsPage, which is rendered by /dashboard/settings —
    // requireRole(["owner"]). The reports page never calls it. The two gates
    // differ because the two surfaces differ.
    //
    // Recorded as a test rather than deleted, so nobody "fixes" it later by
    // widening a money endpoint to match a page it has nothing to do with.
    expect(code("app/api/revenue/summary/route.ts")).toContain("requireApiOwner()");
    expect(code("app/dashboard/reports/page.tsx")).not.toContain("revenue/summary");
  });
});