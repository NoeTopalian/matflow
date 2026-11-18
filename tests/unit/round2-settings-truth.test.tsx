// Round 2 (10 Nov 2026): Settings starts from the club's saved branding, Save
// sends only what changed, and a failed plan read is not "No plans yet".
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";

const FIND = { timeout: 20_000 } as const;
let tab = "branding";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`tab=${tab}`),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/settings",
}));

const toasts = vi.hoisted(() => [] as { message: string; type?: string }[]);
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: (message: string, type?: string) => { toasts.push({ message, type }); } }) }));

import { brandingChanges } from "@/components/dashboard/SettingsPage";

const SETTINGS = {
  id: "t-A",
  name: "Total BJJ",
  slug: "totalbjj",
  subscriptionTier: "pro",
  subscriptionStatus: "active",
  primaryColor: "#3b82f6",
  secondaryColor: "#2563eb",
  textColor: "#ffffff",
  bgColor: "#223344",
  fontFamily: "'Montserrat', sans-serif",
  logoUrl: null,
  logoSize: "md",
};

let patches: Record<string, unknown>[] = [];
let plansAnswer: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ plans: [] }) });
let patchAnswer: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

function installFetch() {
  patches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url.includes("/api/settings") && init?.method === "PATCH") {
        patches.push(JSON.parse(init.body ?? "{}"));
        return patchAnswer();
      }
      if (url.includes("/api/stripe/subscription-plans")) return plansAnswer();
      if (url.includes("/api/revenue/summary")) {
        return { ok: true, status: 200, json: async () => ({ mrr: 0, arr: 0, activeMembers: 0, avgPerMember: null, growth: 0, history: [], memberships: [], recent: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

async function renderOwner(extra: Record<string, unknown> = {}) {
  installFetch();
  const mod = await import("@/components/dashboard/SettingsPage");
  render(
    React.createElement(mod.default, {
      settings: SETTINGS, staff: [], statusCounts: {}, primaryColor: "#3b82f6", role: "owner", currentUserId: "u-1", ...extra,
    } as never),
  );
}

beforeEach(() => {
  localStorage.clear();
  plansAnswer = async () => ({ ok: true, status: 200, json: async () => ({ plans: [] }) });
  patchAnswer = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("brandingChanges", () => {
  it("keeps only fields that differ from the saved values", () => {
    const saved = { name: "A", bgColor: "#111111", fontFamily: "x", logoUrl: null };
    expect(brandingChanges(saved, { ...saved })).toEqual({});
    expect(brandingChanges(saved, { ...saved, name: "B" })).toEqual({ name: "B" });
    expect(brandingChanges(saved, { ...saved, logoUrl: "https://l" })).toEqual({ logoUrl: "https://l" });
  });
});

describe("Settings → Branding: the club's saved values win", () => {
  it("a stale browser cache cannot replace the saved background and font, and Save sends only the name", async () => {
    tab = "branding";
    // What another club session left in this browser: different background and font.
    localStorage.setItem("gym-settings", JSON.stringify({ slug: "totalbjj", bgColor: "#000000", fontFamily: "'Bebas Neue', sans-serif", primaryColor: "#ff0000" }));
    await renderOwner();
    const name = (await screen.findByLabelText("Gym Name", {}, FIND)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Total BJJ Kent" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect(patches.length).toBe(1), FIND);
    // Round 4: each changed field carries the value it replaces.
    expect(patches[0]).toEqual({ name: "Total BJJ Kent", expected: { name: "Total BJJ" } });
  });

  it("with nothing changed, Save sends nothing", async () => {
    tab = "branding";
    await renderOwner();
    await screen.findByLabelText("Gym Name", {}, FIND);
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0), FIND);
    await new Promise((r) => setTimeout(r, 50));
    expect(patches).toEqual([]);
  });

  it("after a refused save, the next Save resends the same change (nothing was marked saved)", async () => {
    tab = "branding";
    await renderOwner();
    const name = (await screen.findByLabelText("Gym Name", {}, FIND)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "New Name" } });
    patchAnswer = async () => ({ ok: false, status: 500, json: async () => ({ error: "Failed to update settings" }) });
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect(patches.length).toBe(1), FIND);
    patchAnswer = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await waitFor(() => expect((screen.getByRole("button", { name: /Save Branding/ }) as HTMLButtonElement).disabled).toBe(false), FIND);
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect(patches.length).toBe(2), FIND);
    expect(patches[1]).toEqual({ name: "New Name", expected: { name: "Total BJJ" } });
    expect(name.value).toBe("New Name");
  });

  it("says the logo fill is saved on this device only", async () => {
    tab = "branding";
    await renderOwner({ settings: { ...SETTINGS, logoUrl: "https://example.test/logo.png" } });
    expect(await screen.findByText(/Saved on this device only/, {}, FIND)).toBeTruthy();
  });
});

describe("Settings → Revenue: plans", () => {
  it("a failed plan read shows an error with Retry, never 'No plans yet'", async () => {
    tab = "revenue";
    plansAnswer = async () => ({ ok: false, status: 502, json: async () => ({ error: "stripe down" }) });
    await renderOwner({ stripeConnected: true, stripeAccountId: "acct_x" });
    const alert = await screen.findByTestId("plans-load-error", {}, FIND);
    expect(alert.textContent).toContain("Couldn't load your plans");
    expect(screen.queryByText(/No plans yet/)).toBeNull();
    plansAnswer = async () => ({ ok: true, status: 200, json: async () => ({ plans: [{ id: "p1", name: "Adult Unlimited", amount: 6500, currency: "gbp", interval: "month" }] }) });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Adult Unlimited", {}, FIND)).toBeTruthy();
  });

  it("a network failure is shown the same way", async () => {
    tab = "revenue";
    plansAnswer = async () => { throw new TypeError("Failed to fetch"); };
    await renderOwner({ stripeConnected: true, stripeAccountId: "acct_x" });
    expect(await screen.findByTestId("plans-load-error", {}, FIND)).toBeTruthy();
  });

  it("an empty list still reads 'No plans yet'", async () => {
    tab = "revenue";
    await renderOwner({ stripeConnected: true, stripeAccountId: "acct_x" });
    expect(await screen.findByText(/No plans yet/, {}, FIND)).toBeTruthy();
  });
});

// Round 3 (10 Nov 2026): the revenue cards say what each number is. `arr` is
// this month so far × 12, which "Annual Run Rate · projected" read as a forecast.
describe("Settings → Revenue: card labels", () => {
  it("names each figure plainly and never calls month-to-date × 12 a projection", async () => {
    tab = "revenue";
    await renderOwner({ stripeConnected: true, stripeAccountId: "acct_x" });
    expect(await screen.findByText("Collected this month", {}, FIND)).toBeTruthy();
    expect(screen.getByText("This month × 12")).toBeTruthy();
    expect(screen.getByText(/not a forecast/)).toBeTruthy();
    expect(screen.getByText("Per active member")).toBeTruthy();
    expect(screen.queryByText(/Annual Run Rate/)).toBeNull();
    expect(screen.queryByText(/^projected$/)).toBeNull();
    expect(screen.queryByText("Avg per Member")).toBeNull();
    // No active members: no per-member figure ("—"), never "£0".
    const card = screen.getByText("Per active member").parentElement!;
    expect(card.textContent).toContain("—");
    expect(card.textContent).not.toContain("£0");
  });
});

// Round 4 (10 Nov 2026), CONCURRENCY-1: a save refused because someone else
// changed the same settings keeps the owner's draft, says so, and offers the
// latest or a knowing overwrite. Nothing resubmits on its own.
describe("Settings: a conflicting save keeps the draft and offers a choice", () => {
  const conflict = (field: string, current: unknown) => async () => ({
    ok: false, status: 409,
    json: async () => ({ error: "Someone changed these settings since you opened them.", reason: "stale_settings", conflicts: [{ field, current }] }),
  });

  it("branding: the draft stays, the notice names the field, and 'Save mine instead' resends knowingly", async () => {
    tab = "branding";
    await renderOwner();
    const name = (await screen.findByLabelText("Gym Name", {}, FIND)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "My Name" } });
    patchAnswer = conflict("name", "Their Name");
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    const notice = await screen.findByTestId("settings-conflict", {}, FIND);
    expect(notice.textContent).toContain("Gym name was changed by someone else");
    expect(name.value).toBe("My Name");
    expect(patches).toHaveLength(1);
    patchAnswer = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    fireEvent.click(within(notice).getByRole("button", { name: "Save mine instead" }));
    await waitFor(() => expect(patches.length).toBe(2), FIND);
    expect(patches[1]).toEqual({ name: "My Name", expected: { name: "Their Name" } });
    await waitFor(() => expect(screen.queryByTestId("settings-conflict")).toBeNull(), FIND);
  });

  it("branding: 'Use the latest' shows the club's current value, and the next save expects it", async () => {
    tab = "branding";
    await renderOwner();
    const name = (await screen.findByLabelText("Gym Name", {}, FIND)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "My Name" } });
    patchAnswer = conflict("name", "Their Name");
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    const notice = await screen.findByTestId("settings-conflict", {}, FIND);
    fireEvent.click(within(notice).getByRole("button", { name: "Use the latest" }));
    expect(name.value).toBe("Their Name");
    expect(screen.queryByTestId("settings-conflict")).toBeNull();
    expect(patches).toHaveLength(1); // nothing resent
    patchAnswer = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    fireEvent.change(name, { target: { value: "Their Name 2" } });
    await waitFor(() => expect((screen.getByRole("button", { name: /Save Branding/ }) as HTMLButtonElement).disabled).toBe(false), FIND);
    fireEvent.click(screen.getByRole("button", { name: /Save Branding/ }));
    await waitFor(() => expect(patches.length).toBe(2), FIND);
    expect(patches[1]).toEqual({ name: "Their Name 2", expected: { name: "Their Name" } });
  });

  it("waiver: a conflicting save keeps the text in the editor and expects the saved text", async () => {
    tab = "waiver";
    await renderOwner({ settings: { ...SETTINGS, waiverTitle: "Old title", waiverContent: "Old text" } });
    fireEvent.click((await screen.findAllByRole("button", { name: /Edit Waiver/ }, FIND))[0]);
    const text = (await screen.findByLabelText("Waiver content", {}, FIND)) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "My new text" } });
    patchAnswer = conflict("waiverContent", "Their newer text");
    fireEvent.click(within(text.closest(".space-y-3") as HTMLElement).getByRole("button", { name: /^Save$/ }));
    await screen.findByTestId("settings-conflict", {}, FIND);
    expect(patches[0]).toMatchObject({ waiverContent: "My new text", expected: { waiverTitle: "Old title", waiverContent: "Old text" } });
    expect((screen.getByLabelText("Waiver content") as HTMLTextAreaElement).value).toBe("My new text");
  });

  it("waiver: no reply keeps the editor open with the text and says it is unknown", async () => {
    tab = "waiver";
    await renderOwner({ settings: { ...SETTINGS, waiverTitle: "Old title", waiverContent: "Old text" } });
    fireEvent.click((await screen.findAllByRole("button", { name: /Edit Waiver/ }, FIND))[0]);
    const text = (await screen.findByLabelText("Waiver content", {}, FIND)) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: "Unsure text" } });
    patchAnswer = async () => { throw new TypeError("Failed to fetch"); };
    fireEvent.click(within(text.closest(".space-y-3") as HTMLElement).getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(toasts.some((t) => /isn't known whether the waiver was saved/.test(t.message))).toBe(true), FIND);
    expect((screen.getByLabelText("Waiver content") as HTMLTextAreaElement).value).toBe("Unsure text");
  });
});
