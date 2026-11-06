// @vitest-environment jsdom
// The Activity timeline as a person meets it: what is asked of the server for
// each state of the address bar, what is drawn for each answer, and what each
// control does. The server's side of the bargain is tested in activity-api and
// activity-feed-entry; here the answers are canned.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({ listeners: new Set<() => void>(), toasts: [] as { message: string; type?: string }[] }));

// The real hook follows history.replaceState; this stand-in does the same in jsdom.
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSearchParams: () => {
      const search = useSyncExternalStore(
        (notify: () => void) => {
          h.listeners.add(notify);
          return () => h.listeners.delete(notify);
        },
        () => window.location.search,
      );
      return new URLSearchParams(search);
    },
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: (message: string, type?: string) => h.toasts.push({ message, type }) }) }));

import { ActivityTimeline } from "@/components/activity/ActivityTimeline";
import { defaultTypeKeys, storedDefaultKey, visibleTypeKeys, ACTIVITY_TYPES, type ActivityResponse, type FeedEntry, type Part } from "@/lib/activity-types";

const OWNER = "u_owner";
const STAFF = [
  { id: OWNER, name: "Sean Coates", role: "owner" },
  { id: "u_jack", name: "Jack Streeter", role: "coach" },
];
const TIERS = [
  { id: "t_adult", name: "Adult Unlimited", isActive: true },
  { id: "t_old", name: "Twice a week (OLD)", isActive: false },
];

const member = (name: string, id: string): Part => ({ subject: { kind: "member", name, href: `/dashboard/members/${id}` } });
let n = 0;
function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  const id = over.id ?? `e${++n}`;
  return { id, at: "2026-11-05T19:45:00.000Z", dayKey: "2026-11-05", type: "checkin", parts: [member("Melody Orekoya", "m_mel"), { text: " checked in" }], plain: "Melody Orekoya checked in", detail: null, detailPlain: null, changes: null, source: { label: "Member app", staff: null, support: false }, undone: false, ...over };
}
function body(entries: FeedEntry[], over: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    entries,
    nextCursor: null,
    enriched: true,
    clock: { timeZone: "Europe/London", todayKey: "2026-11-05", minDayKey: "2025-11-05", clamped: false },
    filters: { types: { view: "club", keys: [] }, member: null, class: null, payment: null, tier: null, staff: null, dayKey: null },
    ignoredTypes: [],
    droppedTypes: [],
    ...over,
  };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
const activityCalls = () => calls.filter((c) => c.url.startsWith("/api/activity"));
const lastQuery = () => new URL(activityCalls().at(-1)!.url, "http://x").searchParams;

beforeEach(() => {
  n = 0;
  calls = [];
  h.toasts.length = 0;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/dashboard/activity");
  respond = () => ({ status: 200, body: body([]) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null };
      calls.push(call);
      const { status, body: answer } = await respond(call);
      return { ok: status >= 200 && status < 300, status, json: async () => answer };
    }),
  );
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  Element.prototype.scrollIntoView = vi.fn();
  // The address bar is the store: tell the stand-in hook whenever the page writes to it.
  const real = History.prototype.replaceState;
  vi.spyOn(window.history, "replaceState").mockImplementation(function (this: History, ...args: Parameters<History["replaceState"]>) {
    real.apply(window.history, args);
    h.listeners.forEach((notify) => notify());
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderPage = (role: "owner" | "manager" = "owner", viewerId = OWNER) => render(<ActivityTimeline variant="page" role={role} viewerId={viewerId} staff={STAFF} tiers={TIERS} />);
const table = () => screen.getByRole("table");
const tab = (name: string) => screen.getByRole("tab", { name });
/** Opens Filters; returns the sheet. */
const openFilters = () => {
  fireEvent.click(screen.getByTestId("filters-button"));
  return screen.getByRole("dialog", { name: "Filters" });
};
/** Opens the day sheet; returns it. */
const openDay = () => {
  fireEvent.click(screen.getByTestId("date-button"));
  return screen.getByRole("dialog", { name: "Jump to date" });
};
const loaded = () => waitFor(() => expect(screen.getByTestId("activity-status").textContent).not.toBe(""));
/** The screen-reader status line, which repeats the empty state's title. */
const STATUS = '[data-testid="activity-status"]';

describe("first load", () => {
  it("asks once, for the default view, and draws day headings, sentences and links from the answer", async () => {
    respond = () => ({
      status: 200,
      body: body([
        entry({ id: "today" }),
        entry({ id: "yesterday", at: "2026-11-04T10:00:00.000Z", dayKey: "2026-11-04", type: "payment", parts: [member("Faisal Alshukri", "m_f"), { text: " paid " }, { subject: { kind: "payment", name: "£45.00", href: "/dashboard/members/m_f?tab=payments&paymentId=p1" } }], plain: "Faisal Alshukri paid £45.00", source: { label: "Stripe", staff: null, support: false } }),
        entry({ id: "older", at: "2026-11-03T09:00:00.000Z", dayKey: "2026-11-03", type: "class_changed", parts: [{ subject: { kind: "staff", name: "Jack Streeter", href: "/dashboard/activity?userId=u_jack" } }, { text: " paused " }, { subject: { kind: "class", name: "Advanced No-Gi", href: "/dashboard/timetable?classId=c1" } }], plain: "Jack Streeter paused Advanced No-Gi", source: { label: "Staff", staff: null, support: false } }),
      ]),
    });
    renderPage();
    await loaded();
    expect(activityCalls()).toHaveLength(1);
    expect(lastQuery().get("types")).toBe("club");
    expect(lastQuery().get("take")).toBe("50");
    expect([...table().querySelectorAll("tr[data-section] th")].map((th) => th.textContent)).toEqual(["Today", "Yesterday", "Tuesday 3 November 2026"]);
    expect(within(table()).getByText("Melody Orekoya").getAttribute("href")).toBe("/dashboard/members/m_mel");
    expect(within(table()).getByText("£45.00").getAttribute("href")).toBe("/dashboard/members/m_f?tab=payments&paymentId=p1");
    expect(within(table()).getByText("Advanced No-Gi").getAttribute("href")).toBe("/dashboard/timetable?classId=c1");
    // 19:45 UTC is 19:45 in London in November: the club's clock, whatever the reader's is.
    expect(within(table()).getAllByText("19:45").length).toBe(1);
    expect(screen.getByTestId("activity-status").textContent).toBe("Showing 3 activities");
    expect(tab("Club activity").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("date-button").textContent).toBe("Today");
  });

  it("the owner has an Undo column; a manager has none, and sees only their own types in the sheet", async () => {
    respond = () => ({ status: 200, body: body([entry({ undo: { ok: true, sinceHere: null } })]) });
    const owner = renderPage("owner");
    await loaded();
    expect([...table().querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["When", "What happened", "Undo"]);
    expect(within(table()).getByRole("button", { name: "Undo: Melody Orekoya checked in" })).toBeTruthy();
    owner.unmount();

    respond = () => ({ status: 200, body: body([entry()]) });
    renderPage("manager", "u_manager");
    await loaded();
    expect([...table().querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["When", "What happened"]);
    expect(screen.queryByText(/Undo puts the recorded details back/)).toBeNull();
    fireEvent.click(within(openFilters()).getByTestId("types-trigger"));
    const sheet = screen.getByRole("dialog", { name: "Activity types" });
    expect(within(sheet).queryByText("Staff accounts")).toBeNull();
    expect(within(sheet).queryByText("MatFlow support")).toBeNull();
    expect(within(sheet).getByText("Refund")).toBeTruthy();
    expect(within(sheet).getByTestId("types-count").textContent).toBe(`${defaultTypeKeys("manager").length} of ${visibleTypeKeys("manager").length} selected`);
  });

  it("marks a row MatFlow support made, the same way in the table and on the card — but not when its type already says so", async () => {
    respond = () => ({
      status: 200,
      body: body([
        entry({ id: "support", type: "member_updated", parts: [{ text: "MatFlow support updated " }, { ...member("Melody Orekoya", "m_mel"), possessive: true }, { text: " details" }], plain: "MatFlow support updated Melody Orekoya's details", source: { label: "MatFlow support", staff: null, support: true } }),
        entry({ id: "own", type: "member_updated", source: { label: "Staff", staff: { id: "u_jack", name: "Jack Streeter" }, support: false } }),
        entry({ id: "typed", type: "support", parts: [{ text: "MatFlow issued the owner a temporary password" }], plain: "MatFlow issued the owner a temporary password", detail: [{ text: "Reason: reset" }], detailPlain: "Reason: reset", source: { label: "MatFlow support", staff: null, support: true } }),
      ]),
    });
    renderPage();
    await loaded();
    const pills = within(table()).getAllByText("by MatFlow support");
    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute("title")).toMatch(/made by MatFlow support/);
    const [supportCard, ownCard, typedCard] = screen.getAllByTestId("activity-card");
    expect(within(supportCard).getByText("by MatFlow support").getAttribute("title")).toBe(pills[0].getAttribute("title"));
    expect(within(ownCard).queryByText("by MatFlow support")).toBeNull();
    // A row whose type is MatFlow support says so once, in its type; the reason sits on its own line under the headline.
    expect(within(typedCard).queryByText("by MatFlow support")).toBeNull();
    expect(within(typedCard).getByText("MatFlow support")).toBeTruthy();
    expect(within(typedCard).getByTestId("activity-detail").textContent).toBe("Reason: reset");
    // The possessive sits outside the link, and who did it is a last line, "By …", linking to their activity.
    expect(within(supportCard).getByText("Melody Orekoya").textContent).toBe("Melody Orekoya");
    expect(supportCard.textContent).toContain("Melody Orekoya's details");
    expect(within(ownCard).getByTestId("activity-source").textContent).toBe("By Jack Streeter");
    expect(within(ownCard).getByText("Jack Streeter").getAttribute("href")).toBe("/dashboard/activity?userId=u_jack");
  });
});

describe("how a row is laid out", () => {
  const changes3 = [
    { label: "For children", from: "off", to: "on" },
    { label: "Price", from: "£30.00", to: "£35.00" },
    { label: "Classes allowed", from: "Unlimited", to: "1 every week" },
  ];
  const joined = (list: { label: string; from: string | null; to: string | null }[]) => list.map((c) => `${c.label}: ${c.from} → ${c.to}`).join(" · ");
  const planRow = (over: Partial<FeedEntry> = {}) =>
    entry({
      id: "plan",
      type: "plan_setup",
      parts: [{ text: "Updated a membership plan — " }, { subject: { kind: "tier", name: "Kids Once A Week Membership (OLD)", href: "/dashboard/memberships" } }],
      plain: "Updated a membership plan — Kids Once A Week Membership (OLD)",
      changes: changes3,
      detail: [{ text: joined(changes3) }],
      detailPlain: joined(changes3),
      source: { label: "Staff", staff: { id: OWNER, name: "Sean Coates" }, support: false },
      ...over,
    });
  const firstRow = () => table().querySelector("tbody tr:not([data-section])") as HTMLElement;

  it("three changes are a list of three, in sentence case, with no ' · ' anywhere in the row", async () => {
    respond = () => ({ status: 200, body: body([planRow()]) });
    renderPage();
    await loaded();
    const tr = firstRow();
    const items = [...tr.querySelectorAll('[data-testid="activity-changes"] li')].map((li) => li.textContent);
    expect(items).toEqual(["For children: Off → On", "Price: £30.00 → £35.00", "Classes allowed: Unlimited → 1 every week"]);
    expect(tr.textContent).not.toContain(" · ");
    // Names exactly as the club wrote them, "(OLD)" included; who did it is the last line.
    expect(within(tr).getByText("Kids Once A Week Membership (OLD)")).toBeTruthy();
    expect(within(tr).getByTestId("activity-source").textContent).toBe("By Sean Coates");
    // The thin first column holds the time, and the type under it.
    expect(tr.querySelector("td")!.textContent).toBe("19:45Plans and packs (set-up)");
  });

  it("only MatFlow's own words get a capital: what the club wrote is shown exactly, a case-only rename included", async () => {
    const changes = [
      { label: "For children", from: "off", to: "on" },
      { label: "Name", from: "kids", to: "Kids" },
      { label: "Surname", from: "de Souza", to: "De Souza" },
      { label: "Device", from: "iPhone", to: "iPad" },
      { label: "Classes allowed", from: "unlimited", to: "2" },
    ];
    respond = () => ({ status: 200, body: body([planRow({ changes, detail: [{ text: joined(changes) }] })]) });
    renderPage();
    await loaded();
    expect([...firstRow().querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "For children: Off → On",
      "Name: kids → Kids",
      "Surname: de Souza → De Souza",
      "Device: iPhone → iPad",
      "Classes allowed: Unlimited → 2",
    ]);
  });

  it("a reason and the changes: the reason on its own line, the changes as bullets", async () => {
    respond = () => ({ status: 200, body: body([planRow({ detail: [{ text: "Phone: 0771 → 0772 · Reason: wrong number" }], changes: [{ label: "Phone", from: "0771", to: "0772" }] })]) });
    renderPage();
    await loaded();
    const tr = firstRow();
    expect(within(tr).getByTestId("activity-detail").textContent).toBe("Reason: wrong number");
    expect([...tr.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Phone: 0771 → 0772"]);
  });

  it("nine changes show six and 'Show all 9 changes'; eight show all eight", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `Field ${i + 1}`, from: "a", to: "b" }));
    respond = () => ({
      status: 200,
      body: body([planRow({ id: "nine", changes: nine, detail: [{ text: joined(nine) }] }), planRow({ id: "eight", changes: nine.slice(0, 8), detail: [{ text: joined(nine.slice(0, 8)) }] })]),
    });
    renderPage();
    await loaded();
    const [nineRow, eightRow] = [...table().querySelectorAll("tbody tr:not([data-section])")] as HTMLElement[];
    expect(nineRow.querySelectorAll("li")).toHaveLength(6);
    expect(eightRow.querySelectorAll("li")).toHaveLength(8);
    expect(within(eightRow).queryByRole("button", { name: /Show all/ })).toBeNull();
    const more = within(nineRow).getByRole("button", { name: "Show all 9 changes" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(nineRow.querySelectorAll("li")).toHaveLength(9);
    expect(within(nineRow).getByRole("button", { name: "Show fewer changes" })).toBeTruthy();
  });

  it("a manager, who may not see the values, gets 'Label changed' bullets", async () => {
    const hidden = changes3.map((c) => ({ label: c.label, from: null, to: null }));
    respond = () => ({ status: 200, body: body([planRow({ type: "member_updated", changes: hidden, detail: [{ text: `Fields: ${hidden.map((c) => c.label).join(", ")}` }] })]) });
    renderPage("manager", "u_manager");
    await loaded();
    const tr = firstRow();
    expect([...tr.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["For children changed", "Price changed", "Classes allowed changed"]);
    expect(tr.textContent).not.toMatch(/→|Fields:/);
  });

  it("a change the sentence already says is not repeated as a bullet; detail the page does not recognise stays as sent", async () => {
    respond = () => ({
      status: 200,
      body: body([planRow({ id: "told", detail: null, detailPlain: null, changes: [{ label: "Status", from: "Active", to: "Cancelled" }] }), planRow({ id: "pack", detail: [{ text: "Used a class pack credit · 3 left" }], changes: null })]),
    });
    renderPage();
    await loaded();
    const [told, pack] = [...table().querySelectorAll("tbody tr:not([data-section])")] as HTMLElement[];
    expect(told.querySelector("ul")).toBeNull();
    expect(within(pack).getByTestId("activity-detail").textContent).toBe("Used a class pack credit · 3 left");
  });

  it("the table has three columns, and below 1024px the rows are cards (the table from lg: up)", async () => {
    respond = () => ({ status: 200, body: body([planRow()]) });
    renderPage();
    await loaded();
    expect(table().querySelectorAll("thead th")).toHaveLength(3);
    // jsdom has no layout: the breakpoint is the class on each half.
    const tableHalf = table().closest("div.hidden")!;
    expect(tableHalf.className).toContain("lg:block");
    expect(tableHalf.className).not.toContain("sm:block");
    const cardHalf = screen.getAllByTestId("activity-card")[0].closest(".space-y-2")!;
    expect(cardHalf.className).toContain("lg:hidden");
    expect(cardHalf.className).not.toContain("sm:hidden");
    // A card: time · type on top, then the same description and bullets.
    const card = screen.getAllByTestId("activity-card")[0];
    expect(card.firstElementChild!.textContent).toBe("19:45·Plans and packs (set-up)");
    expect(card.querySelectorAll("li")).toHaveLength(3);
  });
});

describe("the address bar is the filter", () => {
  it("opens on what the address says, and names it", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=money&memberId=m_mel&userId=u_jack&day=2026-11-03");
    respond = () => ({ status: 200, body: body([entry({ dayKey: "2026-11-03", at: "2026-11-03T10:00:00.000Z" })], { filters: { types: { view: "money", keys: [] }, member: { id: "m_mel", name: "Melody Orekoya" }, class: null, payment: null, tier: null, staff: { id: "u_jack", name: "Jack Streeter" }, dayKey: "2026-11-03" } }) });
    renderPage();
    await loaded();
    const q = lastQuery();
    expect([q.get("types"), q.get("memberId"), q.get("userId"), q.get("day")]).toEqual(["money", "m_mel", "u_jack", "2026-11-03"]);
    expect(screen.getByRole("heading", { name: "Activity for Melody Orekoya" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open profile" }).getAttribute("href")).toBe("/dashboard/members/m_mel");
    expect(tab("Money").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("member-picked").textContent).toContain("Melody Orekoya");
    expect(screen.getByTestId("date-button").textContent).toBe("Tue 3 Nov");
    expect(screen.getByRole("button", { name: "Remove filter: Done by: Jack Streeter" })).toBeTruthy();
    expect(screen.getByTestId("filters-button").textContent).toBe("Filters (1)");
    expect(table().querySelector("caption")!.textContent).toBe("Activity: Money, Melody Orekoya, done by Jack Streeter, up to 3 Nov 2026");
  });

  it("an old copied link with types, a plan, a staff member and a day restores the same view", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=checkin,refund&tierId=t_adult&userId=u_jack&day=2026-11-04");
    respond = () => ({ status: 200, body: body([entry()]) });
    renderPage();
    await loaded();
    const q = lastQuery();
    expect([q.get("types"), q.get("tierId"), q.get("userId"), q.get("day")]).toEqual(["checkin,refund", "t_adult", "u_jack", "2026-11-04"]);
    // Hand-picked types match no tab: none is selected, and the choice is a chip.
    expect(screen.getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(0);
    const chips = within(screen.getByTestId("activity-chips"));
    expect(chips.getAllByRole("button").map((b) => b.textContent)).toEqual(["Types: 2 activity types", "Plan: Adult Unlimited", "Done by: Jack Streeter", "Clear all"]);
    expect(screen.getByTestId("date-button").textContent).toBe("Yesterday");
    expect(screen.getByTestId("filters-button").textContent).toBe("Filters (3)");
    // The same choices are what the Filters sheet starts from.
    const sheet = openFilters();
    expect((within(sheet).getByLabelText("Plan") as HTMLSelectElement).value).toBe("t_adult");
    expect((within(sheet).getByLabelText("Done by") as HTMLSelectElement).value).toBe("");
    expect((within(sheet).getByLabelText("Staff member") as HTMLSelectElement).value).toBe("u_jack");
    expect(within(sheet).getByTestId("types-trigger").textContent).toBe("2 activity types");
  });

  it("a tab rewrites the address and asks again; nothing is kept anywhere else", async () => {
    renderPage();
    await loaded();
    fireEvent.click(tab("Money"));
    expect(window.location.search).toBe("?types=money");
    await waitFor(() => expect(activityCalls()).toHaveLength(2));
    expect(lastQuery().get("types")).toBe("money");
    // Back to the default: the address says nothing, because nothing needs saying.
    fireEvent.click(tab("Club activity"));
    expect(window.location.search).toBe("");
  });

  it("the views are a tab bar: one tab selected, one keyboard stop, arrow keys move and choose", async () => {
    renderPage();
    await loaded();
    const list = screen.getByRole("tablist", { name: "Views" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Club activity", "Attendance", "Money", "Staff changes", "Everything"]);
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual(["Club activity"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(window.location.search).toBe("?types=attendance");
    await waitFor(() => expect(tab("Attendance").getAttribute("aria-selected")).toBe("true"));
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[4]);
    expect(window.location.search).toBe("?types=all");
    fireEvent.keyDown(tabs[4], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    expect(window.location.search).toBe("");
  });

  it("a link inside the timeline to another filter is followed by the page itself", async () => {
    renderPage();
    await loaded();
    act(() => window.history.replaceState(null, "", "/dashboard/activity?userId=u_jack"));
    await waitFor(() => expect(lastQuery().get("userId")).toBe("u_jack"));
  });

  it("Filters is staged: Plan and Done by change nothing until Show activity, then land in the address together with one request", async () => {
    renderPage();
    await loaded();
    let sheet = openFilters();
    fireEvent.change(within(sheet).getByLabelText("Plan"), { target: { value: "t_adult" } });
    fireEvent.change(within(sheet).getByLabelText("Staff member"), { target: { value: "u_jack" } });
    expect(within(sheet).getByText("Activity that names this plan.")).toBeTruthy();
    expect(window.location.search).toBe("");
    // Escape leaves the page as it was.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull());
    expect(window.location.search).toBe("");
    sheet = openFilters();
    expect((within(sheet).getByLabelText("Plan") as HTMLSelectElement).value).toBe("");
    fireEvent.change(within(sheet).getByLabelText("Plan"), { target: { value: "t_adult" } });
    fireEvent.change(within(sheet).getByLabelText("Staff member"), { target: { value: "u_jack" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Show activity" }));
    expect(window.location.search).toBe("?tierId=t_adult&userId=u_jack");
    await waitFor(() => expect(activityCalls()).toHaveLength(2));
    expect([lastQuery().get("tierId"), lastQuery().get("userId")]).toEqual(["t_adult", "u_jack"]);
    expect(screen.getByTestId("filters-button").textContent).toBe("Filters (2)");
  });

  it("Done by offers Everyone, Staff, Members and Automatic — and MatFlow support for the owner only; the choice is in the address", async () => {
    renderPage();
    await loaded();
    let sheet = openFilters();
    const kinds = () => [...(within(sheet).getByLabelText("Done by") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(kinds()).toEqual(["Everyone", "Staff", "Members", "Automatic", "MatFlow support"]);
    // One staff member narrows within Staff; it is there for Everyone and Staff only.
    fireEvent.change(within(sheet).getByLabelText("Staff member"), { target: { value: "u_jack" } });
    fireEvent.change(within(sheet).getByLabelText("Done by"), { target: { value: "members" } });
    expect(within(sheet).queryByLabelText("Staff member")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Show activity" }));
    expect(window.location.search).toBe("?by=members");
    await waitFor(() => expect(lastQuery().get("by")).toBe("members"));
    expect(lastQuery().get("userId")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter: Done by: Members" })).toBeTruthy();
    expect(screen.getByTestId("filters-button").textContent).toBe("Filters (1)");
    sheet = openFilters();
    expect((within(sheet).getByLabelText("Done by") as HTMLSelectElement).value).toBe("members");
    fireEvent.change(within(sheet).getByLabelText("Done by"), { target: { value: "staff" } });
    fireEvent.change(within(sheet).getByLabelText("Staff member"), { target: { value: "u_jack" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Show activity" }));
    expect(window.location.search).toBe("?by=staff&userId=u_jack");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Done by: Staff" }));
    expect(window.location.search).toBe("?userId=u_jack");
  });

  it("a manager is not offered MatFlow support, and a link asking for it is not a filter for them", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?by=support");
    respond = () => ({ status: 200, body: body([entry()]) });
    renderPage("manager", "u_manager");
    await loaded();
    expect(lastQuery().get("by")).toBeNull();
    expect(screen.queryByRole("button", { name: /Done by: MatFlow support/ })).toBeNull();
    expect(screen.getByTestId("filters-button").textContent).toBe("Filters");
    const sheet = openFilters();
    const select = within(sheet).getByLabelText("Done by") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Everyone", "Staff", "Members", "Automatic"]);
    expect(select.value).toBe("");
  });

  it("the day button opens a sheet: Yesterday closes it, the day steps and a typed date keep it open, Today clears the day", async () => {
    renderPage();
    await loaded();
    expect(screen.getByRole("button", { name: "Day: Today" })).toBeTruthy();
    fireEvent.click(within(openDay()).getByRole("button", { name: "Yesterday" }));
    expect(window.location.search).toBe("?day=2026-11-04");
    expect(screen.queryByRole("dialog", { name: "Jump to date" })).toBeNull();
    expect(screen.getByTestId("date-button").textContent).toBe("Yesterday");
    const sheet = openDay();
    fireEvent.click(within(sheet).getByRole("button", { name: "Previous day" }));
    expect(window.location.search).toBe("?day=2026-11-03");
    expect(screen.getByTestId("date-button").textContent).toBe("Tue 3 Nov");
    fireEvent.change(within(sheet).getByLabelText("Jump to date"), { target: { value: "2026-10-01" } });
    expect(window.location.search).toBe("?day=2026-10-01");
    expect(screen.getByRole("dialog", { name: "Jump to date" })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Today" }));
    expect(window.location.search).toBe("");
    expect((within(openDay()).getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the day button does nothing until the club's day is known, and keeps a typed date inside the year the log holds", async () => {
    let release: (answer: { status: number; body: unknown }) => void = () => {};
    respond = () => new Promise((resolve) => (release = resolve));
    renderPage();
    await waitFor(() => expect(activityCalls()).toHaveLength(1));
    // Before the first answer the button is drawn, in place, and inert.
    expect((screen.getByTestId("date-button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release({ status: 200, body: body([entry()]) });
      await Promise.resolve();
    });
    await loaded();
    const sheet = openDay();
    const date = within(sheet).getByLabelText("Jump to date") as HTMLInputElement;
    expect([date.min, date.max]).toEqual(["2025-11-05", "2026-11-05"]);
    // Earlier than the log reaches: the first day it holds. Later than today: today, which is no day at all.
    fireEvent.change(date, { target: { value: "2020-01-01" } });
    expect(window.location.search).toBe("?day=2025-11-05");
    expect((within(sheet).getByRole("button", { name: "Previous day" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(date, { target: { value: "2030-01-01" } });
    expect(window.location.search).toBe("");
    // Half a date is not a choice.
    fireEvent.change(date, { target: { value: "" } });
    expect(window.location.search).toBe("");
  });

  it("'Clear all' only appears when something is filtered, and clears it all but the tab", async () => {
    renderPage();
    await loaded();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    // A tab is what is being looked at, not a filter.
    fireEvent.click(tab("Money"));
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    act(() => window.history.replaceState(null, "", "/dashboard/activity?types=money&tierId=t_adult&memberId=m_mel&day=2026-11-03"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(window.location.search).toBe("?types=money");
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    // A date alone is enough to offer it.
    act(() => window.history.replaceState(null, "", "/dashboard/activity?day=2026-11-03"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy());
  });

  it("no Copy link, no Reset filters, no Show all activity types: one way to do each thing", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=money&tierId=t_adult");
    respond = () => ({ status: 200, body: body([entry()]) });
    renderPage();
    await loaded();
    const sheet = openFilters();
    for (const name of [/copy link/i, /reset filters/i, /show all activity types/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
      expect(within(sheet).queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByText(/Undo puts the recorded details back/)).toBeNull();
  });

  it("says what a link left out, and when a date was before the log began", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=checkin,bogus,staff&day=2020-01-01");
    respond = () => ({ status: 200, body: body([], { clock: { timeZone: "Europe/London", todayKey: "2026-11-05", minDayKey: "2025-11-05", clamped: true }, filters: { types: { view: null, keys: ["checkin"] }, member: null, class: null, payment: null, tier: null, staff: null, dayKey: "2025-11-05" } }) });
    renderPage("manager", "u_manager");
    await loaded();
    // Only what this person may see is asked for; what was left out is said by the page, not learnt from the answer.
    expect(lastQuery().get("types")).toBe("checkin");
    expect(screen.getByText("This link included activity types that no longer exist.")).toBeTruthy();
    expect(screen.getByText("Some activity types in this link are only visible to the owner.")).toBeTruthy();
    expect(screen.getByText(/nothing to show before 5 Nov 2025/)).toBeTruthy();
  });

  it("a class or payment that arrived by link is a chip that can be taken off", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?classId=c1&types=all");
    respond = () => ({ status: 200, body: body([entry()], { filters: { types: { view: "all", keys: [] }, member: null, class: { id: "c1", name: "Advanced No-Gi" }, payment: null, tier: null, staff: null, dayKey: null } }) });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Advanced No-Gi" }));
    expect(window.location.search).toBe("?types=all");
  });
});

describe("activity types", () => {
  /** Opens Filters, then the types sheet on top of it. */
  const openTypes = () => {
    const filtersSheet = openFilters();
    fireEvent.click(within(filtersSheet).getByTestId("types-trigger"));
    return { filtersSheet, sheet: screen.getByRole("dialog", { name: "Activity types" }) };
  };

  it("ticks are staged twice over: nothing is asked until Done and then Show activity, and Cancel changes nothing", async () => {
    renderPage();
    await loaded();
    let { filtersSheet, sheet } = openTypes();
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Refund" }));
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Check-in" }));
    expect(activityCalls()).toHaveLength(1);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Activity types" })).toBeNull();
    expect(within(filtersSheet).getByTestId("types-trigger").textContent).toBe("Club activity");

    fireEvent.click(within(filtersSheet).getByTestId("types-trigger"));
    sheet = screen.getByRole("dialog", { name: "Activity types" });
    // Reopened from what Filters holds, not from the abandoned ticks.
    expect(within(sheet).getByRole("checkbox", { name: "Refund" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Refund" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    expect(within(filtersSheet).getByTestId("types-trigger").textContent).toBe(`${defaultTypeKeys("owner").length - 1} activity types`);
    expect(window.location.search).toBe("");
    expect(activityCalls()).toHaveLength(1);
    fireEvent.click(within(filtersSheet).getByRole("button", { name: "Show activity" }));
    await waitFor(() => expect(activityCalls()).toHaveLength(2));
    const asked = lastQuery().get("types")!.split(",");
    expect(asked).not.toContain("refund");
    expect(asked).toContain("checkin");
    ({ filtersSheet } = { filtersSheet: openFilters() });
    expect(within(filtersSheet).getByTestId("types-trigger").textContent).toBe(`${defaultTypeKeys("owner").length - 1} activity types`);
  });

  it("a group box ticks or clears its whole group and shows a dash when the group is partly ticked", async () => {
    renderPage();
    await loaded();
    const { sheet } = openTypes();
    const group = () => within(sheet).getByRole("checkbox", { name: "Attendance: all" });
    expect(group().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Check-in removed" }));
    expect(group().getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(group());
    expect(group().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(group());
    expect(group().getAttribute("aria-checked")).toBe("false");
    expect(within(sheet).getByRole("checkbox", { name: "Check-in" }).getAttribute("aria-checked")).toBe("false");
  });

  it("nothing ticked cannot be applied, and says why", async () => {
    renderPage();
    await loaded();
    const { filtersSheet, sheet } = openTypes();
    for (const name of ["Attendance: all", "Members: all", "Memberships & money: all", "Classes: all", "Communication: all", "Staff & club: all"]) {
      const box = within(sheet).getByRole("checkbox", { name });
      if (box.getAttribute("aria-checked") !== "true") fireEvent.click(box);
      fireEvent.click(within(sheet).getByRole("checkbox", { name }));
    }
    expect(within(sheet).getByTestId("types-count").textContent).toBe(`0 of ${ACTIVITY_TYPES.length} selected`);
    expect((within(sheet).getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(sheet).getByText("Choose at least one activity type")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Everything" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    fireEvent.click(within(filtersSheet).getByRole("button", { name: "Show activity" }));
    expect(window.location.search).toBe("?types=all");
  });
});

describe("a person's own default view", () => {
  const save = (userId: string, value: unknown) => window.localStorage.setItem(storedDefaultKey(userId), JSON.stringify(value));
  const known = ACTIVITY_TYPES.map((t) => t.key);

  it("opens on the saved view with a single request", async () => {
    save(OWNER, { v: 1, view: "money", known });
    renderPage();
    await loaded();
    expect(activityCalls()).toHaveLength(1);
    expect(lastQuery().get("types")).toBe("money");
    expect(tab("Money").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toBe("");
  });

  it("the address beats it; someone else's saved view is not read", async () => {
    save(OWNER, { v: 1, view: "money", known });
    window.history.replaceState(null, "", "/dashboard/activity?types=attendance");
    const first = renderPage();
    await loaded();
    expect(lastQuery().get("types")).toBe("attendance");
    first.unmount();
    calls = [];
    window.history.replaceState(null, "", "/dashboard/activity");
    renderPage("manager", "u_manager");
    await loaded();
    expect(lastQuery().get("types")).toBe("club");
  });

  it("Make this my default, in the Filters footer, saves it for this person on this device, and Use MatFlow's default drops it", async () => {
    renderPage();
    await loaded();
    // At the default there is nothing to save.
    let sheet = openFilters();
    expect(within(sheet).queryByRole("button", { name: "Make this my default" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull());
    fireEvent.click(tab("Attendance"));
    sheet = openFilters();
    fireEvent.click(within(sheet).getByRole("button", { name: "Make this my default" }));
    expect(h.toasts.at(-1)).toEqual({ message: "Saved. Activity will open like this on this device.", type: "success" });
    expect(JSON.parse(window.localStorage.getItem(storedDefaultKey(OWNER))!)).toMatchObject({ v: 1, view: "attendance" });
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    await waitFor(() => expect(tab("Attendance").getAttribute("aria-selected")).toBe("true"));
    sheet = openFilters();
    fireEvent.click(within(sheet).getByRole("button", { name: "Use MatFlow's default" }));
    expect(window.localStorage.getItem(storedDefaultKey(OWNER))).toBeNull();
    await waitFor(() => expect(tab("Club activity").getAttribute("aria-selected")).toBe("true"));
  });

  it("says so when the device will not keep it, and carries on working", async () => {
    renderPage();
    await loaded();
    fireEvent.click(tab("Attendance"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const sheet = openFilters();
    fireEvent.click(within(sheet).getByRole("button", { name: "Make this my default" }));
    expect(h.toasts.at(-1)).toEqual({ message: "Couldn't save on this device.", type: "error" });
    expect(window.location.search).toBe("?types=attendance");
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
  });
});

describe("what is drawn when there is nothing, or something went wrong", () => {
  it("nothing at all, with nothing filtered and everything shown: no button", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    renderPage();
    await waitFor(() => expect(screen.getByText("Nothing has been recorded yet.", { ignore: STATUS })).toBeTruthy());
    // Said once on the page and once to a screen reader, in the same words.
    expect(screen.getByTestId("activity-status").textContent).toBe("Nothing has been recorded yet.");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("nothing for these filters: says which, and offers exactly one way out, which clears everything including the date", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=refund&userId=u_jack&day=2026-11-03");
    renderPage();
    await waitFor(() => expect(screen.getByText("Nothing matches these filters.", { ignore: STATUS })).toBeTruthy());
    expect(screen.getByTestId("activity-status").textContent).toBe("Nothing matches these filters.");
    expect(screen.getByText("Refund · done by Jack Streeter · up to 3 Nov 2026", { selector: "p" })).toBeTruthy();
    const empty = screen.getByText("Nothing matches these filters.", { ignore: STATUS }).parentElement!.parentElement!;
    expect(within(empty).getAllByRole("button").map((b) => b.textContent)).toEqual(["Clear filters"]);
    fireEvent.click(within(empty).getByRole("button", { name: "Clear filters" }));
    expect(window.location.search).toBe("");
  });

  it("a failed first page is an error with a retry that sends one request — never an empty list", async () => {
    respond = () => ({ status: 500, body: { error: "Couldn't load activity.", reference: "MF-ABC123" } });
    renderPage();
    await waitFor(() => expect(screen.getByText("Couldn't load activity.")).toBeTruthy());
    expect(screen.queryByText(/Nothing/)).toBeNull();
    respond = () => ({ status: 200, body: body([entry()]) });
    fireEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    await loaded();
    expect(activityCalls()).toHaveLength(2);
  });

  it("names that could not be loaded: the rows are still there, with a notice", async () => {
    respond = () => ({ status: 200, body: body([entry({ parts: [{ text: "Member checked themselves in" }], plain: "Member checked themselves in" })], { enriched: false }) });
    renderPage();
    await loaded();
    expect(screen.getByText("Names couldn't be loaded, so this is the plain log.")).toBeTruthy();
    expect(within(table()).getByText("Member checked themselves in")).toBeTruthy();
  });

  it("Show older appends, announces how many, and a failure keeps the rows with a way to try again", async () => {
    respond = (call) => (call.url.includes("cursor=") ? { status: 500, body: { error: "x" } } : { status: 200, body: body([entry({ id: "a1" }), entry({ id: "a2" })], { nextCursor: "a2" }) });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Show older" }));
    await waitFor(() => expect(screen.getByText("Couldn't load older activity")).toBeTruthy());
    expect(table().querySelectorAll("tbody tr:not([data-section])")).toHaveLength(2);
    respond = () => ({ status: 200, body: body([entry({ id: "a3" })], { nextCursor: null }) });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(table().querySelectorAll("tbody tr:not([data-section])")).toHaveLength(3));
    expect(screen.getByTestId("activity-status").textContent).toBe("1 more loaded");
    // The first new row takes the focus (its first link), so a keyboard carries on from there — the button has gone.
    expect(document.activeElement?.closest("[data-entry-id]")?.getAttribute("data-entry-id")).toBe("a3");
    expect(document.activeElement?.tagName).toBe("A");
    expect(screen.getByText("That's everything. Activity is kept for one year.")).toBeTruthy();
    expect(new URL(activityCalls().at(-1)!.url, "http://x").searchParams.get("cursor")).toBe("a2");
  });
});

describe("undo (owner)", () => {
  const reversible = (over: Partial<FeedEntry> = {}) => entry({ type: "member_updated", plain: "Jack Streeter updated Melody Orekoya's details", parts: [{ text: "Jack Streeter updated Melody Orekoya's details" }], undo: { ok: true, sinceHere: { userId: "u_jack", name: "Jack Streeter" } }, ...over });

  it("'Since here' is offered only when the page hides nothing", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    respond = () => ({ status: 200, body: body([reversible({ id: "r1" })]) });
    renderPage();
    await loaded();
    expect(within(table()).getByRole("button", { name: /^Since here: undo everything Jack Streeter did since/ })).toBeTruthy();
    for (const narrowed of ["?types=all&memberId=m_mel", "?types=all&day=2026-11-04", "?types=club", "?types=all&classId=c1"]) {
      act(() => window.history.replaceState(null, "", `/dashboard/activity${narrowed}`));
      await waitFor(() => expect(within(table()).queryByRole("button", { name: /^Since here/ })).toBeNull());
      expect(within(table()).getByRole("button", { name: /^Undo: / })).toBeTruthy();
    }
  });

  it("undoing a row asks first, names it, explains what Undo does, and strikes it through where it is", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    // After the undo the page asks for page one again, and here that answer never comes: the row is struck through anyway.
    let undone = false;
    respond = (call) => {
      if (call.method === "POST") {
        undone = true;
        return { status: 200, body: { ok: true, message: "Undone." } };
      }
      if (undone) return new Promise(() => {});
      return { status: 200, body: body([reversible({ id: "r1" }), entry({ id: "r2" })]) };
    };
    renderPage();
    await loaded();
    fireEvent.click(within(table()).getByRole("button", { name: "Undo: Jack Streeter updated Melody Orekoya's details" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Undo: Jack Streeter updated Melody Orekoya's details?")).toBeTruthy();
    // The explanation that used to sit above the list is here, where it applies.
    expect(dialog.textContent).toContain("Linked records it created or removed alongside (a booking, rank history, a Stripe change, an email) are not changed.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo this" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/audit-log/r1/undo")).toBe(true));
    await waitFor(() => expect(within(table()).getAllByText("Undone").length).toBeGreaterThan(0));
    expect(within(table()).getByText("Jack Streeter updated Melody Orekoya's details").className).toContain("line-through");
    expect(h.toasts.at(-1)).toEqual({ message: "Undone.", type: "success" });
    expect(within(table()).queryByRole("button", { name: /^Undo: Jack/ })).toBeNull();
    expect(window.location.search).toBe("?types=all");
  });

  it("a row that cannot be undone shows nothing in the Undo column, in the table or on the card", async () => {
    respond = () => ({ status: 200, body: body([entry({ id: "r1", undo: { ok: false, reason: "Money moved — reverse it from Payments (refund), not from here." } })]) });
    renderPage();
    await loaded();
    expect(screen.queryByText(/Can't undo/)).toBeNull();
    expect(screen.queryByText(/Money moved/)).toBeNull();
    const tr = table().querySelector("tbody tr:not([data-section])")!;
    expect(tr.querySelectorAll("td")[2].textContent).toBe("");
    expect(within(screen.getAllByTestId("activity-card")[0]).queryByRole("button")).toBeNull();
  });

  it("'Since here' lists what will be put back, with times and sentences, before anything is undone", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    let allUndone = false;
    respond = (call) => {
      if (call.url === "/api/audit-log/undo-to") {
        if ((call.body as { preview: boolean }).preview) return { status: 200, body: { reversible: [{ id: "r1", action: "member.update", createdAt: "2026-11-05T19:45:00.000Z" }, { id: "not-loaded", action: "class.updated", createdAt: "2026-11-05T19:50:00.000Z" }], skipped: [{ id: "s1", action: "payment.manual", createdAt: "2026-11-05T19:55:00.000Z", reason: "Money moved." }] } };
        allUndone = true;
        return { status: 200, body: { ok: true, undone: ["r1", "not-loaded"] } };
      }
      return { status: 200, body: body([allUndone ? reversible({ id: "r1", undone: true, undo: { ok: false, reason: "Already undone." } }) : reversible({ id: "r1" })]) };
    };
    renderPage();
    await loaded();
    fireEvent.click(within(table()).getByRole("button", { name: /^Since here: undo everything Jack Streeter did since/ }));
    const plan = await screen.findByTestId("undo-plan");
    expect(plan.textContent).toContain("19:45 Jack Streeter updated Melody Orekoya's details");
    expect(plan.textContent).toContain("19:50 Updated a class");
    expect(plan.textContent).toContain("Recorded a payment at the desk — Money moved.");
    expect(screen.getByText(/This covers everything Jack Streeter has done across the club since/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo 2 changes" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/audit-log/undo-to")).toHaveLength(2));
    const sent = calls.filter((c) => c.url === "/api/audit-log/undo-to")[1].body as { expectedIds: string[]; userId: string; auditId: string; preview: boolean };
    expect(sent).toEqual({ userId: "u_jack", auditId: "r1", preview: false, expectedIds: ["r1", "not-loaded"] });
    await waitFor(() => expect(within(table()).getAllByText("Undone").length).toBeGreaterThan(0));
  });

  it("an undo the server refuses stops being offered", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    respond = (call) => (call.method === "POST" ? { status: 409, body: { error: "Already undone." } } : { status: 200, body: body([reversible({ id: "r1" })]) });
    renderPage();
    await loaded();
    fireEvent.click(within(table()).getByRole("button", { name: /^Undo: / }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Undo this" }));
    await waitFor(() => expect(within(table()).queryByRole("button", { name: /^Undo: / })).toBeNull());
    expect(h.toasts.at(-1)).toEqual({ message: "Already undone.", type: "error" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(screen.getAllByTestId("activity-card")[0]).queryByRole("button", { name: /^Undo: / })).toBeNull();
    // Not struck through: nothing here was undone by this person.
    expect(within(table()).queryByText("Undone")).toBeNull();
  });

  it("a 'Since here' answer that arrives after its dialog was closed does not bring the dialog back", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    let release: (answer: { status: number; body: unknown }) => void = () => {};
    respond = (call) => (call.url === "/api/audit-log/undo-to" ? new Promise((resolve) => (release = resolve)) : { status: 200, body: body([reversible({ id: "r1" })]) });
    renderPage();
    await loaded();
    fireEvent.click(within(table()).getByRole("button", { name: /^Since here/ }));
    expect(screen.getByText("Working out what can be put back…")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      release({ status: 200, body: { reversible: [{ id: "r1", action: "member.update", createdAt: "2026-11-05T19:45:00.000Z" }], skipped: [] } });
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the dialog's title says since when, not 'since here'", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    respond = (call) => (call.url === "/api/audit-log/undo-to" ? { status: 200, body: { reversible: [], skipped: [] } } : { status: 200, body: body([reversible({ id: "r1" })]) });
    renderPage();
    await loaded();
    fireEvent.click(within(table()).getByRole("button", { name: /^Since here/ }));
    // The date as well as the time: "since 19:45" on a row from last week would read as today.
    expect(await screen.findByRole("dialog", { name: "Undo everything Jack Streeter did since 5 Nov 2026, 19:45?" })).toBeTruthy();
  });

  it("when the list of what can be put back cannot be worked out, the dialog says so and offers nothing to confirm", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?types=all");
    respond = (call) => (call.url === "/api/audit-log/undo-to" ? { status: 500, body: { error: "Couldn't work that out just now." } } : { status: 200, body: body([reversible({ id: "r1" })]) });
    renderPage();
    await loaded();
    fireEvent.click(within(table()).getByRole("button", { name: /^Since here/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("Couldn't work that out just now.")).toBeTruthy());
    expect((within(dialog).getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter((c) => c.url === "/api/audit-log/undo-to")).toHaveLength(1);
  });
});

describe("a link that has been mangled, and words that mean one thing", () => {
  it("a day that is not a date and an id that is not an id are not filters", async () => {
    window.history.replaceState(null, "", "/dashboard/activity?day=abc&memberId=a%20b");
    respond = () => ({ status: 200, body: body([entry()]) });
    renderPage();
    await loaded();
    expect([lastQuery().get("day"), lastQuery().get("memberId")]).toEqual([null, null]);
    expect(table().querySelector("caption")!.textContent).toBe("Activity: Club activity");
    expect(screen.queryByTestId("member-picked")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    // The day controls still work from today.
    fireEvent.click(within(openDay()).getByRole("button", { name: "Previous day" }));
    expect(new URLSearchParams(window.location.search).get("day")).toBe("2026-11-04");
  });

  it("the rows are marked busy while different filters load, and the status says what the page says when there is nothing", async () => {
    let hold = false;
    respond = () => (hold ? new Promise(() => {}) : { status: 200, body: body([entry()]) });
    renderPage();
    await loaded();
    hold = true;
    fireEvent.click(tab("Money"));
    await waitFor(() => expect(table().closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("true"));
    // The rows for the old filters are still there, dimmed, not swapped for an empty list.
    expect(within(table()).getByText("Melody Orekoya")).toBeTruthy();
    expect(screen.getByTestId("activity-status").textContent).toBe("");
  });

  it("a picked member is named at once, before the server has answered", async () => {
    let hold = false;
    respond = (call) => {
      if (call.url.startsWith("/api/members")) return { status: 200, body: { members: [{ id: "m_mel", name: "Melody Orekoya", email: "mel@example.test", status: "active" }] } };
      return hold ? new Promise(() => {}) : { status: 200, body: body([entry()]) };
    };
    renderPage();
    await loaded();
    hold = true;
    const field = screen.getByRole("combobox", { name: "Search members" });
    expect(field.getAttribute("placeholder")).toBe("Search members…");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "mel" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /Melody Orekoya/ }));
    expect(window.location.search).toBe("?memberId=m_mel");
    expect(screen.getByTestId("member-picked").textContent).toContain("Melody Orekoya");
    expect(screen.getByRole("button", { name: "Clear member filter: Melody Orekoya" })).toBeTruthy();
    // What was typed never reaches the address.
    expect(window.location.href).not.toContain("mel@");
  });
});

describe("embedded in a record's page", () => {
  it("asks for everything about that record, a few rows, no undo — whatever is saved or in the address", async () => {
    window.localStorage.setItem(storedDefaultKey(OWNER), JSON.stringify({ v: 1, view: "money", known: [] }));
    window.history.replaceState(null, "", "/dashboard/members/m_mel?types=attendance&memberId=someone-else");
    respond = () => ({ status: 200, body: body([entry({ id: "h1" }), entry({ id: "h2", at: "2026-11-04T10:00:00.000Z", dayKey: "2026-11-04" })]) });
    render(<ActivityTimeline variant="embedded" role="owner" scope={{ kind: "member", id: "m_mel" }} take={20} />);
    await waitFor(() => expect(screen.getAllByTestId("activity-card")).toHaveLength(2));
    expect(activityCalls()).toHaveLength(1);
    expect(activityCalls()[0].url).toBe("/api/activity?types=all&memberId=m_mel&take=20&embed=1");
    // Cards at every width, each with its day; no filter bar, no undo.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByTestId("activity-card")[1].textContent).toContain("Wed 4 Nov, 10:00");
    expect(screen.queryByTestId("activity-filters")).toBeNull();
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(screen.getByRole("link", { name: "See all activity" }).getAttribute("href")).toBe("/dashboard/activity?memberId=m_mel&types=all");
    expect(window.location.search).toBe("?types=attendance&memberId=someone-else");
  });

  it("a class and a payment each ask for their own history", async () => {
    render(<ActivityTimeline variant="embedded" role="manager" scope={{ kind: "class", id: "c1" }} take={10} />);
    await waitFor(() => expect(activityCalls()).toHaveLength(1));
    expect(activityCalls()[0].url).toBe("/api/activity?types=all&classId=c1&take=10&embed=1");
    cleanup();
    calls = [];
    render(<ActivityTimeline variant="embedded" role="owner" scope={{ kind: "payment", id: "p1" }} />);
    await waitFor(() => expect(activityCalls()).toHaveLength(1));
    expect(activityCalls()[0].url).toBe("/api/activity?types=all&paymentId=p1&take=20&embed=1");
  });

  it("an error is an error and nothing is nothing", async () => {
    respond = () => ({ status: 500, body: { error: "Couldn't load activity." } });
    const failed = render(<ActivityTimeline variant="embedded" role="owner" scope={{ kind: "member", id: "m_mel" }} />);
    await waitFor(() => expect(screen.getByText("Couldn't load activity.")).toBeTruthy());
    failed.unmount();
    respond = () => ({ status: 200, body: body([]) });
    render(<ActivityTimeline variant="embedded" role="owner" scope={{ kind: "member", id: "m_mel" }} />);
    await waitFor(() => expect(screen.getByText("Nothing recorded for this member yet.")).toBeTruthy());
    expect(screen.getByRole("link", { name: "See all activity" })).toBeTruthy();
  });
});
