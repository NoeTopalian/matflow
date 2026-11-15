// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import type { Session } from "next-auth";

/**
 * Round 8 (15 Nov 2026): ImportPanel mounts its own next-auth SessionProvider, seeded with the server render's session
 * (the root layout has none). With the REAL provider (next-auth is not mocked here), this checks the behaviour the
 * seeding is for: the owner gate is decided on the first render, no /api/auth/session request is made on mount, a
 * manager's seeded session hides the panel, and a tab focus still re-reads the session — a sign-out seen there hides it.
 */
vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({ ask: vi.fn(), dialogProps: {} }),
}));

import ImportPanel from "@/components/dashboard/ImportPanel";

const seeded = (role: string): Session =>
  ({ user: { id: "u1", role, tenantId: "t-A" }, expires: new Date(Date.now() + 86_400_000).toISOString() }) as unknown as Session;

let sessionBody: unknown;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/auth/session")) return new Response(JSON.stringify(sessionBody), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "content-type": "application/json" } });
});
const sessionCalls = () => fetchMock.mock.calls.filter(([u]) => String(typeof u === "string" ? u : (u as Request).url ?? u).includes("/api/auth/session")).length;

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImportPanel with its own seeded SessionProvider", () => {
  it("shows the importer to a seeded owner on the first render, with no session request", async () => {
    render(<ImportPanel primaryColor="#d62828" session={seeded("owner")} />);
    expect(screen.getByRole("group", { name: "What are you importing?" })).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sessionCalls()).toBe(0);
  });

  it("renders nothing for a seeded manager, with no session request", async () => {
    const { container } = render(<ImportPanel primaryColor="#d62828" session={seeded("manager")} />);
    expect(container.textContent?.trim()).toBe("");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sessionCalls()).toBe(0);
  });

  it("re-reads the session on tab focus, and a sign-out seen there hides the importer", async () => {
    render(<ImportPanel primaryColor="#d62828" session={seeded("owner")} />);
    expect(screen.getByRole("group", { name: "What are you importing?" })).toBeTruthy();
    sessionBody = {}; // what /api/auth/session answers once signed out
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(sessionCalls()).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(screen.queryByRole("group", { name: "What are you importing?" })).toBeNull());
  });
});
