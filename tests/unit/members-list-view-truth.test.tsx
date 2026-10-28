// @vitest-environment jsdom
//
// Review fixes on T1 (17 Oct 2026). The Members page opens on Active, so:
// - a member added under a status the current view hides moves the view to
//   one that lists them (a new taster no longer vanishes after the sheet
//   closes, which read as a failed save);
// - a search on Active chosen on purpose stays inside Active, so the rows
//   under the chip still match its count; only the untouched landing view
//   searches everyone, and a notice says so;
// - the two Reports drill-through slices name themselves in the header and
//   count their own rows instead of claiming "N current members".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";

let currentSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => "/dashboard/members",
}));
const toastSpy = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import MembersList, { inStatusView, viewShowingNewMember, type MemberRow } from "@/components/dashboard/MembersList";

const now = new Date();
const thisMonth = new Date(now.getFullYear(), now.getMonth(), 10).toISOString();
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10).toISOString();

function member(overrides: Partial<MemberRow> & { id: string; name: string }): MemberRow {
  return { email: `${overrides.id}@example.test`, status: "active", joinedAt: lastMonth, ...overrides };
}

const CLUB: MemberRow[] = [
  member({ id: "a1", name: "Ava Active" }),
  // D11: `moved` is the server's movement flag for this month (lib/membership-report loadMonthMovers).
  member({ id: "a2", name: "Ben Active", joinedAt: thisMonth, moved: ["new"] }),
  member({ id: "i1", name: "Ivy Inactive", status: "inactive" }),
  member({ id: "t1", name: "Tom Taster", status: "taster", joinedAt: thisMonth, moved: ["tasterAdded"] }),
  member({ id: "c1", name: "Cy Cancelled", status: "cancelled", joinedAt: thisMonth, cancelledAt: thisMonth, moved: ["new", "lost", "cancelled"] }),
  member({ id: "c2", name: "Di Cancelled", status: "cancelled", cancelledAt: lastMonth }),
  member({ id: "g1", name: "Gus Guardian", accountType: "parent" }),
];

const shown = (name: string) => screen.queryAllByText(name).length > 0;
const headline = () => screen.getByTestId("members-headline").textContent;
const scope = () => screen.getByTestId("members-headline-scope").textContent ?? "";

beforeEach(() => {
  toastSpy.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("view predicate", () => {
  it("a taster or inactive member is outside Active; the view to show them is named", () => {
    expect(inStatusView({ status: "taster" }, "active")).toBe(false);
    expect(viewShowingNewMember({ status: "taster" }, "active")).toBe("taster");
    expect(viewShowingNewMember({ status: "inactive" }, "active")).toBe("all");
    expect(viewShowingNewMember({ status: "active", accountType: "parent" }, "active")).toBe("guardians");
    expect(viewShowingNewMember({ status: "active" }, "active")).toBeNull();
    expect(viewShowingNewMember({ status: "taster" }, "all")).toBeNull();
  });
});

describe("adding a taster from the Active landing view", () => {
  it("moves the view to Tasters, lists the new row and says where it is", async () => {
    currentSearch = "";
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/memberships")) {
        return new Response(JSON.stringify({ tiers: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init?.method === "POST" && u.endsWith("/api/members")) {
        return new Response(
          JSON.stringify({ id: "t-new", name: "Tess Taster", email: "tess@example.test", status: "taster", inviteEmailSent: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    }));

    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getByRole("button", { name: "Active · 2" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getAllByRole("button", { name: /Add member/i })[0]);
    fireEvent.change(await screen.findByLabelText("Full Name"), { target: { value: "Tess Taster" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "taster" } });
    const submits = screen.getAllByRole("button", { name: /Add member/i });
    fireEvent.click(submits[submits.length - 1]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Tasters · 2" }).getAttribute("aria-pressed")).toBe("true"));
    expect(shown("Tess Taster")).toBe(true);
    expect(toastSpy).toHaveBeenCalledWith("Tess Taster is listed under Tasters", "info");
  });
});

describe("search scope on Active", () => {
  it("Active reached by the Reports drill-through: a search stays inside Active", () => {
    currentSearch = "filter=active";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "cancelled" } });
    expect(shown("Cy Cancelled")).toBe(false);
    expect(screen.queryByTestId("members-search-scope")).toBeNull();
  });

  it("Active chosen by a chip click: a search stays inside Active", () => {
    currentSearch = "filter=all";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "Active · 2" }));
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "tom" } });
    expect(shown("Tom Taster")).toBe(false);
  });

  it("untouched landing view: a search looks at everyone and says so", () => {
    currentSearch = "";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "cancelled" } });
    expect(shown("Cy Cancelled")).toBe(true);
    expect(screen.getByTestId("members-search-scope").textContent).toContain("including cancelled members and guardians");
  });
});

describe("Reports drill-through slices name themselves", () => {
  it("churned-this-month: the header counts every cancellation this month, joiners included (owner decision, 27 Oct 2026)", () => {
    currentSearch = "filter=churned-this-month";
    // Ed was a member before this month and cancelled in it; Cy joined AND cancelled this month: both are churn.
    const ed = member({ id: "c3", name: "Ed Earlier", status: "cancelled", joinedAt: lastMonth, cancelledAt: thisMonth, moved: ["lost", "cancelled"] });
    render(<MembersList members={[...CLUB, ed]} primaryColor="#3b82f6" role="owner" />);
    expect(headline()).toBe("2 cancelled this month");
    expect(shown("Ed Earlier")).toBe(true);
    expect(shown("Cy Cancelled")).toBe(true);
    expect(scope()).toContain("including people who joined this month");
    expect(scope()).toContain("finished prepaid courses (those are in Left)");
    expect(scope()).not.toContain("Excludes cancelled members");
    expect(screen.getByTestId("members-tile-headline").querySelector("p")!.textContent).toBe("2");
  });

  it("new-this-month (D11): the header counts first starts by the movement definition, since-cancelled included, tasters apart", () => {
    currentSearch = "filter=new-this-month";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    expect(headline()).toBe("2 new this month");
    expect(scope()).toContain("first ever start");
    expect(scope()).toContain("including any since cancelled");
    for (const name of ["Ben Active", "Cy Cancelled"]) expect(shown(name)).toBe(true);
    expect(shown("Tom Taster")).toBe(false);
  });

  it("tasters-this-month (D11): the taster added is listed on its own", () => {
    currentSearch = "filter=tasters-this-month";
    render(<MembersList members={CLUB} primaryColor="#3b82f6" role="owner" />);
    expect(headline()).toBe("1 tasters added this month");
    expect(shown("Tom Taster")).toBe(true);
    expect(shown("Ben Active")).toBe(false);
  });
});
