// @vitest-environment jsdom
//
// Operator hub, Tenants list: a "Closed clubs" view (17 Oct 2026). A club
// soft-deleted from its Danger zone used to vanish from the hub entirely; the
// operator needed its direct URL to find it. The default view still excludes
// closed clubs at the query; ?view=closed lists only them with the closure date
// and a link to the existing details page; closure stays separate from the
// subscription status; opening a closed club's page changes nothing.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { formatDate } from "@/lib/date";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/tenants",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => ({ id: "c1" }),
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("@/app/admin/AdminTopNav", () => ({ default: () => null }));

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/admin-auth", () => ({ isAdminPageAuthed: async () => auth.ok }));

// A fake database: two open clubs and two closed ones, closure dates relative to
// today (the details page applies the real-clock restore window). Records every
// call and throws on anything that is not a read.
const db = vi.hoisted(() => {
  const DAY = 86400000;
  const now = Date.now();
  const D = (s: string) => new Date(s);
  const owner = (id: string) => [{ id: `u-${id}`, email: `${id}@example.test`, name: `Owner ${id}`, totpEnabled: true, lockedUntil: null, loginEmailProvisionalSince: null }];
  const tenants = [
    { id: "o1", name: "Open One", slug: "open-one", subscriptionStatus: "active", deletedAt: null, createdAt: D("2026-09-01") },
    { id: "o2", name: "Open Two", slug: "open-two", subscriptionStatus: "trial", deletedAt: null, createdAt: D("2026-09-02") },
    { id: "c1", name: "Closed Club", slug: "closed-club", subscriptionStatus: "trial", deletedAt: new Date(now - 1 * DAY), createdAt: D("2026-08-15") },
    { id: "c2", name: "Aged Closed", slug: "aged-closed", subscriptionStatus: "active", deletedAt: new Date(now - 5 * DAY), createdAt: D("2026-09-20") },
  ].map((t) => ({
    ...t, stripeConnected: false, stripeAccountStatus: null, onboardingCompleted: true, subscriptionTier: "starter",
    currency: "GBP", country: "GB", purgeStartedAt: null, reviewLockedAt: null, stripeAccountId: null,
    users: owner(t.id), _count: { members: 2, classes: 1 },
  }));
  const calls: { method: string; args: unknown }[] = [];
  const matches = (t: { deletedAt: Date | null }, where?: { deletedAt?: unknown }) =>
    where?.deletedAt === null ? t.deletedAt === null
      : where?.deletedAt && typeof where.deletedAt === "object" ? t.deletedAt !== null
      : true;
  const byOrder = (orderBy?: { deletedAt?: string; createdAt?: string }) => (a: (typeof tenants)[number], b: (typeof tenants)[number]) =>
    orderBy?.deletedAt ? +(b.deletedAt ?? 0) - +(a.deletedAt ?? 0) : +b.createdAt - +a.createdAt;
  const tenant = new Proxy({} as Record<string, unknown>, {
    get(_, method: string) {
      return async (args: { where?: { id?: string; deletedAt?: unknown }; orderBy?: { deletedAt?: string } }) => {
        calls.push({ method, args });
        if (method === "findMany") return tenants.filter((t) => matches(t, args?.where)).sort(byOrder(args?.orderBy));
        if (method === "count") return tenants.filter((t) => matches(t, args?.where)).length;
        if (method === "findUnique") return tenants.find((t) => t.id === args?.where?.id) ?? null;
        throw new Error(`write attempted: tenant.${method}`);
      };
    },
  });
  // Active (ACTIVE_MEMBER) members per club: 1 of the 2 member rows each.
  const member = {
    groupBy: async (args: { by: string[]; where: { tenantId: { in: string[] } } }) => {
      calls.push({ method: "groupBy", args });
      return args.where.tenantId.in.map((tenantId) => ({ tenantId, _count: { _all: 1 } }));
    },
  };
  return { tenants, calls, tx: new Proxy({ tenant, member } as Record<string, unknown>, {
    get(target, model: string) {
      if (model in target) return target[model];
      return new Proxy({}, { get: (_, method: string) => () => { throw new Error(`unexpected ${model}.${method}`); } });
    },
  }) };
});
vi.mock("@/lib/prisma-tenant", () => ({ withRlsBypass: async (fn: (tx: unknown) => unknown) => fn(db.tx) }));

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
beforeEach(() => {
  auth.ok = true;
  db.calls.length = 0;
  window.history.replaceState(null, "", "/admin/tenants");
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  vi.restoreAllMocks();
});

async function renderList(params: Record<string, string | string[]> = {}) {
  // The browser's URL matches what the server was asked for.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) qs.append(k, x);
  window.history.replaceState(null, "", `/admin/tenants${qs.toString() ? `?${qs}` : ""}`);
  const { default: Page } = await import("@/app/admin/tenants/page");
  const element = await Page({ searchParams: Promise.resolve(params) });
  return render(element);
}
const findManyArgs = () => db.calls.find((c) => c.method === "findMany")?.args as { where: unknown; orderBy: unknown };
const closed = (id: string) => db.tenants.find((t) => t.id === id)!;
const rowNames = () => screen.getAllByRole("row").slice(1).map((r) => r.querySelector("td div")?.textContent);

/** The tenants CSV header row as it was before this change (main c5a74c0). */
const OPEN_CSV_HEADER = "Gym,Slug,Owner Name,Owner Email,Members,Status,Stripe Connected,Stripe Charges Enabled,Onboarding Completed,Created";
/** The same header with the separate ACTIVE_MEMBER column straight after "Members". */
const WITH_ACTIVE_HEADER = OPEN_CSV_HEADER.replace("Owner Email,Members,", "Owner Email,Members,Active members,");

/** Captures the CSV the Export button builds, restoring the mocks afterwards (afterEach). */
function captureCsv() {
  const out = { text: Promise.resolve(""), name: "" };
  URL.createObjectURL = vi.fn((b: Blob) => { out.text = b.text(); return "blob:x"; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { out.name = this.download; });
  return out;
}

describe("Tenants list — default view", () => {
  it("still excludes closed clubs at the query and lists only open clubs", async () => {
    await renderList();
    expect(findManyArgs().where).toEqual({ deletedAt: null });
    expect(screen.getByText("Open One")).toBeTruthy();
    expect(screen.getByText("Open Two")).toBeTruthy();
    expect(screen.queryByText("Closed Club")).toBeNull();
    expect(screen.queryByText("Aged Closed")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Closed" })).toBeNull();
  });

  it("shows correct counts for both views and the subscription label", async () => {
    await renderList();
    expect(screen.getByText("Showing 2 of 2 open clubs")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Club view" });
    const open = within(nav).getByRole("link", { name: "Open clubs (2)" });
    const closedTab = within(nav).getByRole("link", { name: "Closed clubs (2)" });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(closedTab.getAttribute("aria-current")).toBeNull();
    expect(closedTab.getAttribute("href")).toBe("/admin/tenants?view=closed");
    expect(screen.getByRole("columnheader", { name: "Subscription" })).toBeTruthy();
  });

  it("treats an unknown or repeated view value safely", async () => {
    await renderList({ view: "everything" });
    expect(findManyArgs().where).toEqual({ deletedAt: null });
    cleanup(); db.calls.length = 0;
    await renderList({ view: ["closed", "open"] });
    expect(findManyArgs().where).toEqual({ deletedAt: { not: null } });
  });

  it("the default view's CSV has no Closed column and no closed rows", async () => {
    const csv = captureCsv();
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV (2)" }));
    const text = await csv.text;
    // The open view's header row is exactly the pre-existing one (compatibility).
    // Every pre-existing header is unchanged and in place; "Members" keeps its
    // all-rows meaning and the ACTIVE_MEMBER count is a separate column after it.
    expect(text.split("\n")[0]).toBe(WITH_ACTIVE_HEADER);
    expect(text.split("\n")[1].split(",").slice(4, 6)).toEqual(["2", "1"]);
    expect(text).not.toContain("closed-club");
    expect(text).not.toContain("aged-closed");
  });
});

describe("Tenants list — Closed clubs view", () => {
  it("queries only closed clubs and shows name, slug, closure date and a details link", async () => {
    await renderList({ view: "closed" });
    expect(findManyArgs()).toMatchObject({ where: { deletedAt: { not: null } }, orderBy: { deletedAt: "desc" } });
    expect(screen.queryByText("Open One")).toBeNull();
    const rowEl = screen.getByText("Closed Club").closest("tr")!;
    expect(within(rowEl).getByText("closed-club")).toBeTruthy();
    expect(within(rowEl).getByText(formatDate(closed("c1").deletedAt!))).toBeTruthy();
    expect(within(rowEl).getByRole("link", { name: "View Closed Club" }).getAttribute("href")).toBe("/admin/tenants/c1");
    expect(screen.getByRole("columnheader", { name: "Closed" })).toBeTruthy();
    expect(screen.getByText("Showing 2 of 2 closed clubs")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Club view" })).getByRole("link", { name: "Closed clubs (2)" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the subscription status separate from closure", async () => {
    await renderList({ view: "closed" });
    expect(within(screen.getByText("Closed Club").closest("tr")!).getByText("trial")).toBeTruthy();
    expect(within(screen.getByText("Aged Closed").closest("tr")!).getByText("active")).toBeTruthy();
  });

  it("sorts by most recently closed by default, and by name on request", async () => {
    await renderList({ view: "closed" });
    expect(screen.getByRole("option", { name: "Sort: Recently closed" })).toBeTruthy();
    expect(rowNames()).toEqual(["Closed Club", "Aged Closed"]);
    fireEvent.change(screen.getByLabelText("Sort tenants"), { target: { value: "name_asc" } });
    expect(rowNames()).toEqual(["Aged Closed", "Closed Club"]);
    fireEvent.change(screen.getByLabelText("Sort tenants"), { target: { value: "recent" } });
    expect(rowNames()).toEqual(["Closed Club", "Aged Closed"]);
  });

  it("search and the subscription filter work within the closed view", async () => {
    await renderList({ view: "closed" });
    fireEvent.change(screen.getByLabelText("Search name, slug, owner email"), { target: { value: "open" } });
    expect(screen.getByText("No clubs match your filters.")).toBeTruthy();
    expect(screen.getByText("Showing 0 of 2 closed clubs")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search name, slug, owner email"), { target: { value: "closed" } });
    expect(rowNames()).toEqual(["Closed Club", "Aged Closed"]);
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(rowNames()).toEqual(["Aged Closed"]);
    // Switching view keeps the search and filter in the link.
    expect(screen.getByRole("link", { name: "Open clubs (2)" }).getAttribute("href")).toBe("/admin/tenants?q=closed&status=active");
  });

  it("starts from the search and filters in the URL (so Back/Forward match the address bar)", async () => {
    await renderList({ view: "closed", q: "aged", status: "active" });
    expect((screen.getByLabelText("Search name, slug, owner email") as HTMLInputElement).value).toBe("aged");
    expect(rowNames()).toEqual(["Aged Closed"]);
    expect(screen.getByText("Showing 1 of 2 closed clubs")).toBeTruthy();
  });

  it("CSV export covers only the shown closed clubs and adds the Closed column", async () => {
    const csv = captureCsv();
    await renderList({ view: "closed" });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV (2)" }));
    const lines = (await csv.text).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`${WITH_ACTIVE_HEADER},Closed`);
    expect(lines[1]).toContain("closed-club");
    expect(lines[1].endsWith(closed("c1").deletedAt!.toISOString())).toBe(true);
    expect(lines.join("\n")).not.toContain("open-one");
    expect(csv.name).toMatch(/^matflow-tenants-closed-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("authorization and no side effects", () => {
  it("an unauthenticated request is redirected before any club is read, in either view", async () => {
    auth.ok = false;
    await expect(renderList()).rejects.toThrow("redirect:/admin/login");
    await expect(renderList({ view: "closed" })).rejects.toThrow("redirect:/admin/login");
    expect(db.calls).toHaveLength(0);
  });

  it("listing closed clubs only reads", async () => {
    await renderList({ view: "closed" });
    // Reads only: the club list, two counts, and the per-club active-member groupBy.
    expect(db.calls.map((c) => c.method).sort()).toEqual(["count", "count", "findMany", "groupBy"]);
  });

  it("opening a closed club's details page only reads (no restore, no write)", async () => {
    const before = closed("c1").deletedAt;
    const { default: Detail } = await import("@/app/admin/tenants/[id]/page");
    const element = await Detail({ params: Promise.resolve({ id: "c1" }) });
    render(element);
    expect(db.calls.map((c) => c.method)).toEqual(["findUnique"]);
    expect(screen.getByText("deleted")).toBeTruthy(); // Status stat
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy(); // offered, not performed
    expect(closed("c1").deletedAt).toBe(before);
  });
});
