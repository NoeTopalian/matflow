// @vitest-environment jsdom
// The sign-out buttons report success only once the server has ended the session (Round 8, 16 Nov 2026).
//
// next-auth's client signOut() navigated to /login whatever the sign-out request answered. signOutThisDevice()
// navigates only on a 2xx; a refusal, a network failure or a lost response returns false and leaves the page where it
// is, so the button can say "We couldn't sign you out. Try again."

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { signOutThisDevice } from "@/lib/sign-out-client";

const fetchMock = vi.fn();
const assignMock = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  fetchMock.mockReset();
  assignMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, assign: assignMock } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

function csrfOk() {
  return new Response(JSON.stringify({ csrfToken: "csrf-123" }), { status: 200 });
}

describe("signOutThisDevice", () => {
  it("posts Auth.js's sign-out with the CSRF token, and goes to /login once the server agrees", async () => {
    fetchMock.mockResolvedValueOnce(csrfOk()).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await signOutThisDevice()).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/auth/signout");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Auth-Return-Redirect"]).toBe("1");
    expect(new URLSearchParams(init.body as URLSearchParams).get("csrfToken")).toBe("csrf-123");
    expect(assignMock).toHaveBeenCalledWith("/login");
  });

  it("a refused sign-out (503: not recorded on the server) reports failure and stays on the page", async () => {
    fetchMock.mockResolvedValueOnce(csrfOk()).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await signOutThisDevice()).toBe(false);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("a network failure or a lost response reports failure and stays on the page", async () => {
    fetchMock.mockResolvedValueOnce(csrfOk()).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await signOutThisDevice()).toBe(false);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("Auth.js answering with its error page (200 + ?error=) is a failure, not a sign-out", async () => {
    fetchMock
      .mockResolvedValueOnce(csrfOk())
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "http://localhost/api/auth/error?error=MissingCSRF" }), { status: 200 }));
    expect(await signOutThisDevice()).toBe(false);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("no CSRF token: nothing is posted, failure is reported", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await signOutThisDevice()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("a retry after a failure works (the server ignores a session it already ended)", async () => {
    fetchMock.mockResolvedValueOnce(csrfOk()).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await signOutThisDevice()).toBe(false);
    fetchMock.mockResolvedValueOnce(csrfOk()).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await signOutThisDevice()).toBe(true);
    expect(assignMock).toHaveBeenCalledTimes(1);
  });
});

describe("every sign-out button goes through it", () => {
  it("no component calls next-auth's client signOut() any more", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "components/layout/Topbar.tsx",
      "components/layout/MobileNav.tsx",
      "app/member/profile/page.tsx",
      "app/login/totp/page.tsx",
      "app/login/totp/setup/ForcedTotpSetup.tsx",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/\bsignOut\(/);
      expect(src, file).toMatch(/signOutThisDevice\(\)/);
      // A single-device sign-out that fails says so.
      expect(src, file).toMatch(/toast\(SIGN_OUT_FAILED_MESSAGE, "error"/);
    }
  });
});
