// @vitest-environment jsdom
// The plan editor's class allowance.
//
// B1-a (15 Oct 2026): an owner can clear a plan's limit back to Unlimited, and
// a value the server would refuse is stopped in the form. Before that fix the
// editor sent `undefined` for a blank limit, JSON dropped the key, and the
// PATCH left the old limit in place while reporting success.
//
// T7c (17 Oct 2026, Sean note 5): the single "Max classes/week" became
// "Classes allowed" (1-60) "every" (1-8 weeks), sent as the pair classLimit /
// classLimitWeeks. The B1 rules carry over to the pair: a clear sends an
// explicit null pair, and an unrelated save leaves the pair out.
//
// These tests pin the request body the editor sends, because that body is the
// whole defect class.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const toastSpy = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import MembershipsManager, { allowanceNote, parseClassLimit } from "@/components/dashboard/MembershipsManager";
import type { MembershipTierRow } from "@/app/dashboard/memberships/page";
import { allowanceColumns } from "@/lib/class-allowance";

const LIMIT_ERROR = "Classes allowed must be a whole number from 1 to 60, or left blank for Unlimited.";

function tier(over: Partial<MembershipTierRow> = {}): MembershipTierRow {
  return {
    id: "t1",
    name: "Plan A",
    description: null,
    pricePence: 4500,
    currency: "GBP",
    billingCycle: "monthly",
    maxClassesPerWeek: 3,
    classLimit: null,
    classLimitWeeks: null,
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

/** A tier carrying a T7c allowance as the routes write it. */
function allowanceTier(limit: number | null, weeks: number | null, over: Partial<MembershipTierRow> = {}): MembershipTierRow {
  const cols = allowanceColumns({ classLimit: limit, classLimitWeeks: weeks })!;
  return tier({ ...cols, ...over });
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
      // The real route writes the keys it receives, with the allowance pair
      // expanded to its three columns, and returns the row.
      const id = url.split("/").pop()!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const { classLimit, classLimitWeeks, maxClassesPerWeek, ...rest } = body as {
        classLimit?: number | null; classLimitWeeks?: number | null; maxClassesPerWeek?: number | null;
      } & Record<string, unknown>;
      const cols = allowanceColumns({ classLimit, classLimitWeeks, maxClassesPerWeek }) ?? {};
      server[id] = { ...server[id], ...rest, ...cols } as MembershipTierRow;
      return json(server[id]);
    }
    if (url === "/api/memberships" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const cols = allowanceColumns(body as { classLimit?: number | null; classLimitWeeks?: number | null })
        ?? { classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null };
      return json({ ...tier({ id: "t-new" }), ...body, ...cols }, 201);
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

const limitInput = () => screen.getByLabelText("Classes allowed") as HTMLInputElement;
const weeksSelect = () => screen.getByLabelText("every (weeks)") as HTMLSelectElement;

/** The table and the phone cards are both in the DOM; act on the table. */
function openEdit(name: string): HTMLInputElement {
  fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: `Edit ${name}` }));
  return limitInput();
}

function setLimit(value: string) {
  fireEvent.change(limitInput(), { target: { value } });
}

function setWeeks(value: string) {
  fireEvent.change(weeksSelect(), { target: { value } });
}

async function saveEdit() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}

const tableText = (text: string) => within(screen.getByRole("table")).getByText(text);

describe("parseClassLimit", () => {
  it("treats empty and whitespace-only as blank", () => {
    expect(parseClassLimit("")).toEqual({ kind: "blank" });
    expect(parseClassLimit("   ")).toEqual({ kind: "blank" });
    expect(parseClassLimit("\t")).toEqual({ kind: "blank" });
  });

  it("accepts whole numbers 1 to 60, trimmed", () => {
    expect(parseClassLimit("1")).toEqual({ kind: "value", value: 1 });
    expect(parseClassLimit("30")).toEqual({ kind: "value", value: 30 });
    expect(parseClassLimit("60")).toEqual({ kind: "value", value: 60 });
    expect(parseClassLimit(" 7 ")).toEqual({ kind: "value", value: 7 });
    expect(parseClassLimit("07")).toEqual({ kind: "value", value: 7 });
  });

  it("refuses anything else", () => {
    for (const bad of ["0", "61", "99", "2.5", "1e1", "abc", "-", "-3", "+3", "100", "3 4", "٣"]) {
      expect(parseClassLimit(bad), bad).toEqual({ kind: "invalid" });
    }
  });
});

describe("allowanceNote", () => {
  it("says blank is Unlimited", () => {
    expect(allowanceNote("", "4")).toBe("Leave blank for Unlimited.");
    expect(allowanceNote("abc", "4")).toBe("Leave blank for Unlimited.");
  });

  it("states the rolling window, that it is enforced as soon as it is saved, and the next-check-in rule", () => {
    const four = allowanceNote("4", "4");
    expect(four).toContain("the 4 weeks before each class");
    expect(four).toContain("several classes in one week are fine");
    expect(four).toContain("applies from the next check-in; nothing already recorded changes");
    expect(four).toContain("It is enforced as soon as you save");
    expect(four).toContain("the member app, the kiosk and booking refuse once it is used up");
    expect(four).toContain("the desk and the card scanner ask before admitting");
    expect(four).toContain("Class-pack check-ins do not count: once the allowance is used up, a member with a class pack can still check in with a pack credit.");
    expect(four).not.toContain("do not enforce");
    expect(allowanceNote("3", "1")).toContain("the 7 days before each class");
  });
});

describe("the class allowance in the tier editor", () => {
  it("is a numeric text field plus a weeks select offering 1 to 8 weeks", () => {
    renderWith([tier()]);
    const input = openEdit("Plan A");
    expect(input.type).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    const options = Array.from(weeksSelect().options).map((o) => o.textContent);
    expect(options).toEqual(["1 week", "2 weeks", "3 weeks", "4 weeks", "5 weeks", "6 weeks", "7 weeks", "8 weeks"]);
  });

  it("a legacy weekly limit opens as N every 1 week", () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    expect(limitInput().value).toBe("3");
    expect(weeksSelect().value).toBe("1");
  });

  it("a multi-week allowance opens as saved", () => {
    renderWith([allowanceTier(4, 4)]);
    openEdit("Plan A");
    expect(limitInput().value).toBe("4");
    expect(weeksSelect().value).toBe("4");
  });

  it("the table reads e.g. 4 every 4 weeks, 3 every week, or Unlimited", () => {
    renderWith([
      allowanceTier(4, 4, { id: "a", name: "Four weekly" }),
      tier({ id: "b", name: "Legacy", maxClassesPerWeek: 3 }),
      tier({ id: "c", name: "Open", maxClassesPerWeek: null }),
    ]);
    expect(tableText("4 every 4 weeks")).toBeTruthy();
    expect(tableText("3 every week")).toBeTruthy();
    expect(tableText("Unlimited")).toBeTruthy();
  });

  it("the phone card puts the allowance on its own line, Unlimited included (review, 17 Oct 2026)", () => {
    renderWith([
      allowanceTier(4, 4, { id: "a", name: "Four weekly" }),
      tier({ id: "c", name: "Open", maxClassesPerWeek: null }),
    ]);
    const lines = screen.getAllByTestId("tier-card-allowance").map((el) => el.textContent);
    expect(lines).toEqual(["Classes: 4 every 4 weeks", "Classes: Unlimited"]);
    // Its own line, not inside the truncated price / cycle / members line.
    for (const el of screen.getAllByTestId("tier-card-allowance")) expect(el.className).not.toContain("truncate");
  });

  it("the weeks select is disabled while Classes allowed is blank, so a period alone never looks chosen", () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    expect(limitInput().value).toBe("");
    expect(weeksSelect().disabled).toBe(true);
    setLimit("4");
    expect(weeksSelect().disabled).toBe(false);
    setLimit("  ");
    expect(weeksSelect().disabled).toBe(true);
  });

  it("setting 4 every 4 weeks sends the pair, and the row then reads it", async () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    setLimit("4");
    setWeeks("4");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.method).toBe("PATCH");
    expect(w.body.classLimit).toBe(4);
    expect(w.body.classLimitWeeks).toBe(4);
    expect("maxClassesPerWeek" in w.body).toBe(false);
    await waitFor(() => expect(tableText("4 every 4 weeks")).toBeTruthy());
  });

  it("changing only the weeks sends both numbers", async () => {
    renderWith([allowanceTier(4, 4)]);
    openEdit("Plan A");
    setWeeks("2");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ classLimit: 4, classLimitWeeks: 2 });
  });

  it("clearing an existing allowance sends a null pair and the row then reads Unlimited", async () => {
    renderWith([allowanceTier(4, 4)]);
    openEdit("Plan A");
    setLimit("");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.url).toBe("/api/memberships/t1");
    expect("classLimit" in w.body && "classLimitWeeks" in w.body).toBe(true);
    expect(w.body.classLimit).toBeNull();
    expect(w.body.classLimitWeeks).toBeNull();
    await waitFor(() => expect(tableText("Unlimited")).toBeTruthy());
  });

  it("clearing a legacy weekly limit also sends a null pair", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit("   ");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ classLimit: null, classLimitWeeks: null });
    await waitFor(() => expect(tableText("Unlimited")).toBeTruthy());
  });

  // B1 correction (15 Oct 2026), carried to the pair: the allowance is sent
  // only when the owner changed it from the value this form was opened with.
  // The "server" below plays another session.
  describe("sends the allowance only when it changed from what the form loaded", () => {
    function changePrice(v: string) {
      fireEvent.change(screen.getByLabelText("Price"), { target: { value: v } });
    }

    it("opened Unlimited, another session sets 4 every 4 weeks: a price-only save omits the pair and it survives", async () => {
      renderWith([tier({ maxClassesPerWeek: null })]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, ...allowanceColumns({ classLimit: 4, classLimitWeeks: 4 })! };
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body.pricePence).toBe(5000);
      expect("classLimit" in writes()[0].body).toBe(false);
      expect("classLimitWeeks" in writes()[0].body).toBe(false);
      expect(server.t1.classLimit).toBe(4);
      // The row shows what the server now holds, not the stale form.
      await waitFor(() => expect(tableText("4 every 4 weeks")).toBeTruthy());
    });

    it("opened with 3 every week, another session sets 5: a price-only save omits the pair and 5 survives", async () => {
      renderWith([tier({ maxClassesPerWeek: 3 })]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, maxClassesPerWeek: 5 };
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("classLimit" in writes()[0].body).toBe(false);
      expect(server.t1.maxClassesPerWeek).toBe(5);
      await waitFor(() => expect(tableText("5 every week")).toBeTruthy());
    });

    it.each([
      ["3 every week", tier({ maxClassesPerWeek: 3 }), ["5"], [], { classLimit: 5, classLimitWeeks: 1 }],
      ["3 every week", tier({ maxClassesPerWeek: 3 }), [], ["4"], { classLimit: 3, classLimitWeeks: 4 }],
      ["Unlimited", tier({ maxClassesPerWeek: null }), ["60"], ["8"], { classLimit: 60, classLimitWeeks: 8 }],
    ])("explicitly changing a loaded %s sends %j", async (_label, row, limits, weeks, sent) => {
      renderWith([row]);
      openEdit("Plan A");
      for (const l of limits) setLimit(l);
      for (const w of weeks) setWeeks(w);
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body).toMatchObject(sent);
    });

    it.each([
      ["3 every week", tier({ maxClassesPerWeek: 3 }), () => { setLimit("5"); setLimit("3"); }],
      ["3 every week", tier({ maxClassesPerWeek: 3 }), () => { setLimit(""); setLimit(" 3 "); }],
      ["3 every week", tier({ maxClassesPerWeek: 3 }), () => { setLimit("7"); setLimit("03"); }],
      ["4 every 4 weeks", allowanceTier(4, 4), () => { setWeeks("2"); setWeeks("4"); }],
      ["Unlimited", tier({ maxClassesPerWeek: null }), () => { setLimit("4"); setLimit(""); }],
      // Weeks alone mean nothing while the number is blank.
      ["Unlimited", tier({ maxClassesPerWeek: null }), () => { setWeeks("4"); }],
    ])("changing a loaded %s and putting it back omits the pair", async (_label, row, steps) => {
      renderWith([row]);
      openEdit("Plan A");
      steps();
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("classLimit" in writes()[0].body).toBe(false);
      expect("classLimitWeeks" in writes()[0].body).toBe(false);
    });

    it("re-opening after a save compares against the row the page now holds", async () => {
      renderWith([tier({ maxClassesPerWeek: null })]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, ...allowanceColumns({ classLimit: 3, classLimitWeeks: 2 })! };
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(tableText("3 every 2 weeks")).toBeTruthy());
      // The sheet closed on success; open it again from the refreshed row.
      const input = openEdit("Plan A");
      expect(input.value).toBe("3");
      expect(weeksSelect().value).toBe("2");
      setLimit("");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()[1].body).toMatchObject({ classLimit: null, classLimitWeeks: null });
    });

    it("a different plan opened afterwards does not inherit the first plan's loaded allowance", async () => {
      renderWith([tier({ id: "t1", name: "Plan A", maxClassesPerWeek: 3 }), tier({ id: "t2", name: "Plan B", maxClassesPerWeek: null })]);
      openEdit("Plan A");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      openEdit("Plan B");
      expect(weeksSelect().value).toBe("1");
      setLimit("3"); // equals Plan A's loaded value, but Plan B loaded Unlimited
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].url).toBe("/api/memberships/t2");
      expect(writes()[0].body).toMatchObject({ classLimit: 3, classLimitWeeks: 1 });
    });
  });

  it.each(["2.5", "0", "61", "1e1", "abc", "-"])("refuses %j with no save request", async (typed) => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit(typed);
    await saveEdit();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
    expect(writes()).toHaveLength(0);
    // The sheet stays open with what the owner typed, so they can correct it.
    expect(limitInput().value).toBe(typed);
  });

  it("an invalid value sends nothing; correcting it then saves once", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit("61");
    await saveEdit();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
    expect(writes()).toHaveLength(0);
    setLimit("12");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ classLimit: 12, classLimitWeeks: 1 });
  });

  describe("creating a plan", () => {
    function openAdd() {
      fireEvent.click(screen.getByRole("button", { name: "Add tier" }));
      fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "New plan" } });
    }
    async function create() {
      fireEvent.click(screen.getByRole("button", { name: "Create tier" }));
    }

    it("a blank allowance omits both keys (Unlimited)", async () => {
      renderWith([tier()]);
      openAdd();
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].method).toBe("POST");
      expect("classLimit" in writes()[0].body).toBe(false);
      expect("classLimitWeeks" in writes()[0].body).toBe(false);
      expect("maxClassesPerWeek" in writes()[0].body).toBe(false);
    });

    it("a whitespace-only allowance also omits both keys", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("  ");
      setWeeks("4");
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect("classLimit" in writes()[0].body).toBe(false);
    });

    it("4 every 4 weeks is sent as the pair and listed as such", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("4");
      setWeeks("4");
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body).toMatchObject({ classLimit: 4, classLimitWeeks: 4 });
      await waitFor(() => expect(tableText("4 every 4 weeks")).toBeTruthy());
    });

    it("an invalid allowance sends nothing", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("0");
      await create();
      await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
      expect(writes()).toHaveLength(0);
    });
  });
});
