// @vitest-environment jsdom
//
// Round 11 (baseline 3.2): the staff profile's conflict refusal said "Reload to see their
// changes, then make yours again", and the reload threw away what was typed. Reload now keeps
// only the fields this person changed (sessionStorage, this tab), and after the reload puts them
// back on top of the fresh record: the other person's edits to other fields survive; where both
// changed the same field, the note says what theirs was.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor, cleanup } from "@testing-library/react";
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
let store: Map<string, string>;
let setItemThrows = false;
const realFetch = globalThis.fetch;
const realLocation = Object.getOwnPropertyDescriptor(window, "location");
const realSession = Object.getOwnPropertyDescriptor(window, "sessionStorage");

beforeEach(() => {
  patches = [];
  store = new Map();
  setItemThrows = false;
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { if (setItemThrows) throw new Error("QuotaExceededError"); store.set(k, v); },
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/members/${MEMBER.id}` && init?.method === "PATCH") { patches.push(init); return patchReply(); }
    if (url.includes("/payments")) return json({ payments: [] });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  if (realLocation) Object.defineProperty(window, "location", realLocation);
  if (realSession) Object.defineProperty(window, "sessionStorage", realSession);
});

const renderProfile = async (member: MemberDetail = MEMBER) => {
  render(<MemberProfile member={member} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
  await act(async () => {});
};
const draft = (d: Record<string, unknown>) => store.set(KEY, JSON.stringify({ attribution: null, attributionOpened: null, at: Date.now(), ...d }));
const note = () => screen.getByTestId("profile-draft-restored").textContent;

async function editNameAndHitConflict(newName = "Sam Carter-Jones") {
  patchReply = () => json({ error: "This member was updated by someone else.", currentUpdatedAt: THEIRS_AT }, 409);
  fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  fireEvent.change(screen.getByDisplayValue("Sam Carter"), { target: { value: newName } });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  return screen.findByRole("alert");
}

describe("staff profile: a conflict reload keeps what was typed (Round 11, 3.2)", () => {
  it("Reload keeps only the changed field (with its opened value), then reloads", async () => {
    await renderProfile();
    expect((await editNameAndHitConflict()).textContent).toContain("what you've changed here is kept");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    const kept = JSON.parse(store.get(KEY)!);
    expect(kept.form).toEqual({ name: "Sam Carter-Jones" });
    expect(kept.opened).toEqual({ name: "Sam Carter" });
    expect(kept.attribution).toBeNull();
  });

  it("after the reload: their phone change stays, my name change is put back, and the save carries their version", async () => {
    draft({ form: { name: "Sam Carter-Jones" }, opened: { name: "Sam Carter" } });
    patchReply = () => json({ ...MEMBER, updatedAt: "2026-09-30T09:06:00.000Z" });
    await renderProfile({ ...MEMBER, phone: "07700 900123", updatedAt: THEIRS_AT });
    await act(async () => {});
    expect((screen.getByLabelText("Full Name") as HTMLInputElement).value).toBe("Sam Carter-Jones");
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("07700 900123");
    expect(note()).toBe("Their changes are loaded. Your name change is kept below — check and save.");
    expect(store.has(KEY)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(JSON.parse(String(patches[0].body))).toMatchObject({ name: "Sam Carter-Jones", phone: "07700 900123", updatedAt: THEIRS_AT });
  });

  it("when both changed the same field, the note says what theirs was", async () => {
    draft({ form: { phone: "07111 111111" }, opened: { phone: "" } });
    await renderProfile({ ...MEMBER, phone: "07999 999999", updatedAt: THEIRS_AT });
    await act(async () => {});
    expect((screen.getByLabelText("Phone") as HTMLInputElement).value).toBe("07111 111111");
    expect(note()).toBe("Their changes are loaded. Your phone change is kept below — check and save. You both changed phone (they set “07999 999999”); yours is in the form.");
  });

  it("my trial-runner change does not undo their sign-up credit", async () => {
    draft({ form: {}, opened: {}, attribution: { trialRunById: "staff_2" }, attributionOpened: { trialRunById: "" } });
    patchReply = () => json({ ...MEMBER, updatedAt: "2026-09-30T09:06:00.000Z" });
    await renderProfile({ ...MEMBER, creditedToLabel: "Friend of Sean", updatedAt: THEIRS_AT });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(JSON.parse(String(patches[0].body))).toMatchObject({ trialRunById: "staff_2", creditedToLabel: "Friend of Sean" });
  });

  it("if this browser will not keep the input, it does not reload and says so", async () => {
    setItemThrows = true;
    await renderProfile();
    await editNameAndHitConflict();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Note your changes");
    expect((screen.getByLabelText("Full Name") as HTMLInputElement).value).toBe("Sam Carter-Jones");
  });

  it("a draft for another member, or older than 30 minutes, is not applied", async () => {
    store.set("matflow:draft:member:mem_2", JSON.stringify({ form: { name: "Other" }, opened: { name: "x" }, attribution: null, attributionOpened: null, at: Date.now() }));
    draft({ form: { name: "Old Draft" }, opened: { name: "Sam Carter" }, at: Date.now() - 31 * 60 * 1000 });
    await renderProfile();
    expect(screen.queryByDisplayValue("Other")).toBeNull();
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
