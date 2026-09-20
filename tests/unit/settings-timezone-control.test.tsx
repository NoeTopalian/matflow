// @vitest-environment jsdom
//
// J16, third round: "an owner can set Tenant.timezone, through the route and
// from the screen".
//
// The route half is proven green by the round-4 e2e log (`PATCH settings
// {timezone:"America/New_York"} → 200; column is America/New_York`, and again
// for Pacific/Auckland). What failed is the SCREEN half, and it failed at the
// very first of the three things the round-3 spec was rebuilt to separate:
//
//     the control took the change — if this is the old value React never saw
//     the event
//     Expected: "Europe/Dublin"   Received: "Pacific/Auckland"
//
// So this file asks exactly one question, with no browser and no dev server in
// the way: when a change event reaches `#club-timezone`, does the controlled
// value move, and does Save send that value to PATCH /api/settings?
//
// It is the revert-failing test for the control: delete the `onChange`, or bind
// `value` to anything but the state the handler writes, and cases 2 and 3 go
// red.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

// This file runs beside ~200 others on a serial Windows runner, so every wait
// here is generous and every "nothing happened" check is a microtask flush
// rather than a sleep. Nothing below races a real timer.
const FIND = { timeout: 20_000 } as const;
/** Flush the microtask chain a late fetch resolution would land on. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {});
  }
}
import React from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("tab=waiver"),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  usePathname: () => "/dashboard/settings",
}));

const SETTINGS = {
  id: "t-A",
  name: "Total BJJ",
  slug: "totalbjj",
  subscriptionTier: "pro",
  subscriptionStatus: "active",
  primaryColor: "#3b82f6",
  secondaryColor: "#2563eb",
  textColor: "#ffffff",
  bgColor: "#111111",
};

/** Every fetch this component fires, answered. PATCH bodies are recorded. */
const patches: string[] = [];
function installFetch(zone: string) {
  patches.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url.includes("/api/settings") && (init?.method ?? "GET") === "PATCH") {
        patches.push(init?.body ?? "");
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes("/api/settings")) {
        return { ok: true, status: 200, json: async () => ({ timezone: zone }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

async function renderOwner(zone: string) {
  installFetch(zone);
  const mod = await import("@/components/dashboard/SettingsPage");
  const SettingsPage = mod.default;
  render(
    React.createElement(SettingsPage, {
      // The props the waiver tab needs; the rest of the page is inert here.
      settings: SETTINGS,
      staff: [],
      statusCounts: {},
      primaryColor: "#3b82f6",
      role: "owner",
      currentUserId: "u-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
  );
  return await screen.findByLabelText("Club time zone", {}, FIND);
}

describe("J16 — the club time-zone control on Settings → Waiver", () => {
  beforeEach(() => {
    patches.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the zone the route returned, not a browser guess", async () => {
    const select = (await renderOwner("Pacific/Auckland")) as HTMLSelectElement;
    expect(select.value).toBe("Pacific/Auckland");
  });

  it("takes the owner's change — the controlled value moves with the event", async () => {
    const select = (await renderOwner("Pacific/Auckland")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Europe/Dublin" } });
    await waitFor(() => expect(select.value).toBe("Europe/Dublin"), FIND);
  });

  it("Save time zone PATCHes /api/settings with the zone that is on screen", async () => {
    const select = (await renderOwner("Pacific/Auckland")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Europe/Dublin" } });
    await waitFor(() => expect(select.value).toBe("Europe/Dublin"), FIND);
    fireEvent.click(screen.getByRole("button", { name: /save time zone/i }));
    await waitFor(() => expect(patches.length).toBe(1), FIND);
    expect(patches[0]).toContain("Europe/Dublin");
  });

  it("a zone the runtime does not list is still shown rather than snapped away", async () => {
    const select = (await renderOwner("Mars/Olympus_Mons")) as HTMLSelectElement;
    expect(select.value).toBe("Mars/Olympus_Mons");
  });

  // ── The three-round J16 failure, reproduced ────────────────────────────────
  //
  // Two GET /api/settings are in flight on every dev mount, because React
  // StrictMode runs the effect twice. The first lands and paints the stored
  // zone; the owner picks another; the second lands and — before this fix —
  // put the stored one back. The next assertion the owner's own eyes would
  // make ("the control shows what I chose") is the one the e2e spec makes, and
  // it went red for three rounds on exactly this.
  it("a slow second read cannot undo the zone the owner just chose", async () => {
    const gets: Array<(zone: string) => void> = [];
    patches.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
        const url = String(input);
        if (url.includes("/api/settings") && (init?.method ?? "GET") === "PATCH") {
          patches.push(init?.body ?? "");
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        if (url.includes("/api/settings")) {
          // Hand the test the release valve for this particular read.
          return await new Promise((resolve) => {
            gets.push((zone: string) =>
              resolve({ ok: true, status: 200, json: async () => ({ timezone: zone }) }),
            );
          });
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    const mod = await import("@/components/dashboard/SettingsPage");
    const SettingsPage = mod.default;
    render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(SettingsPage, {
          settings: SETTINGS,
          staff: [],
          statusCounts: {},
          primaryColor: "#3b82f6",
          role: "owner",
          currentUserId: "u-1",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ),
    );

    // StrictMode double-invokes the effect: two reads, both outstanding.
    await waitFor(() => expect(gets.length).toBeGreaterThanOrEqual(2), FIND);

    // Land the FIRST read only. On a build that discards a superseded read
    // this paints nothing at all — deterministically, at any speed, because
    // the response is dropped rather than merely slow. On a build without the
    // guard it paints the stored zone. Both branches are handled, and neither
    // depends on how fast the machine is.
    let released = 1;
    gets[0]("Pacific/Auckland");
    await settle();
    if (!screen.queryByLabelText("Club time zone")) {
      gets[1]("Pacific/Auckland");
      released = 2;
    }
    const select = (await screen.findByLabelText("Club time zone", {}, FIND)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("Pacific/Auckland"), FIND);

    // The owner picks their own zone.
    fireEvent.change(select, { target: { value: "Europe/Dublin" } });
    await waitFor(() => expect(select.value).toBe("Europe/Dublin"), FIND);

    // …and only now does every read still in flight come back, each carrying
    // the old value. Not one of them may be allowed to speak over the owner.
    for (let i = released; i < gets.length; i++) gets[i]("Pacific/Auckland");
    await settle();
    expect(select.value, "a late read must not undo the owner's choice").toBe("Europe/Dublin");

    // And Save must carry what is on screen, not what the server last said.
    fireEvent.click(screen.getByRole("button", { name: /save time zone/i }));
    await waitFor(() => expect(patches.length).toBe(1), FIND);
    expect(patches[0]).toContain("Europe/Dublin");
  });
});
