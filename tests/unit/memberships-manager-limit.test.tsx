// @vitest-environment jsdom
// B1-a (15 Oct 2026): an owner can clear a plan's "Max classes/week" back to
// Unlimited, and a value the server would refuse is stopped in the form.
//
// Before this fix the editor sent `undefined` for a blank limit, JSON dropped
// the key, and the PATCH left the old limit in place while reporting success.
// These tests pin the request body the editor sends, because that body is the
// whole defect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const toastSpy = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import MembershipsManager, { parseClassLimit } from "@/components/dashboard/MembershipsManager";
import type { MembershipTierRow } from "@/app/dashboard/memberships/page";

const LIMIT_ERROR = "Max classes per week must be a whole number from 1 to 30, or left blank for Unlimited.";

function tier(over: Partial<MembershipTierRow> = {}): MembershipTierRow {
  return {
    id: "t1",
    name: "Plan A",
    description: null,
    pricePence: 4500,
    currency: "GBP",
    billingCycle: "monthly",
    maxClassesPerWeek: 3,
    isKids: false,
    isActive: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    stripePriceId: null,
    stripeProductId: null,
    activeMembers: 0,
    locationId: null,
    locationName: null,
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let server: Record<string, MembershipTierRow>;

beforeEach(() => {
  toastSpy.mockReset();
  server = {};
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/api/locations") return json({ locations: [] });
    if (url.startsWith("/api/memberships/") && init?.method === "PATCH") {
      // The real route writes exactly the keys it receives and returns the row.
      const id = url.split("/").pop()!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      server[id] = { ...server[id], ...body } as MembershipTierRow;
      return json(server[id]);
    }
    if (url === "/api/memberships" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ ...tier({ id: "t-new" }), ...body, maxClassesPerWeek: body.maxClassesPerWeek ?? null }, 201);
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function writes() {
  return fetchMock.mock.calls
    .filter(([u, init]) => String(u).startsWith("/api/memberships") && (init as RequestInit | undefined)?.method)
    .map(([u, init]) => ({
      url: String(u),
      method: (init as RequestInit).method,
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));
}

function renderWith(rows: MembershipTierRow[]) {
  for (const r of rows) server[r.id] = r;
  render(<MembershipsManager initialTiers={rows} primaryColor="#123456" />);
}

/** The table and the phone cards are both in the DOM; act on the table. */
function openEdit(name: string): HTMLInputElement {
  fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: `Edit ${name}` }));
  return screen.getByLabelText("Max classes/week") as HTMLInputElement;
}

function setLimit(value: string) {
  fireEvent.change(screen.getByLabelText("Max classes/week"), { target: { value } });
}

async function saveEdit() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}

describe("parseClassLimit", () => {
  it("treats empty and whitespace-only as blank", () => {
    expect(parseClassLimit("")).toEqual({ kind: "blank" });
    expect(parseClassLimit("   ")).toEqual({ kind: "blank" });
    expect(parseClassLimit("\t")).toEqual({ kind: "blank" });
  });

  it("accepts whole numbers 1 to 30, trimmed", () => {
    expect(parseClassLimit("1")).toEqual({ kind: "value", value: 1 });
    expect(parseClassLimit("30")).toEqual({ kind: "value", value: 30 });
    expect(parseClassLimit(" 7 ")).toEqual({ kind: "value", value: 7 });
    expect(parseClassLimit("07")).toEqual({ kind: "value", value: 7 });
  });

  it("refuses anything else", () => {
    for (const bad of ["0", "31", "2.5", "1e1", "abc", "-", "-3", "+3", "100", "3 4", "٣"]) {
      expect(parseClassLimit(bad), bad).toEqual({ kind: "invalid" });
    }
  });
});

describe("Max classes/week in the tier editor", () => {
  it("is a numeric text field, so the browser cannot silently blank a bad value", () => {
    renderWith([tier()]);
    const input = openEdit("Plan A");
    expect(input.type).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.value).toBe("3");
  });

  it("clearing an existing limit sends null and the row then reads Unlimited", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit("");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.method).toBe("PATCH");
    expect(w.url).toBe("/api/memberships/t1");
    expect("maxClassesPerWeek" in w.body).toBe(true);
    expect(w.body.maxClassesPerWeek).toBeNull();
    await waitFor(() => expect(within(screen.getByRole("table")).getByText("Unlimited")).toBeTruthy());
  });

  it("whitespace-only follows blank semantics on edit (null)", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit("   ");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.maxClassesPerWeek).toBeNull();
  });

  it("an unrelated edit re-sends the existing limit unchanged", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "50" } });
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.pricePence).toBe(5000);
    expect(writes()[0].body.maxClassesPerWeek).toBe(3);
  });

  it("an unrelated edit of an Unlimited plan keeps it Unlimited", async () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "50" } });
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.maxClassesPerWeek).toBeNull();
  });

  it.each([
    ["5", 5],
    ["1", 1],
    ["30", 30],
    [" 12 ", 12],
  ])("saves %j as %i", async (typed, sent) => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    setLimit(typed);
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.maxClassesPerWeek).toBe(sent);
  });

  it.each(["2.5", "0", "31", "1e1", "abc", "-"])("refuses %j with no save request", async (typed) => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit(typed);
    await saveEdit();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
    expect(writes()).toHaveLength(0);
    // The sheet stays open with what the owner typed, so they can correct it.
    expect((screen.getByLabelText("Max classes/week") as HTMLInputElement).value).toBe(typed);
  });

  it("an invalid value sends nothing; correcting it then saves once", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit("31");
    await saveEdit();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
    expect(writes()).toHaveLength(0);
    setLimit("12");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.maxClassesPerWeek).toBe(12);
  });

  describe("creating a plan", () => {
    function openAdd() {
      fireEvent.click(screen.getByRole("button", { name: "Add tier" }));
      fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "New plan" } });
    }
    async function create() {
      fireEvent.click(screen.getByRole("button", { name: "Create tier" }));
    }

    it("a blank limit omits the key (the create route takes no null)", async () => {
      renderWith([tier()]);
      openAdd();
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].method).toBe("POST");
      expect("maxClassesPerWeek" in writes()[0].body).toBe(false);
    });

    it("a whitespace-only limit also omits the key", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("  ");
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("maxClassesPerWeek" in writes()[0].body).toBe(false);
    });

    it("a valid limit is sent as a number", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("4");
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body.maxClassesPerWeek).toBe(4);
    });

    it("an invalid limit sends nothing", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("0");
      await create();
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
      expect(writes()).toHaveLength(0);
    });
  });
});
