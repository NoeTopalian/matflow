// @vitest-environment jsdom
//
// UI-RULES §5.4 / §11: the last nine `window.confirm()` call sites in the app
// became `ConfirmDialog` on 2026-08-19.
//
// `tests/unit/ui-primitives.test.tsx` already proves the PRIMITIVE keeps its
// contract (resolves true/false, never hangs). What it cannot prove is that
// each migrated CALL SITE still gates its action on the answer — and that is
// the only property that matters here, because the failure mode of a bad
// migration is silent: the dialog appears, the user cancels, and the DELETE
// fires anyway. A native `confirm()` blocks the thread, so the old code got
// gating for free; `await ask()` does not, and a dropped `if (!confirmed)
// return;` type-checks perfectly.
//
// So each case asserts the same three things against the network layer:
//   1. clicking the destructive control fires NO request
//   2. cancelling still fires NO request
//   3. confirming fires exactly the request it always did
//
// Mutation-tested: see the header of each describe for what was broken and
// which assertion caught it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

import AdminCheckin from "@/components/dashboard/AdminCheckin";
import TimetableManager from "@/components/dashboard/TimetableManager";
import Topbar from "@/components/layout/Topbar";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const signOutMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
}));
vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/** Every fetch this file makes, as `METHOD url`. */
let calls: string[] = [];

function installFetch() {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (typeof url === "string" && url.includes("/api/settings/kiosk")) {
      return Promise.resolve({ ok: true, json: async () => ({ enabled: false, issuedAt: null }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
  }) as unknown as typeof fetch;
}

/** Requests that actually mutate something, i.e. the ones a confirm gates. */
function mutations() {
  return calls.filter((c) => !c.startsWith("GET "));
}

async function click(name: string | RegExp, role = "button") {
  await act(async () => {
    fireEvent.click(screen.getByRole(role, { name }));
  });
}

beforeEach(installFetch);
afterEach(() => {
  vi.restoreAllMocks();
  signOutMock.mockReset();
});

// ── AdminCheckin: removing a check-in ────────────────────────────────────────
//
// Mutation run (2026-08-19): deleting the `if (!confirmed) return;` guard —
// i.e. awaiting the answer and ignoring it — makes "does not remove the
// check-in until the question is answered" and "cancelling leaves the
// check-in alone" both fail. Replacing `await ask({…})` with `true` fails the
// same two. Both mutants survive the rest of the 861-test suite untouched.

describe("AdminCheckin — removing a check-in still confirms", () => {
  const INSTANCES = [
    {
      id: "inst-1",
      name: "Beginner BJJ",
      coachName: "Coach Mike",
      location: "Mat 1",
      startTime: "10:00",
      endTime: "11:00",
      maxCapacity: 20,
      color: "#3b82f6",
    },
  ];
  const CHECKED_IN = [
    {
      id: "m1",
      name: "Alex Chen",
      membershipType: "Pro",
      rankName: null,
      rankColor: null,
      checkedIn: true,
      profilePictureUrl: null,
    },
  ];

  function renderCheckin(members = CHECKED_IN) {
    render(
      <AdminCheckin
        instances={INSTANCES}
        initialInstanceId="inst-1"
        initialMembers={members}
        primaryColor="#3b82f6"
        role="owner"
        activeClassIds={[]}
      />,
    );
  }

  it("does not remove the check-in until the question is answered", async () => {
    renderCheckin();
    await click(/Alex Chen/);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/no longer be marked as attending/i)).toBeTruthy();
    expect(mutations()).toEqual([]);
  });

  it("cancelling leaves the check-in alone", async () => {
    renderCheckin();
    await click(/Alex Chen/);
    await click("Cancel");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutations()).toEqual([]);
  });

  it("confirming fires the DELETE it always did", async () => {
    renderCheckin();
    await click(/Alex Chen/);
    await click("Remove check-in");

    expect(mutations()).toEqual([
      "DELETE /api/checkin?classInstanceId=inst-1&memberId=m1",
    ]);
  });

  it("checking a member IN is not gated — only the destructive direction asks", async () => {
    renderCheckin([{ ...CHECKED_IN[0], checkedIn: false }]);
    await click(/Alex Chen/);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutations()).toEqual(["POST /api/checkin"]);
  });
});

// ── TimetableManager: archiving a class ──────────────────────────────────────
//
// Mutation run (2026-08-19): dropping `if (!confirmed) return;` fails "does
// not archive until the question is answered" and "cancelling leaves the
// class alone". Note this action is deliberately NOT `destructive` — archiving
// is reversible — so the copy, not the button variant, carries the weight.

describe("TimetableManager — archiving a class still confirms", () => {
  const CLASS: ClassRow = {
    id: "c1",
    name: "Fundamentals",
    coachName: null,
    coachUserId: null,
    coachUser: null,
    location: null,
    duration: 60,
    maxCapacity: null,
    color: null,
    description: null,
    requiredRankId: null,
    requiredRank: null,
    maxRankId: null,
    maxRank: null,
    schedules: [{ id: "c1-s", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  };

  function renderTimetable() {
    render(
      <TimetableManager
        initialClasses={[CLASS]}
        rankSystems={[]}
        coachUsers={[]}
        primaryColor="#3b82f6"
        role="owner"
        currentUserId="u1"
      />,
    );
  }

  it("does not archive until the question is answered", async () => {
    renderTimetable();
    await click("Delete Fundamentals");

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/stop appearing in the timetable/i)).toBeTruthy();
    expect(mutations()).toEqual([]);
  });

  it("cancelling leaves the class alone", async () => {
    renderTimetable();
    await click("Delete Fundamentals");
    await click("Cancel");

    expect(mutations()).toEqual([]);
  });

  it("confirming fires the DELETE it always did", async () => {
    renderTimetable();
    await click("Delete Fundamentals");
    await click("Archive class");

    expect(mutations()).toEqual(["DELETE /api/classes/c1"]);
  });
});

// ── Topbar: sign out from all devices ────────────────────────────────────────
//
// The stakes here are the inverse of the others: an unconfirmed sign-out-all
// does not destroy data, it destroys every other session the owner has open.
// Mutation run (2026-08-19): dropping the guard fails both "does not sign
// out" cases; nothing else in the suite notices.

describe("Topbar — sign out from all devices still confirms", () => {
  const USER = {
    name: "Alex Chen",
    email: "alex@example.com",
    role: "owner",
    tenantName: "Total BJJ",
  };

  async function openMenuAndAsk() {
    render(<Topbar user={USER} />);
    await click("Open account menu");
    await click("Sign out all devices", "menuitem");
  }

  it("does not sign out anywhere until the question is answered", async () => {
    await openMenuAndAsk();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mutations()).toEqual([]);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("cancelling keeps every session signed in", async () => {
    await openMenuAndAsk();
    await click("Cancel");

    expect(mutations()).toEqual([]);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("confirming posts to logout-all and then signs this device out", async () => {
    await openMenuAndAsk();
    await click("Sign out everywhere");

    expect(mutations()).toEqual(["POST /api/auth/logout-all"]);
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
});
