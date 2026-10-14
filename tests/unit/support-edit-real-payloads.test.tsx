// @vitest-environment jsdom
/**
 * REAL component payloads under a support edit session (functional re-review,
 * 14 Oct 2026). The field-policy route tests post hand-built bodies, which is
 * how two UI dead-ends got through: the member Save and Add member forms sent
 * owner-only keys the server now refuses, and rank award always sent
 * photoUrl: "". These tests render the actual components, submit them, and pin
 * the exact keys each fetch body carries — in an edit session they must be a
 * subset of SUPPORT_EDIT_FIELD_POLICY, and for an owner they must keep the
 * historical whole-form shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: "t-club" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MemberProfile, { type MemberDetail, type RankOption } from "@/components/dashboard/MemberProfile";
import MembersList, { type MemberRow } from "@/components/dashboard/MembersList";
import { SUPPORT_EDIT_FIELD_POLICY } from "@/lib/support-session";

const member: MemberDetail = {
  id: "m-1",
  name: "Milo Member",
  email: "milo@example.test",
  phone: "+447700900000",
  membershipType: null,
  membershipTierId: null,
  status: "active",
  paymentStatus: "paid",
  notes: null,
  profilePictureUrl: null,
  joinedAt: new Date("2026-01-01").toISOString(),
  updatedAt: new Date("2026-01-02").toISOString(),
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  medicalConditions: null,
  dateOfBirth: null,
  waiverAccepted: true,
  waiverAcceptedAt: null,
  subscriptions: [],
  ranks: [],
  attendances: [],
} as unknown as MemberDetail;

const rankOptions: RankOption[] = [
  { id: "r-blue", discipline: "BJJ", name: "Blue", color: "#0000aa", order: 1 },
];

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const calls: Call[] = [];

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = null; } }
    calls.push({ url: u, method, body });
    if (u.includes("/api/memberships")) {
      return new Response(JSON.stringify({ tiers: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/rank")) {
      return new Response(JSON.stringify({ id: "mr-1", rankSystemId: "r-blue", stripes: 0, achievedAt: new Date("2026-01-03").toISOString(), rankSystem: { discipline: "BJJ", name: "Blue", color: "#0000aa" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, id: "m-new", updatedAt: new Date("2026-01-03").toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

beforeEach(() => { calls.length = 0; stubFetch(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const patchCall = () => calls.find((c) => c.method === "PATCH" && c.url.includes("/api/members/m-1"));

describe("MemberProfile Save — the real form payload", () => {
  it("edit session: body keys are a subset of the member.update policy", async () => {
    render(<MemberProfile member={member} rankOptions={rankOptions} primaryColor="#112233" role="owner" tenantSlug="club" supportScope="edit" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(patchCall()).toBeTruthy());
    const keys = Object.keys(patchCall()!.body!);
    const allowed = SUPPORT_EDIT_FIELD_POLICY["member.update"] as readonly string[];
    expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("status");
  });

  it("owner session: the historical whole-form payload is unchanged", async () => {
    render(<MemberProfile member={member} rankOptions={rankOptions} primaryColor="#112233" role="owner" tenantSlug="club" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(patchCall()).toBeTruthy());
    const keys = Object.keys(patchCall()!.body!);
    for (const k of ["name", "email", "status", "creditedToUserId"]) expect(keys).toContain(k);
  });
});

describe("Rank award — the real drawer payload", () => {
  async function award(scope: "edit" | null) {
    render(<MemberProfile member={member} rankOptions={rankOptions} primaryColor="#112233" role="owner" tenantSlug="club" supportScope={scope} />);
    fireEvent.click(screen.getByRole("tab", { name: /Ranks/ }));
    fireEvent.click(screen.getByRole("button", { name: /Assign \/ Promote/ }));
    fireEvent.change(screen.getByLabelText("Discipline"), { target: { value: "BJJ" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm promotion/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("/rank"))).toBe(true));
    return calls.find((c) => c.method === "POST" && c.url.includes("/rank"))!;
  }

  it("never sends an empty photoUrl, so an edit-session promotion passes the policy", async () => {
    const call = await award("edit");
    const keys = Object.keys(call.body!);
    expect(keys).not.toContain("photoUrl");
    const allowed = SUPPORT_EDIT_FIELD_POLICY["member.rank.award"] as readonly string[];
    expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it("owner award without a chosen photo also omits the empty key", async () => {
    const call = await award(null);
    expect(Object.keys(call.body!)).not.toContain("photoUrl");
  });
});

describe("Add member — the real modal payload", () => {
  const rows: MemberRow[] = [];

  async function add(scope: "edit" | null) {
    render(<MembersList members={rows} primaryColor="#112233" role="owner" supportScope={scope} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Add member/i })[0]);
    fireEvent.change(await screen.findByLabelText("Full Name"), { target: { value: "New Person" } });
    const submits = screen.getAllByRole("button", { name: /Add member/i });
    fireEvent.click(submits[submits.length - 1]); // the modal's submit is rendered last
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/members"))).toBe(true));
    return calls.find((c) => c.method === "POST" && c.url.endsWith("/api/members"))!;
  }

  it("edit session: no status, membership or attribution keys; subset of member.create", async () => {
    const call = await add("edit");
    const keys = Object.keys(call.body!);
    const allowed = SUPPORT_EDIT_FIELD_POLICY["member.create"] as readonly string[];
    expect(keys.filter((k) => !allowed.includes(k))).toEqual([]);
    expect(keys).not.toContain("status");
    expect(keys).not.toContain("membershipTierId");
  });

  it("owner session: status still sent (historical shape)", async () => {
    const call = await add(null);
    expect(Object.keys(call.body!)).toContain("status");
  });
});
