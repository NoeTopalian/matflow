// @vitest-environment jsdom
// Hub club edit access (13 Oct 2026), UI halves:
//  - the hub control starts an EDIT session with its own step-up action and
//    the "edit" sub-action in the target, and sends mode to the start route;
//  - the owner's Activity log marks rows whose real actor was MatFlow support.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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

  it("Escape closes the dialog without starting a session (keyboard a11y, 14 Oct 2026)", async () => {
    render(<LoginAsOwnerButton ownerUserId="u-owner" ownerName="Sean" />);
    fireEvent.click(screen.getByRole("button", { name: /Edit club as Sean/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
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

  // DataTable renders the desktop table and the phone cards side by side in
  // the DOM (CSS picks one), so every assertion is scoped to one of them.
  it("marks only the rows whose real actor was MatFlow support (desktop table)", async () => {
    render(<ActivityLog initialStaff={[]} />);
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByText("Sean Coates").length).toBe(2));
    const pills = within(table).getAllByText("by MatFlow support");
    expect(pills.length).toBe(1);
    expect(pills[0].getAttribute("title")).toMatch(/made by MatFlow support/);
  });

  // B1-b (15 Oct 2026): the phone card showed "name ?? System" and no label,
  // so on a phone an owner could not tell MatFlow's edits from their own.
  it("marks the same row on the phone card, with the same wording", async () => {
    render(<ActivityLog initialStaff={[]} />);
    await waitFor(() => expect(screen.getAllByTestId("activity-card").length).toBe(2));
    const [opCard, ownCard] = screen.getAllByTestId("activity-card");
    expect(opCard.textContent).toContain("Sean Coates");
    const pill = within(opCard).getByText("by MatFlow support");
    expect(pill.getAttribute("title")).toMatch(/made by MatFlow support/);
    expect(ownCard.textContent).toContain("Sean Coates");
    expect(within(ownCard).queryByText("by MatFlow support")).toBeNull();
  });
});

describe("Activity log: desktop and phone name the same actor (B1-b parity)", () => {
  const base = {
    entityType: "Member",
    entityId: "m1",
    metadata: null,
    createdAt: "2026-10-15T10:00:00.000Z",
    undo: { ok: false as const, reason: "not reversible" },
  };
  // Expected name and label for each row, in render order.
  const cases: { entry: ActivityEntry; name: string; pill: boolean }[] = [
    { // support edit attributed to the owner
      entry: { ...base, id: "r-support", action: "member.update", actedByOperator: true, user: { id: "u1", name: "Sean Coates", email: null, role: "owner" } },
      name: "Sean Coates", pill: true },
    { // ordinary staff edit
      entry: { ...base, id: "r-staff", action: "member.update", actedByOperator: false, user: { id: "u2", name: "Coach Kim", email: null, role: "coach" } },
      name: "Coach Kim", pill: false },
    { // staff user with no name falls back to their address
      entry: { ...base, id: "r-email", action: "member.update", user: { id: "u3", name: null, email: "nameless@example.test", role: "manager" } },
      name: "nameless@example.test", pill: false },
    { // nameless actor under a support session still gets the label
      entry: { ...base, id: "r-email-op", action: "member.update", actedByOperator: true, user: { id: "u3", name: null, email: "nameless@example.test", role: "manager" } },
      name: "nameless@example.test", pill: true },
    { // operator-plane row with no user: MatFlow, and no redundant label
      entry: { ...base, id: "r-admin", action: "admin.impersonate.edit_start", actedByOperator: true, user: null },
      name: "MatFlow", pill: false },
    { // system row with no user
      entry: { ...base, id: "r-system", action: "member.update", user: null },
      name: "System", pill: false },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/audit-log")) {
        return new Response(JSON.stringify({ entries: cases.map((c) => c.entry), nextCursor: null, staff: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });

  it("support, staff and fallback actors read identically on desktop and phone", async () => {
    render(<ActivityLog initialStaff={[]} />);
    await waitFor(() => expect(screen.getAllByTestId("activity-card").length).toBe(cases.length));
    const table = screen.getByRole("table");
    const bodyRows = within(table).getAllByRole("row").filter((r) => within(r).queryAllByRole("cell").length > 0);
    expect(bodyRows.length).toBe(cases.length);
    const cards = screen.getAllByTestId("activity-card");

    cases.forEach((c, i) => {
      const whoCell = within(bodyRows[i]).getAllByRole("cell")[1];
      const deskPill = within(whoCell).queryByText("by MatFlow support");
      const cardPill = within(cards[i]).queryByText("by MatFlow support");

      // Desktop: exactly the expected name, plus the label when expected.
      expect(whoCell.textContent, c.entry.id).toBe(c.name + (c.pill ? "by MatFlow support" : ""));
      expect(Boolean(deskPill), c.entry.id).toBe(c.pill);
      // Phone: the same name and the same label decision.
      expect(cards[i].textContent, c.entry.id).toContain(`· ${c.name}`);
      expect(Boolean(cardPill), c.entry.id).toBe(c.pill);
      if (deskPill && cardPill) expect(cardPill.getAttribute("title")).toBe(deskPill.getAttribute("title"));
    });
  });
});
