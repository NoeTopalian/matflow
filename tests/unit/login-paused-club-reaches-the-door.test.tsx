// @vitest-environment jsdom
//
// The paused club's owner has to be able to reach the sentence written for them.
//
// `lib/tenant-admission.ts` has said the right thing for a while — "Your club's
// account is paused, so sign-in is unavailable. Please speak to your gym." —
// and `auth.ts` throws the refusal that carries it. Two things stopped it ever
// arriving:
//
//  1. `/login?club=<slug>` renders NO form until `/api/tenant/<slug>` resolves,
//     and that route 404s a suspended club deliberately (so the lookup cannot
//     be used to enumerate clubs or their commercial standing). The owner of a
//     paused club therefore landed on a bare club-code box, forever. There is
//     no password field, so the door that holds the message is unreachable.
//     Round 3 evidence, la-1 log: two 60-second `waitForSelector` timeouts on
//     `input[type='email']` at `/login?club=<suspended>` — the harness waiting
//     for a form the product was never going to render.
//
//  2. Every door that refuses BEFORE a credential (magic-link verify, the
//     Google callback) redirects to `/login?error=tenant_paused`. The page has
//     never read `?error=`. The code arrived and was dropped on the floor.
//
// Both are fixed in `app/login/page.tsx` and both are pinned here.
//
// What is NOT changed, and is asserted as such: `/api/tenant/[slug]` still
// answers 404 identically for "never existed" and "exists but closed".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import LoginPage from "@/app/login/page";

const ACTIVE_BRANDING = {
  name: "Total BJJ",
  slug: "totalbjj",
  logoUrl: null,
  primaryColor: "#3b82f6",
  secondaryColor: "#2563eb",
  textColor: "#ffffff",
};

function visit(search: string) {
  window.history.replaceState({}, "", `/login${search}`);
}

/** The lookup route's real answer for a suspended, cancelled or deleted club. */
function fetchAnswering(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  try { window.localStorage.clear(); } catch { /* jsdom quirk */ }
});

afterEach(() => {
  visit("");
});

describe("a paused club's deep link reaches the password door", () => {
  it("renders the sign-in form when the club lookup 404s on a ?club= link", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?club=pausedclub");

    render(<LoginPage />);

    // THE ASSERTION THE ROUND-3 LOG IS MISSING: a form, not a club-code box.
    const email = await screen.findByLabelText("Email address");
    expect(email).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("echoes the slug they arrived with and invents no club name", async () => {
    // UI-RULES §7 — no fabricated placeholder data. The screen does not know
    // what this club is called and must not guess; the slug is the person's
    // own input coming back.
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?club=pausedclub");

    render(<LoginPage />);
    await screen.findByLabelText("Email address");

    expect(screen.getAllByText("pausedclub").length).toBeGreaterThan(0);
  });

  it("still uses the club's real branding when the lookup succeeds", async () => {
    // The fallback must not have swallowed the ordinary path.
    vi.stubGlobal("fetch", fetchAnswering(200, ACTIVE_BRANDING));
    visit("?club=totalbjj");

    render(<LoginPage />);
    await screen.findByLabelText("Email address");

    expect(screen.getAllByText("Total BJJ").length).toBeGreaterThan(0);
  });

  it("does NOT render a password box for a hand-typed unknown code", async () => {
    // No deep link, no message: "check your code" is the likeliest truth for
    // someone who typed it, and widening this would turn the club-code step
    // into a password prompt for every typo.
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("");

    render(<LoginPage />);

    expect(screen.getByLabelText("Club code")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});

describe("?error= from the pre-credential doors is spoken out loud", () => {
  it("shows the paused-club sentence on the club-code step", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=tenant_paused");

    render(<LoginPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/paused/i);
    expect(alert.textContent).toMatch(/speak to your gym/i);
  });

  it("shows the closed-club sentence on the password step of a deep link", async () => {
    vi.stubGlobal("fetch", fetchAnswering(200, ACTIVE_BRANDING));
    visit("?club=totalbjj&error=tenant_closed");

    render(<LoginPage />);
    await screen.findByLabelText("Email address");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/closed/i);
  });

  it("says nothing at all for a code it has no copy for", async () => {
    // A machine string shouted at a member is worse than silence; the sign-in
    // they are about to attempt will answer them properly.
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=SomeInternalCode");

    render(<LoginPage />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the lookup route is NOT the thing that changed", () => {
  it("still answers 404 for a suspended club and for one that never existed", async () => {
    // The enumeration boundary. If a later change makes this route describe the
    // club's state, the bit an attacker can read with no credential at all goes
    // from "nothing" to "this slug belongs to a real club that has stopped
    // paying", 30 times a minute per IP. That is the trade this fix exists to
    // avoid making.
    // `process.cwd()`, not `import.meta.url`: under the jsdom environment the
    // module URL is not a file: URL and `readFileSync` refuses it.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "app/api/tenant/[slug]/route.ts"), "utf8");
    expect(src).toMatch(/subscriptionStatus === "suspended"/);
    expect(src).toMatch(/NOT_FOUND_RESPONSE, \{ status: 404 \}/);
    expect(src, "one 404 answer, shared by both cases").toMatch(
      /const NOT_FOUND_RESPONSE = \{ error: "Gym not found" \}/,
    );
  });
});
