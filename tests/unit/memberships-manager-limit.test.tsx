// @vitest-environment jsdom
// The plan editor's class allowance.
//
// B1-a (15 Oct 2026): an owner can clear a plan's limit back to Unlimited, and
// a value the server would refuse is stopped in the form. Before that fix the
// editor sent `undefined` for a blank limit, JSON dropped the key, and the
// PATCH left the old limit in place while reporting success.
//
// T7c (17 Oct 2026, Sean note 5) and the product decision of 20 Oct 2026: the
// single "Max classes/week" became "Classes allowed" (1-60) on an EXPLICIT
// reset basis — each week, each calendar month, or every N weeks (2-8) from a
// start date the plan carries. Never a rolling window. The editor shows a
// plain summary with the actual period dates before anything is saved. The B1
// rules carry over: a clear sends explicit nulls, and an unrelated save leaves
// the allowance keys out.
//
// These tests pin the request body the editor sends, because that body is the
// whole defect class.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

const toastSpy = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import MembershipsManager, { allowanceNote, formAllowance, mondayOf, parseClassLimit, PERIOD_START_ERROR } from "@/components/dashboard/MembershipsManager";
import type { MembershipTierRow } from "@/app/dashboard/memberships/page";
import { allowanceColumns, type AllowanceInput } from "@/lib/class-allowance";

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

/**
 * The columns as the routes write them. The anchor is a Date run through
 * JSON, exactly as POST/PATCH /api/memberships return the Prisma row
 * ("2026-10-20T00:00:00.000Z"); the page serialises it as "YYYY-MM-DD" and
 * the manager must read both (review M-1, 21 Oct 2026).
 */
function rowColumns(input: AllowanceInput): Partial<MembershipTierRow> {
  const cols = allowanceColumns(input);
  if (!cols) return {};
  return { ...cols, classLimitAnchor: cols.classLimitAnchor ? JSON.parse(JSON.stringify(cols.classLimitAnchor)) : null };
}

/** A tier carrying a T7c allowance as the routes write it. */
function allowanceTier(input: AllowanceInput, over: Partial<MembershipTierRow> = {}): MembershipTierRow {
  return tier({ ...rowColumns(input), ...over });
}
const FOUR_IN_FOUR: AllowanceInput = { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" };

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
      // The real route writes the keys it receives, with the allowance set
      // expanded to its columns, and returns the row.
      const id = url.split("/").pop()!;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const { classLimit, classLimitBasis, classLimitWeeks, classLimitAnchor, maxClassesPerWeek, ...rest } = body as AllowanceInput & Record<string, unknown>;
      const cols = rowColumns({ classLimit, classLimitBasis, classLimitWeeks, classLimitAnchor, maxClassesPerWeek });
      server[id] = { ...server[id], ...rest, ...cols } as MembershipTierRow;
      return json(server[id]);
    }
    if (url === "/api/memberships" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const cols = rowColumns(body as AllowanceInput);
      return json({ ...tier({ id: "t-new", maxClassesPerWeek: null }), ...body, ...cols }, 201);
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
const basisSelect = () => screen.getByLabelText("resets") as HTMLSelectElement;
const weeksSelect = () => screen.getByLabelText("every (weeks)") as HTMLSelectElement;
const anchorInput = () => screen.getByLabelText("periods count from") as HTMLInputElement;

/** The table and the phone cards are both in the DOM; act on the table. */
function openEdit(name: string): HTMLInputElement {
  fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: `Edit ${name}` }));
  return limitInput();
}
const setLimit = (value: string) => fireEvent.change(limitInput(), { target: { value } });
const setBasis = (value: string) => fireEvent.change(basisSelect(), { target: { value } });
const setWeeks = (value: string) => fireEvent.change(weeksSelect(), { target: { value } });
const setAnchor = (value: string) => fireEvent.change(anchorInput(), { target: { value } });
async function saveEdit() {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
}
const tableText = (text: string) => within(screen.getByRole("table")).getByText(text);
const ALLOWANCE_KEYS = ["classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor"] as const;
const sentAllowance = (body: Record<string, unknown>) => ALLOWANCE_KEYS.some((k) => k in body);

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

describe("formAllowance and allowanceNote (the summary shown before saving)", () => {
  const form = (o: Partial<{ classLimit: string; classLimitBasis: string; classLimitWeeks: string; classLimitAnchor: string }>) => ({
    classLimit: "", classLimitBasis: "week", classLimitWeeks: "4", classLimitAnchor: "2026-10-20", ...o,
  });
  const NOW = new Date("2026-10-21T14:00:00.000Z");

  it("blank is Unlimited, and the note says so without a period", () => {
    expect(formAllowance(form({}))).toEqual({ kind: "ok", allowance: null });
    const n = allowanceNote(formAllowance(form({})), NOW);
    expect(n.summary).toMatch(/^Unlimited classes\./);
    expect(n.period).toBeNull();
    expect(n.enforcement).toBe("");
  });

  it("each basis reads back as an allowance", () => {
    expect(formAllowance(form({ classLimit: "3" }))).toEqual({ kind: "ok", allowance: { limit: 3, basis: "week" } });
    expect(formAllowance(form({ classLimit: "8", classLimitBasis: "month" }))).toEqual({ kind: "ok", allowance: { limit: 8, basis: "month" } });
    expect(formAllowance(form({ classLimit: "4", classLimitBasis: "weeks" }))).toEqual({
      kind: "ok", allowance: { limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" },
    });
  });

  it("refuses a bad number, and every-N-weeks without a real start date", () => {
    expect(formAllowance(form({ classLimit: "61" }))).toEqual({ kind: "error", message: LIMIT_ERROR });
    expect(formAllowance(form({ classLimit: "4", classLimitBasis: "weeks", classLimitAnchor: "" }))).toEqual({ kind: "error", message: PERIOD_START_ERROR });
    expect(formAllowance(form({ classLimit: "4", classLimitBasis: "weeks", classLimitAnchor: "2026-02-30" }))).toEqual({ kind: "error", message: PERIOD_START_ERROR });
  });

  it("states the plain summary with the next reset and the actual period dates, then what enforcement means", () => {
    const n = allowanceNote(formAllowance(form({ classLimit: "4", classLimitBasis: "weeks" })), NOW);
    expect(n.summary).toBe("Attend up to 4 classes during each 4-week period. The next reset is Tuesday 17 November 2026.");
    expect(n.period).toBe("The current period runs Tuesday 20 October to Monday 16 November 2026.");
    expect(n.enforcement).toContain("Attending a class uses one; booking does not.");
    expect(n.enforcement).toContain("It is enforced as soon as you save");
    expect(n.enforcement).toContain("the member app and the kiosk refuse once it is used up, a booking still goes through with a warning");
    expect(n.enforcement).toContain("the desk and the card scanner ask before admitting");
    expect(n.enforcement).toContain("applies from the next check-in; nothing already recorded changes");
    expect(n.enforcement).toContain("Class-pack check-ins do not count");
    expect(n.summary + n.period).not.toMatch(/rolling|before each class/);
    expect(allowanceNote(formAllowance(form({ classLimit: "3" })), NOW).summary).toBe("Attend up to 3 classes during each week. The next reset is Monday 26 October 2026.");
    expect(allowanceNote(formAllowance(form({ classLimit: "8", classLimitBasis: "month" })), NOW).summary).toBe("Attend up to 8 classes during each calendar month. The next reset is Sunday 1 November 2026.");
  });

  it("mondayOf gives the Monday of the week (the default period start)", () => {
    expect(mondayOf("2026-10-21")).toBe("2026-10-19");
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    expect(mondayOf("2026-10-25")).toBe("2026-10-19");
  });
});

describe("the class allowance in the tier editor", () => {
  it("is a numeric text field plus a reset basis; every-N-weeks reveals the weeks (2 to 8) and a start date", () => {
    renderWith([tier()]);
    const input = openEdit("Plan A");
    expect(input.type).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(Array.from(basisSelect().options).map((o) => o.textContent)).toEqual([
      "Each week (Monday to Sunday)", "Each calendar month", "Every N weeks from a start date",
    ]);
    expect(screen.queryByLabelText("every (weeks)")).toBeNull();
    setBasis("weeks");
    expect(Array.from(weeksSelect().options).map((o) => o.textContent)).toEqual(["2 weeks", "3 weeks", "4 weeks", "5 weeks", "6 weeks", "7 weeks", "8 weeks"]);
    expect(anchorInput().type).toBe("date");
  });

  it("a legacy weekly limit opens as N each week", () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    expect(limitInput().value).toBe("3");
    expect(basisSelect().value).toBe("week");
  });

  it("an every-4-weeks allowance opens as saved, start date included", () => {
    renderWith([allowanceTier(FOUR_IN_FOUR)]);
    openEdit("Plan A");
    expect(limitInput().value).toBe("4");
    expect(basisSelect().value).toBe("weeks");
    expect(weeksSelect().value).toBe("4");
    expect(anchorInput().value).toBe("2026-10-20");
  });

  it("the summary under the fields shows the period dates before saving", () => {
    renderWith([allowanceTier(FOUR_IN_FOUR)]);
    openEdit("Plan A");
    expect(screen.getByTestId("tier-allowance-summary").textContent).toMatch(/^Attend up to 4 classes during each 4-week period\. The next reset is /);
    expect(screen.getByTestId("tier-allowance-period").textContent).toMatch(/^The current period runs /);
    setBasis("month");
    expect(screen.getByTestId("tier-allowance-summary").textContent).toMatch(/^Attend up to 4 classes during each calendar month\./);
  });

  it("the table reads e.g. 4 every 4 weeks, 3 each week, 8 each month, or Unlimited", () => {
    renderWith([
      allowanceTier(FOUR_IN_FOUR, { id: "a", name: "Four weekly" }),
      tier({ id: "b", name: "Legacy", maxClassesPerWeek: 3 }),
      allowanceTier({ classLimit: 8, classLimitBasis: "month" }, { id: "m", name: "Monthly", maxClassesPerWeek: null }),
      tier({ id: "c", name: "Open", maxClassesPerWeek: null }),
    ]);
    expect(tableText("4 every 4 weeks")).toBeTruthy();
    expect(tableText("3 each week")).toBeTruthy();
    expect(tableText("8 each month")).toBeTruthy();
    expect(tableText("Unlimited")).toBeTruthy();
  });

  it("the phone card puts the allowance on its own line, Unlimited included (review, 17 Oct 2026)", () => {
    renderWith([
      allowanceTier(FOUR_IN_FOUR, { id: "a", name: "Four weekly" }),
      tier({ id: "c", name: "Open", maxClassesPerWeek: null }),
    ]);
    const lines = screen.getAllByTestId("tier-card-allowance").map((el) => el.textContent);
    expect(lines).toEqual(["Classes: 4 every 4 weeks", "Classes: Unlimited"]);
    for (const el of screen.getAllByTestId("tier-card-allowance")) expect(el.className).not.toContain("truncate");
  });

  it("the basis select is disabled while Classes allowed is blank, so a period alone never looks chosen", () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    expect(limitInput().value).toBe("");
    expect(basisSelect().disabled).toBe(true);
    setLimit("4");
    expect(basisSelect().disabled).toBe(false);
    setLimit("  ");
    expect(basisSelect().disabled).toBe(true);
  });

  it("setting 4 every 4 weeks from 20 October sends the whole set, and the row then reads it", async () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    setLimit("4");
    setBasis("weeks");
    setWeeks("4");
    setAnchor("2026-10-20");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.method).toBe("PATCH");
    expect(w.body).toMatchObject({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
    expect("maxClassesPerWeek" in w.body).toBe(false);
    await waitFor(() => expect(tableText("4 every 4 weeks")).toBeTruthy());
  });

  it("a weekly or monthly allowance sends null weeks and start date", async () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    setLimit("8");
    setBasis("month");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ classLimit: 8, classLimitBasis: "month", classLimitWeeks: null, classLimitAnchor: null });
  });

  it("changing only the start date sends the whole set", async () => {
    renderWith([allowanceTier(FOUR_IN_FOUR)]);
    openEdit("Plan A");
    setAnchor("2026-10-27");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-27" });
  });

  it("clearing an existing allowance sends nulls for the whole set and the row then reads Unlimited", async () => {
    renderWith([allowanceTier(FOUR_IN_FOUR)]);
    openEdit("Plan A");
    setLimit("");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const w = writes()[0];
    expect(w.url).toBe("/api/memberships/t1");
    expect(w.body).toMatchObject({ classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null });
    await waitFor(() => expect(tableText("Unlimited")).toBeTruthy());
  });

  it("clearing a legacy weekly limit also sends the nulls", async () => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit("   ");
    await saveEdit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ classLimit: null, classLimitBasis: null });
    await waitFor(() => expect(tableText("Unlimited")).toBeTruthy());
  });

  it("every-N-weeks without a start date is refused in the form, with no request", async () => {
    renderWith([tier({ maxClassesPerWeek: null })]);
    openEdit("Plan A");
    setLimit("4");
    setBasis("weeks");
    setAnchor("");
    await saveEdit();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(PERIOD_START_ERROR, "error"));
    expect(writes()).toHaveLength(0);
  });

  // B1 correction (15 Oct 2026), carried to the set: the allowance is sent
  // only when the owner changed it from the value this form was opened with.
  // The "server" below plays another session.
  describe("sends the allowance only when it changed from what the form loaded", () => {
    function changePrice(v: string) {
      fireEvent.change(screen.getByLabelText("Price"), { target: { value: v } });
    }

    it("opened Unlimited, another session sets 4 every 4 weeks: a price-only save omits the set and it survives", async () => {
      renderWith([tier({ maxClassesPerWeek: null })]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, ...rowColumns(FOUR_IN_FOUR) };
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body.pricePence).toBe(5000);
      expect(sentAllowance(writes()[0].body)).toBe(false);
      expect(server.t1.classLimit).toBe(4);
      await waitFor(() => expect(tableText("4 every 4 weeks")).toBeTruthy());
    });

    it("opened with 3 each week, another session sets 5: a price-only save omits the set and 5 survives", async () => {
      renderWith([tier({ maxClassesPerWeek: 3 })]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, maxClassesPerWeek: 5 };
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(sentAllowance(writes()[0].body)).toBe(false);
      expect(server.t1.maxClassesPerWeek).toBe(5);
      await waitFor(() => expect(tableText("5 each week")).toBeTruthy());
    });

    it.each([
      ["3 each week", tier({ maxClassesPerWeek: 3 }), () => setLimit("5"), { classLimit: 5, classLimitBasis: "week" }],
      ["3 each week", tier({ maxClassesPerWeek: 3 }), () => setBasis("month"), { classLimit: 3, classLimitBasis: "month" }],
      ["Unlimited", tier({ maxClassesPerWeek: null }), () => { setLimit("60"); setBasis("weeks"); setWeeks("8"); setAnchor("2026-10-19"); }, { classLimit: 60, classLimitBasis: "weeks", classLimitWeeks: 8, classLimitAnchor: "2026-10-19" }],
    ])("explicitly changing a loaded %s sends %j", async (_label, row, steps, sent) => {
      renderWith([row]);
      openEdit("Plan A");
      steps();
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].body).toMatchObject(sent);
    });

    it.each([
      ["3 each week", tier({ maxClassesPerWeek: 3 }), () => { setLimit("5"); setLimit("3"); }],
      ["3 each week", tier({ maxClassesPerWeek: 3 }), () => { setLimit(""); setLimit(" 3 "); }],
      ["3 each week", tier({ maxClassesPerWeek: 3 }), () => { setLimit("7"); setLimit("03"); }],
      ["3 each week", tier({ maxClassesPerWeek: 3 }), () => { setBasis("month"); setBasis("week"); }],
      ["4 every 4 weeks", allowanceTier(FOUR_IN_FOUR), () => { setWeeks("2"); setWeeks("4"); }],
      ["4 every 4 weeks", allowanceTier(FOUR_IN_FOUR), () => { setAnchor("2026-11-02"); setAnchor("2026-10-20"); }],
      ["Unlimited", tier({ maxClassesPerWeek: null }), () => { setLimit("4"); setLimit(""); }],
    ])("changing a loaded %s and putting it back omits the set", async (_label, row, steps) => {
      renderWith([row]);
      openEdit("Plan A");
      steps();
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(sentAllowance(writes()[0].body)).toBe(false);
    });

    it("re-opening after a save compares against the row the page now holds", async () => {
      renderWith([tier({ maxClassesPerWeek: null })]);
      openEdit("Plan A");
      server.t1 = { ...server.t1, ...rowColumns({ classLimit: 3, classLimitBasis: "weeks", classLimitWeeks: 2, classLimitAnchor: "2026-10-19" }) };
      changePrice("50");
      await saveEdit();
      await waitFor(() => expect(tableText("3 every 2 weeks")).toBeTruthy());
      const input = openEdit("Plan A");
      expect(input.value).toBe("3");
      expect(weeksSelect().value).toBe("2");
      setLimit("");
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()[1].body).toMatchObject({ classLimit: null, classLimitBasis: null });
    });

    it("a different plan opened afterwards does not inherit the first plan's loaded allowance", async () => {
      renderWith([tier({ id: "t1", name: "Plan A", maxClassesPerWeek: 3 }), tier({ id: "t2", name: "Plan B", maxClassesPerWeek: null })]);
      openEdit("Plan A");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      openEdit("Plan B");
      expect(basisSelect().value).toBe("week");
      setLimit("3"); // equals Plan A's loaded value, but Plan B loaded Unlimited
      await saveEdit();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].url).toBe("/api/memberships/t2");
      expect(writes()[0].body).toMatchObject({ classLimit: 3, classLimitBasis: "week" });
    });
  });

  it.each(["2.5", "0", "61", "1e1", "abc", "-"])("refuses %j with no save request", async (typed) => {
    renderWith([tier({ maxClassesPerWeek: 3 })]);
    openEdit("Plan A");
    setLimit(typed);
    await saveEdit();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(LIMIT_ERROR, "error"));
    expect(writes()).toHaveLength(0);
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
    expect(writes()[0].body).toMatchObject({ classLimit: 12, classLimitBasis: "week" });
  });

  describe("creating a plan", () => {
    function openAdd() {
      fireEvent.click(screen.getByRole("button", { name: "Add tier" }));
      fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "New plan" } });
    }
    async function create() {
      fireEvent.click(screen.getByRole("button", { name: "Create tier" }));
    }

    it("a blank allowance omits the keys (Unlimited)", async () => {
      renderWith([tier()]);
      openAdd();
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0].method).toBe("POST");
      expect(sentAllowance(writes()[0].body)).toBe(false);
      expect("maxClassesPerWeek" in writes()[0].body).toBe(false);
    });

    it("a whitespace-only allowance also omits the keys", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("  ");
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(sentAllowance(writes()[0].body)).toBe(false);
    });

    it("every-N-weeks defaults its start date to the Monday of this week, and the set is sent", async () => {
      renderWith([tier()]);
      openAdd();
      setLimit("4");
      setBasis("weeks");
      const anchor = anchorInput().value;
      expect(anchor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(mondayOf(anchor)).toBe(anchor);
      await create();
      await waitFor(() => expect(writes()).toHaveLength(1));
      // The sheet closes on success, so the value was captured before creating.
      expect(writes()[0].body).toMatchObject({ classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: anchor });
    });
  });
});
