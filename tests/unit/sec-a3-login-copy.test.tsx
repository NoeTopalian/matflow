// @vitest-environment jsdom
//
// Login page copy after lockout v2 and the Google refusal (review R3 §6,
// security campaign iteration 2, lane A3, 9 Oct 2026).
//
// R3 found: a crafted /login?error=account_locked still rendered "This account
// is temporarily locked…" (a code nothing produces any more, and a sentence
// that tells whoever reads it the account exists); rate_limited said "a few
// minutes" for a window of up to an hour; google_link_required showed nothing.
// The lead's 0619b7d changed the copy; this pins it through the rendered page
// (both doors into the vocabulary: ?error= on the URL, and signIn().code).
//
// Lane A3 also merges the Google door's NoAccountForGym into
// google_link_required (auth.ts), so a crafted ?error=NoAccountForGym must not
// render an account-specific sentence either.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

const m = vi.hoisted(() => ({ signIn: vi.fn(), getSession: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: m.signIn, getSession: m.getSession }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import LoginPage from "@/app/login/page";

const BRANDING = {
  name: "Club A3",
  slug: "club-a3",
  logoUrl: null,
  primaryColor: "#3b82f6",
  secondaryColor: "#2563eb",
  textColor: "#ffffff",
};

function visit(search: string) {
  window.history.replaceState({}, "", `/login${search}`);
}
function fetchAnswering(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

const HOUR = /wait up to an hour/i;
const ACCOUNT_SPECIFIC = /locked|not registered|no account|isn't registered|does not exist/i;

beforeEach(() => {
  vi.clearAllMocks();
  try { window.localStorage.clear(); } catch { /* jsdom quirk */ }
});
afterEach(() => visit(""));

describe("?error= on the URL (the pre-credential doors)", () => {
  it("control: a real refusal code is spoken (tenant_paused)", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=tenant_paused");
    render(<LoginPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/paused/i);
  });

  it("a crafted ?error=account_locked renders nothing account-specific", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=account_locked");
    render(<LoginPage />);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent ?? "").not.toMatch(/temporarily locked/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rate_limited says up to an hour, never a few minutes, and offers the ways back", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=rate_limited");
    render(<LoginPage />);
    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).toMatch(HOUR);
    expect(text).not.toMatch(/few minutes/i);
    expect(text).toMatch(/device you've used before/i);
    expect(text, "true whether or not the account exists").not.toMatch(ACCOUNT_SPECIFIC);
  });

  it("google_link_required has copy, and it says nothing about whether an account exists", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=google_link_required");
    render(<LoginPage />);
    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).toMatch(/isn't linked/i);
    expect(text).not.toMatch(ACCOUNT_SPECIFIC);
  });

  it("a crafted ?error=NoAccountForGym renders nothing account-specific (the Google door no longer sends it)", async () => {
    vi.stubGlobal("fetch", fetchAnswering(404, { error: "Gym not found" }));
    visit("?error=NoAccountForGym");
    render(<LoginPage />);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent ?? "").not.toMatch(/not registered with this club/i);
  });
});

describe("signIn().code from the credentials door", () => {
  async function submitWith(code: string) {
    vi.stubGlobal("fetch", fetchAnswering(200, BRANDING));
    visit("?club=club-a3");
    m.signIn.mockResolvedValue({ error: "CredentialsSignin", code, ok: false, status: 401, url: null });
    render(<LoginPage />);
    const email = await screen.findByLabelText("Email address");
    fireEvent.change(email, { target: { value: "someone@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password-a3" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(m.signIn).toHaveBeenCalled());
    const alert = await screen.findByRole("alert");
    return alert.textContent ?? "";
  }

  it("account_locked (no producer) falls through to the generic wrong-password sentence", async () => {
    const text = await submitWith("account_locked");
    expect(text).toBe("Incorrect email or password.");
  });

  it("rate_limited from the door carries the one-hour wording", async () => {
    const text = await submitWith("rate_limited");
    expect(text).toMatch(HOUR);
    expect(text).not.toMatch(/few minutes/i);
  });

  it("control: an unknown code keeps the generic sentence", async () => {
    expect(await submitWith("credentials")).toBe("Incorrect email or password.");
  });
});
