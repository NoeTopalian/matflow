// @vitest-environment jsdom
/**
 * /login/totp/setup drives the member enrolment API for a member and the staff API for staff, from the FIRST render.
 *
 * TotpEnrollmentStep fetches `${apiPrefix}/setup` once, on mount. Until 15 Nov 2026 the page chose the prefix from
 * useSession(), which on a hard load has no session on the first render, so a member's one setup request went to the
 * staff route (/api/auth/totp/setup), was refused, and the page showed "Could not initialise two-factor setup". The
 * role now comes from the server render. These tests assert the request each role actually makes and what it sees.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => React.createElement("img", { alt: String(props.alt ?? ""), src: String(props.src ?? "") }),
}));
// No session context exists on this page any more: a useSession() call here would be a regression, so make it loud.
vi.mock("next-auth/react", () => ({
  signOut: vi.fn(),
  useSession: () => { throw new Error("ForcedTotpSetup must not read the client session"); },
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import ForcedTotpSetup from "@/app/login/totp/setup/ForcedTotpSetup";

/** A server that, like the real routes, refuses the other audience's setup route. */
function serverFor(role: "member" | "staff") {
  const fetchMock = vi.fn(async (url: string) => {
    const memberRoute = url.startsWith("/api/member/totp/");
    const allowed = role === "member" ? memberRoute : url.startsWith("/api/auth/totp/");
    if (!allowed) return { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) };
    return { ok: true, status: 200, json: async () => ({ secret: "MOCKSECRET", qrDataUrl: "data:image/png;base64,QR", alreadyEnabled: false }) };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("ForcedTotpSetup route selection", () => {
  it("a member's first and only setup request goes to the member route, and the secret is shown", async () => {
    const fetchMock = serverFor("member");
    render(<ForcedTotpSetup isMember />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/member/totp/setup"]);
    expect(await screen.findByText(/MOCKSECRET/)).toBeTruthy();
    expect(screen.queryByText(/Could not initialise/)).toBeNull();
  });

  it("staff go to the staff route, and the secret is shown", async () => {
    const fetchMock = serverFor("staff");
    render(<ForcedTotpSetup isMember={false} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/auth/totp/setup"]);
    expect(await screen.findByText(/MOCKSECRET/)).toBeTruthy();
  });

  it("an already-enrolled member is sent to their profile, staff to the dashboard", async () => {
    for (const [isMember, home] of [[true, "/member/profile"], [false, "/dashboard"]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ alreadyEnabled: true }) })) as unknown as typeof fetch);
      render(<ForcedTotpSetup isMember={isMember} />);
      await waitFor(() => expect(push).toHaveBeenCalledWith(home));
      cleanup();
      push.mockReset();
    }
  });
});
