// @vitest-environment jsdom
// T7a-2 (17 Oct 2026): an owner can clear a plan's description.
//
// Same defect as B1-a's class limit: the editor sent `undefined` for a blank
// description, JSON dropped the key, and PATCH /api/memberships/[id] kept the
// old text while the sheet said "Tier updated". The fix follows the reviewed
// B1 rule: on edit, the description is sent only when it differs from what the
// form was opened with, and a cleared field is sent as an explicit null; on
// create, a blank description is omitted (the create route takes no null).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const toastSpy = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import MembershipsManager, { normaliseDescription } from "@/components/dashboard/MembershipsManager";
import type { MembershipTierRow } from "@/app/dashboard/memberships/page";

function tier(over: Partial<MembershipTierRow> = {}): MembershipTierRow {
  return {
    id: "t1",
    name: "Plan A",
    description: "Adults, all classes",
    pricePence: 4500,
    currency: "GBP",
    billingCycle: "monthly",
    maxClassesPerWeek: null,
    classLimit: null,
    classLimitBasis: null,
    classLimitWeeks: null,
    classLimitAnchor: null,
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
      return json({ ...tier({ id: "t-new" }), ...body, description: body.description ?? null }, 201);
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
  return screen.getByLabelText("Description") as HTMLInputElement;
}

function setDescription(value: string) {
  fireEvent.change(screen.getByLabelText("Description"), { target: { value } });
}

function changePrice(v: string) {
  fireEvent.change(screen.getByLabelText("Price"), { target: { value: v } });
}

function saveEdit() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}

describe("normaliseDescription", () => {
  it("treats empty and whitespace-only as no description", () => {
    expect(normaliseDescription("")).toBeNull();
    expect(normaliseDescription("   ")).toBeNull();
    expect(normaliseDescription("\t\n")).toBeNull();
  });

  it("trims surrounding whitespace and keeps the text", () => {
    expect(normaliseDescription(" Adults ")).toBe("Adults");
    expect(normaliseDescription("Kids, Saturday only")).toBe("Kids, Saturday only");
  });
});

describe("Description in the tier editor", () => {
  it("opens with the stored description", () => {
    renderWith([tier()]);
    expect(openEdit("Plan A").value).toBe("Adults, all classes");
  });

  it("clearing an existing description sends null (key present) and the row loses it", async () => {
    renderWith([tier()]);
    expect(within(screen.getByRole("table")).getByText("· Adults, all classes")).toBeTruthy();
    openEdit("Plan A");
    setDescription("");
    saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.method).toBe("PATCH");
    expect(w.url).toBe("/api/memberships/t1");
    expect("description" in w.body).toBe(true);
    expect(w.body.description).toBeNull();
    expect(server.t1.description).toBeNull();
    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("· Adults, all classes")).toBeNull());
    expect(toastSpy).toHaveBeenCalledWith("Tier updated", "success");
  });

  it("whitespace-only follows blank semantics on edit (null)", async () => {
    renderWith([tier()]);
    openEdit("Plan A");
    setDescription("    ");
    saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect("description" in writes()[0].body).toBe(true);
    expect(writes()[0].body.description).toBeNull();
  });

  it("changing the description sends the new, trimmed text", async () => {
    renderWith([tier()]);
    openEdit("Plan A");
    setDescription("  Adults, gi and no-gi  ");
    saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.description).toBe("Adults, gi and no-gi");
  });

  it("adding a description to a plan that had none sends it", async () => {
    renderWith([tier({ description: null })]);
    expect(openEdit("Plan A").value).toBe("");
    setDescription("Juniors");
    saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.description).toBe("Juniors");
  });

  describe("sends the description only when it changed from what the form loaded", () => {
    it("a price-only save omits the key, so text set meanwhile by another session survives", async () => {
      renderWith([tier()]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, description: "Set elsewhere" }; // the other session's save
      changePrice("50");
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body.pricePence).toBe(5000);
      expect("description" in writes()[0].body).toBe(false);
      expect(server.t1.description).toBe("Set elsewhere");
    });

    it("an untouched plan with no description omits the key (nothing to clear)", async () => {
      renderWith([tier({ description: null })]);
      openEdit("Plan A");
      changePrice("50");
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("description" in writes()[0].body).toBe(false);
    });

    it.each([
      ["Adults, all classes", ["", "Adults, all classes"]],
      ["Adults, all classes", ["Other", "  Adults, all classes  "]],
      [null, ["Something", ""]],
      [null, ["Something", "   "]],
    ])("changing a loaded %j and putting it back (%j) omits the key", async (loaded, steps) => {
      renderWith([tier({ description: loaded })]);
      openEdit("Plan A");
      for (const s of steps) setDescription(s);
      changePrice("50");
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("description" in writes()[0].body).toBe(false);
    });

    it("re-opening after a clear compares against the row the page now holds", async () => {
      renderWith([tier()]);
      openEdit("Plan A");
      setDescription("");
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
      // Re-open: the form loads blank, so a price-only save leaves it alone.
      expect(openEdit("Plan A").value).toBe("");
      changePrice("50");
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect("description" in writes()[1].body).toBe(false);
    });

    it("a different plan opened afterwards does not inherit the first plan's loaded description", async () => {
      renderWith([
        tier({ id: "t1", name: "Plan A", description: "Shared text" }),
        tier({ id: "t2", name: "Plan B", description: null }),
      ]);
      openEdit("Plan A");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      openEdit("Plan B");
      setDescription("Shared text"); // equals Plan A's loaded value, but Plan B loaded none
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].url).toBe("/api/memberships/t2");
      expect(writes()[0].body.description).toBe("Shared text");
    });

    it("clearing the description does not disturb the class-allowance rule", async () => {
      // #41: the editor sends the allowance as the classLimit* keys, and only
      // when it changed from what the form loaded (integration review 26 Oct).
      renderWith([tier({ classLimit: 3, classLimitBasis: "week" })]);
      openEdit("Plan A");
      setDescription("");
      saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      const body = writes()[0].body;
      expect(body.description).toBeNull();
      for (const k of ["classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor", "maxClassesPerWeek"]) {
        expect(k in body, k).toBe(false);
      }
      expect(server.t1.classLimit).toBe(3);
    });
  });

  describe("creating a plan", () => {
    function openAdd() {
      fireEvent.click(screen.getByRole("button", { name: "Add tier" }));
      fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "New plan" } });
    }
    function create() {
      fireEvent.click(screen.getByRole("button", { name: "Create tier" }));
    }

    it("a blank description omits the key (the create route takes no null)", async () => {
      renderWith([tier()]);
      openAdd();
      create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].method).toBe("POST");
      expect("description" in writes()[0].body).toBe(false);
    });

    it("a whitespace-only description also omits the key", async () => {
      renderWith([tier()]);
      openAdd();
      setDescription("   ");
      create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("description" in writes()[0].body).toBe(false);
    });

    it("a description is sent trimmed", async () => {
      renderWith([tier()]);
      openAdd();
      setDescription(" Beginners ");
      create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body.description).toBe("Beginners");
    });

    it("a plan created after editing another does not carry that plan's description", async () => {
      renderWith([tier()]);
      openEdit("Plan A");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      openAdd();
      create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("description" in writes()[0].body).toBe(false);
    });
  });
});
