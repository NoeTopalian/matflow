// @vitest-environment jsdom
// Hub club edit access (13 Oct 2026), UI halves:
//  - the hub control starts an EDIT session with its own step-up action and
//    the "edit" sub-action in the target, and sends mode to the start route;
//  - the owner's Activity log marks rows whose real actor was MatFlow support.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "t-club" }) }));

import LoginAsOwnerButton from "@/app/admin/tenants/[id]/LoginAsOwnerButton";
import ActivityLog, { type ActivityEntry } from "@/components/dashboard/ActivityLog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("hub Edit club control", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/admin/auth/step-up")) {
        return new Response(JSON.stringify({ ok: true, grant: "GRANT", expiresAt: new Date(Date.now() + 60000).toISOString() }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, redirectTo: "/dashboard" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    // window.location.href assignment would navigate jsdom; stub it.
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("offers View (read-only) and Edit as separate controls", () => {
    render(<LoginAsOwnerButton ownerUserId="u-owner" ownerName="Sean" />);
    expect(screen.getByRole("button", { name: /View as Sean \(read-only\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Edit club as Sean/ })).toBeTruthy();
  });

  it("edit mode explains the boundary and buys a support.edit grant with the edit sub-action, then sends mode=edit", async () => {
    render(<LoginAsOwnerButton ownerUserId="u-owner" ownerName="Sean" />);
    fireEvent.click(screen.getByRole("button", { name: /Edit club as Sean/ }));
    expect(screen.getByRole("dialog").textContent).toMatch(/routine changes/);
    expect(screen.getByRole("dialog").textContent).toMatch(/recorded as made by MatFlow/);
    fireEvent.change(screen.getByLabelText(/Reason for the support session/), { target: { value: "owner asked MatFlow to fix the timetable" } });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^Start/ }));
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u, init]) => ({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null, headers: init?.headers as Record<string, string> | undefined }));
    const su = calls.find((c) => c.url.endsWith("/api/admin/auth/step-up"))!;
    expect(su.body.action).toBe("support.edit");
    expect(su.body.targetId).toBe("t-club/u-owner/edit");
    const start = calls.find((c) => c.url.endsWith("/api/admin/impersonate"))!;
    expect(start.body.mode).toBe("edit");
    expect(start.headers?.["x-matflow-step-up"]).toBe("GRANT");
  });

  it("view mode still buys support.impersonate with the plain target and sends mode=view", async () => {
    render(<LoginAsOwnerButton ownerUserId="u-owner" ownerName="Sean" />);
    fireEvent.click(screen.getByRole("button", { name: /View as Sean/ }));
    fireEvent.change(screen.getByLabelText(/Reason for the support session/), { target: { value: "owner reported a timetable display bug" } });
    fireEvent.change(screen.getByLabelText(/authenticator code/i), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /^Start/ }));
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u, init]) => ({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : null }));
    const su = calls.find((c) => c.url.endsWith("/api/admin/auth/step-up"))!;
    expect(su.body.action).toBe("support.impersonate");
    expect(su.body.targetId).toBe("t-club/u-owner");
    const start = calls.find((c) => c.url.endsWith("/api/admin/impersonate"))!;
    expect(start.body.mode).toBe("view");
  });
});

describe("Activity log operator attribution", () => {
  function entry(over: Partial<ActivityEntry>): ActivityEntry {
    return {
      id: Math.random().toString(36).slice(2),
      action: "member.update",
      entityType: "Member",
      entityId: "m1",
      metadata: null,
      createdAt: new Date().toISOString(),
      user: { id: "u-owner", name: "Sean Coates", email: null, role: "owner" },
      undo: { ok: false, reason: "not reversible" },
      ...over,
    };
  }
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/audit-log")) {
        return new Response(JSON.stringify({
          entries: [
            entry({ id: "row-op", actedByOperator: true }),
            entry({ id: "row-own", actedByOperator: false, entityId: "m2" }),
          ],
          nextCursor: null,
          staff: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });

  it("marks only the rows whose real actor was MatFlow support", async () => {
    render(<ActivityLog initialStaff={[]} />);
    await waitFor(() => expect(screen.getAllByText("Sean Coates").length).toBe(2));
    const pills = screen.getAllByText("by MatFlow support");
    expect(pills.length).toBe(1);
    expect(pills[0].getAttribute("title")).toMatch(/made by MatFlow support/);
  });
});
