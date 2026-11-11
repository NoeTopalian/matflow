// @vitest-environment jsdom
//
// Round 5 (11 Nov 2026): "Sign out all devices" signed THIS device out even
// when the server refused or never answered, so a person revoking a lost
// phone was told, by being signed out, that it had worked while every other
// session stayed live. Now a failed revoke keeps this device signed in and
// says the other devices are still signed in; only a confirmed revoke signs
// this device out. Topbar (desktop) and MobileNav (phone), the two callers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

import Topbar from "@/components/layout/Topbar";
import MobileNav from "@/components/layout/MobileNav";

const signOutMock = vi.fn();
const toastMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
}));
vi.mock("next-auth/react", () => ({ signOut: (...args: unknown[]) => signOutMock(...args) }));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

type Answer = "ok" | "500" | "403" | "401" | "network";
let answer: Answer = "ok";

beforeEach(() => {
  answer = "ok";
  global.fetch = vi.fn().mockImplementation(async () => {
    if (answer === "network") throw new TypeError("Failed to fetch");
    const status = answer === "ok" ? 200 : Number(answer);
    return { ok: status === 200, status, json: async () => (status === 200 ? { ok: true } : { error: "Failed to revoke sessions" }) };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
  signOutMock.mockReset();
  toastMock.mockReset();
});

async function click(name: string | RegExp, role = "button") {
  await act(async () => {
    fireEvent.click(screen.getByRole(role, { name }));
  });
}

const USER = { name: "Alex Chen", email: "alex@example.test", role: "owner", tenantName: "Test Club" };

const callers: Array<[string, () => Promise<void>]> = [
  ["Topbar", async () => {
    render(<Topbar user={USER} />);
    await click("Open account menu");
    await click("Sign out all devices", "menuitem");
    await click("Sign out everywhere");
  }],
  ["MobileNav", async () => {
    render(<MobileNav role="owner" primaryColor="#3b82f6" />);
    await click("More options");
    await click("Sign out all devices");
  }],
];

describe.each(callers)("%s: sign out all devices", (_name, revoke) => {
  it("a confirmed revoke signs this device out", async () => {
    await revoke();
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/login" });
    expect(toastMock).not.toHaveBeenCalled();
  });

  for (const failure of ["500", "403", "network"] as const) {
    it(`a failed revoke (${failure}) keeps this device signed in and says the other devices are still signed in`, async () => {
      answer = failure;
      await revoke();
      expect(signOutMock).not.toHaveBeenCalled();
      expect(toastMock).toHaveBeenCalledTimes(1);
      const [message, type] = toastMock.mock.calls[0];
      expect(type).toBe("error");
      expect(String(message)).toMatch(/other devices are still signed in/i);
    });
  }

  it("the server's reason is shown when it gives one (e.g. an authenticator code still owed)", async () => {
    answer = "403";
    await revoke();
    expect(String(toastMock.mock.calls[0][0])).toContain("Failed to revoke sessions");
  });

  it("a 401 (this session is already gone) signs this device out: there is nothing left to keep", async () => {
    answer = "401";
    await revoke();
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/login" });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("after a failure the control can be used again, and a retry that works signs out", async () => {
    answer = "500";
    await revoke();
    expect(signOutMock).not.toHaveBeenCalled();
    answer = "ok";
    if (_name === "Topbar") {
      await click("Open account menu");
      await click("Sign out all devices", "menuitem");
      await click("Sign out everywhere");
    } else {
      await click("Sign out all devices");
    }
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });
});
