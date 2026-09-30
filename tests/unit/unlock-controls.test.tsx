// @vitest-environment jsdom
//
// A locked-out person must be visible, and clearable, from the dashboard.
//
// Ten wrong passwords lock a staff account (`User.lockedUntil`) or a member
// account (`Member.lockedUntil`) for an hour. `POST /api/auth/staff-unlock/[id]`
// and `POST /api/members/[id]/unlock` both worked, but nothing on screen called
// either (verifier lane 1, 30 Sep 2026): Settings → Staff showed a locked coach
// with no indicator and no Unlock. These tests pin the controls that now do.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  StaffUnlockControl,
  MemberUnlockDialog,
  isSignInLocked,
} from "@/components/dashboard/UnlockSignIn";

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("isSignInLocked", () => {
  it("is true only for a lockout that has not yet expired", () => {
    expect(isSignInLocked(inAnHour())).toBe(true);
    expect(isSignInLocked(anHourAgo())).toBe(false);
    expect(isSignInLocked(null)).toBe(false);
    expect(isSignInLocked(undefined)).toBe(false);
  });
});

describe("StaffUnlockControl", () => {
  it("renders nothing for someone who is not locked", () => {
    const { container } = render(
      <StaffUnlockControl staffId="u1" name="Coach Cara" lockedUntil={null} onUnlocked={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing once the lockout has expired", () => {
    const { container } = render(
      <StaffUnlockControl staffId="u1" name="Coach Cara" lockedUntil={anHourAgo()} onUnlocked={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows the pill, confirms, POSTs the staff-unlock route and reports success", async () => {
    const fetchMock = mockFetch(200, {
      ok: true,
      wasLocked: true,
      message: "Staff account unlocked. They can sign in immediately.",
    });
    const onUnlocked = vi.fn();
    render(
      <StaffUnlockControl staffId="u1" name="Coach Cara" lockedUntil={inAnHour()} onUnlocked={onUnlocked} />,
    );

    expect(screen.getByText(/Locked until \d{2}:\d{2}/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Unlock Coach Cara?")).toBeTruthy();
    expect(screen.getByText("They can sign in straight away with their current password.")).toBeTruthy();

    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Unlock");
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith("Staff account unlocked. They can sign in immediately."));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/staff-unlock/u1", { method: "POST" });
  });

  it("shows the route's own sentence when the unlock is refused", async () => {
    mockFetch(403, { error: "Only the owner can do this." });
    const onUnlocked = vi.fn();
    render(
      <StaffUnlockControl staffId="u1" name="Coach Cara" lockedUntil={inAnHour()} onUnlocked={onUnlocked} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Unlock");
    fireEvent.click(confirm!);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Only the owner can do this.");
    expect(onUnlocked).not.toHaveBeenCalled();
    // Still locked on screen — a failed unlock must not clear the pill.
    expect(screen.getByText(/Locked until \d{2}:\d{2}/)).toBeTruthy();
  });
});

describe("MemberUnlockDialog", () => {
  it("POSTs the member unlock route and passes the route's sentence up", async () => {
    const fetchMock = mockFetch(200, { ok: true, message: "Member account unlocked. They can sign in immediately." });
    const onUnlocked = vi.fn();
    const onError = vi.fn();
    render(
      <MemberUnlockDialog memberId="m1" name="Sam Tester" open onClose={() => {}} onUnlocked={onUnlocked} onError={onError} />,
    );
    expect(screen.getByText("Unlock Sam Tester?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlock sign-in" }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith("Member account unlocked. They can sign in immediately."));
    expect(fetchMock).toHaveBeenCalledWith("/api/members/m1/unlock", { method: "POST" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("passes the route's error up on failure", async () => {
    mockFetch(404, { error: "Member not found" });
    const onUnlocked = vi.fn();
    const onError = vi.fn();
    render(
      <MemberUnlockDialog memberId="m1" name="Sam Tester" open onClose={() => {}} onUnlocked={onUnlocked} onError={onError} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Unlock sign-in" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Member not found"));
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});

// ── Static: both unlock routes have a caller in the UI ──────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

describe("unlock routes are reachable from the dashboard", () => {
  const root = process.cwd();
  const sources = walk(join(root, "components")).map((f) => readFileSync(f, "utf8")).join("\n");

  it("something under components/ calls POST /api/auth/staff-unlock/[id]", () => {
    expect(sources).toMatch(/\/api\/auth\/staff-unlock\//);
  });

  it("something under components/ calls POST /api/members/[id]/unlock", () => {
    expect(sources).toMatch(/\/api\/members\/\$\{[^}]+\}\/unlock/);
  });

  it("Settings → Staff renders the staff unlock control and the member profile the member one", () => {
    const settings = readFileSync(join(root, "components/dashboard/SettingsPage.tsx"), "utf8");
    const profile = readFileSync(join(root, "components/dashboard/MemberProfile.tsx"), "utf8");
    expect(settings).toMatch(/<StaffUnlockControl\b/);
    expect(profile).toMatch(/<MemberUnlockDialog\b/);
    expect(profile).toMatch(/Unlock sign-in/);
  });

  it("the staff list and member page both select lockedUntil", () => {
    const staffRoute = readFileSync(join(root, "app/api/staff/route.ts"), "utf8");
    const settingsPage = readFileSync(join(root, "app/dashboard/settings/page.tsx"), "utf8");
    const memberPage = readFileSync(join(root, "app/dashboard/members/[id]/page.tsx"), "utf8");
    expect(staffRoute).toMatch(/lockedUntil: true/);
    expect(settingsPage).toMatch(/lockedUntil: true/);
    expect(memberPage).toMatch(/lockedUntil: true/);
  });
});
