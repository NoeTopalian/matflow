// @vitest-environment jsdom
// Round 12 G-1: staff (owner, manager, admin) can hide a member from the gym leaderboard on the member profile. The
// column, the leaderboard's exclusion, the audit diff and Undo already existed; nothing could set it. The switch shows
// the SAVED value (no optimistic flip), a refused save leaves it as it was, a support session cannot use it, and the
// staff PATCH schema accepts a boolean only.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const toast = vi.fn();
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

import MemberProfile, { type MemberDetail } from "@/components/dashboard/MemberProfile";
import { memberUpdateSchema } from "@/lib/schemas/member";
import { SUPPORT_EDIT_FIELD_POLICY } from "@/lib/support-session";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const MEMBER: MemberDetail = {
  id: "mem_1", name: "Sam Carter", email: "sam@example.test", phone: null, membershipType: null, membershipTierId: null,
  status: "active", paymentStatus: "paid", notes: null, profilePictureUrl: null, joinedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-30T09:00:00.000Z", emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
  medicalConditions: null, dateOfBirth: null, waiverAccepted: true, waiverAcceptedAt: null, subscriptions: [], ranks: [], attendances: [],
  leaderboardOptOut: false,
};
let patches: Array<Record<string, unknown>> = [];
let patchStatus = 200;

async function open(role: string, member: Partial<MemberDetail> = {}) {
  render(<MemberProfile member={{ ...MEMBER, ...member }} rankOptions={[]} primaryColor="#3b82f6" role={role} tenantSlug="t" />);
  await act(async () => {});
}
const sw = () => screen.queryByRole("switch", { name: "Show on the leaderboard" });

beforeEach(() => {
  patches = []; patchStatus = 200; toast.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() } });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/members/mem_1" && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return patchStatus === 200 ? json({ updatedAt: "2026-11-16T08:00:00.000Z" }) : json({ error: "x" }, patchStatus);
    }
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("leaderboard switch on the member profile", () => {
  it("an owner sees it on (shown), and turning it off saves leaderboardOptOut: true with the row version", async () => {
    await open("owner");
    expect(sw()).toBeTruthy();
    expect(sw()!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw()!);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ leaderboardOptOut: true, updatedAt: "2026-09-30T09:00:00.000Z" });
    await waitFor(() => expect(sw()!.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText(/Hidden: this member's name and count are left off/)).toBeTruthy();
  });

  it("a refused save leaves the switch as it was and says nothing changed", async () => {
    patchStatus = 500;
    await open("manager");
    fireEvent.click(sw()!);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(sw()!.getAttribute("aria-checked")).toBe("true");
    expect(String(toast.mock.calls[0][0])).toMatch(/Nothing changed/);
  });

  it("a 409 tells the person to reload instead of overwriting another edit", async () => {
    patchStatus = 409;
    await open("admin", { leaderboardOptOut: true });
    expect(sw()!.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw()!);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(String(toast.mock.calls[0][0])).toMatch(/Reload the page/);
    expect(sw()!.getAttribute("aria-checked")).toBe("false");
  });

  it("a coach does not get the switch (the member PATCH route refuses coaches)", async () => {
    await open("coach");
    expect(sw()).toBeNull();
  });

  it("an archived member's switch is disabled (an archived record is read-only)", async () => {
    await open("owner", { archivedAt: "2026-11-01T00:00:00.000Z" });
    expect((sw() as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
  });
});

describe("staff PATCH schema and support policy", () => {
  it("accepts a boolean leaderboardOptOut and refuses anything else", () => {
    expect(memberUpdateSchema.safeParse({ leaderboardOptOut: true }).success).toBe(true);
    expect(memberUpdateSchema.safeParse({ leaderboardOptOut: false }).success).toBe(true);
    expect(memberUpdateSchema.safeParse({ leaderboardOptOut: "yes" }).success).toBe(false);
  });
  it("a MatFlow support edit session still may not set it (not in the member.update allowlist)", () => {
    expect(SUPPORT_EDIT_FIELD_POLICY["member.update"]).not.toContain("leaderboardOptOut");
  });
});
