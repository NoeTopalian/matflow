// @vitest-environment jsdom
//
// Round 11 (baseline 3.2): the staff profile's conflict refusal said "Reload to see their
// changes, then make yours again", and the reload threw away what was typed. Reload now keeps
// only the fields this person changed (sessionStorage, this tab), and after the reload puts them
// back on top of the fresh record: the other person's edits to other fields survive.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MemberProfile, { type MemberDetail } from "@/components/dashboard/MemberProfile";

const KEY = "matflow:draft:member:mem_1";
const OPENED_AT = "2026-09-30T09:00:00.000Z";
const THEIRS_AT = "2026-09-30T09:03:00.000Z";
const MEMBER: MemberDetail = {
  id: "mem_1", name: "Sam Carter", email: "sam@example.com", phone: null, membershipType: null, membershipTierId: null,
  status: "active", paymentStatus: "paid", notes: null, profilePictureUrl: null, joinedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: OPENED_AT, emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
  medicalConditions: null, dateOfBirth: null, waiverAccepted: true, waiverAcceptedAt: null, subscriptions: [], ranks: [], attendances: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let patches: RequestInit[] = [];
let patchReply: () => Response;
let reload: ReturnType<typeof vi.fn>;
const store = new Map<string, string>();

beforeEach(() => {
  patches = [];
  store.clear();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: { ...storage, getItem: () => null, setItem: () => {} } });
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/members/${MEMBER.id}` && init?.method === "PATCH") { patches.push(init); return patchReply(); }
    if (url.includes("/payments")) return json({ payments: [] });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

const renderProfile = async (member: MemberDetail = MEMBER) => {
  render(<MemberProfile member={member} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
  await act(async () => {});
};

describe("staff profile: a conflict reload keeps what was typed (Round 11, 3.2)", () => {
  it("Reload keeps only the changed field, then reloads", async () => {
    patchReply = () => json({ error: "This member was updated by someone else.", currentUpdatedAt: THEIRS_AT }, 409);
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.change(screen.getByDisplayValue("Sam Carter"), { target: { value: "Sam Carter-Jones" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("what you've changed here is kept");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    const kept = JSON.parse(store.get(KEY)!);
    expect(kept.form).toEqual({ name: "Sam Carter-Jones" });
    expect(kept.attribution).toBeNull();
  });

  it("after the reload: their phone change stays, my name change is put back, and the save carries their version", async () => {
    store.set(KEY, JSON.stringify({ form: { name: "Sam Carter-Jones" }, attribution: null, at: Date.now() }));
    patchReply = () => json({ ...MEMBER, updatedAt: "2026-09-30T09:06:00.000Z" });
    await renderProfile({ ...MEMBER, phone: "07700 900123", updatedAt: THEIRS_AT });
    await act(async () => {});
    expect((screen.getByLabelText("Full Name") as HTMLInputElement).value).toBe("Sam Carter-Jones");
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("07700 900123");
    expect(screen.getByTestId("profile-draft-restored").textContent).toBe("Their changes are loaded. Your name change is kept below — check and save.");
    expect(store.has(KEY)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    const body = JSON.parse(String(patches[0].body));
    expect(body).toMatchObject({ name: "Sam Carter-Jones", phone: "07700 900123", updatedAt: THEIRS_AT });
  });

  it("a kept draft older than 30 minutes is not offered", async () => {
    store.set(KEY, JSON.stringify({ form: { name: "Old Draft" }, attribution: null, at: Date.now() - 31 * 60 * 1000 }));
    await renderProfile();
    expect(screen.queryByDisplayValue("Old Draft")).toBeNull();
    expect(screen.queryByTestId("profile-draft-restored")).toBeNull();
  });

  it("another 409 (email already in use) has no Reload: reloading would not help", async () => {
    patchReply = () => json({ error: "Email already in use" }, 409);
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });
});
