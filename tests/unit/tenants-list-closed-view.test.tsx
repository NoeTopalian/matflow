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

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/tenants",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "c1" }),
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("@/app/admin/AdminTopNav", () => ({ default: () => null }));

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/admin-auth", () => ({ isAdminPageAuthed: async () => auth.ok }));

// A fake database: two open clubs and one closed one. Records every call, and
// throws on anything that is not a read.
const db = vi.hoisted(() => {
  const D = (s: string) => new Date(s);
  const owner = (id: string) => [{ id: `u-${id}`, email: `${id}@example.test`, name: `Owner ${id}`, totpEnabled: true, lockedUntil: null, loginEmailProvisionalSince: null }];
  const tenants = [
    { id: "o1", name: "Open One", slug: "open-one", subscriptionStatus: "active", deletedAt: null, createdAt: D("2026-09-01") },
    { id: "o2", name: "Open Two", slug: "open-two", subscriptionStatus: "trial", deletedAt: null, createdAt: D("2026-09-02") },
    { id: "c1", name: "Closed Club", slug: "closed-club", subscriptionStatus: "trial", deletedAt: D("2026-10-16T08:46:46Z"), createdAt: D("2026-10-15") },
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
  const tenant = new Proxy({} as Record<string, unknown>, {
    get(_, method: string) {
      return async (args: { where?: { id?: string; deletedAt?: unknown } }) => {
        calls.push({ method, args });
        if (method === "findMany") return tenants.filter((t) => matches(t, args?.where));
        if (method === "count") return tenants.filter((t) => matches(t, args?.where)).length;
        if (method === "findUnique") return tenants.find((t) => t.id === args?.where?.id) ?? null;
        throw new Error(`write attempted: tenant.${method}`);
      };
    },
  });
  return { tenants, calls, tx: new Proxy({ tenant } as Record<string, unknown>, {
    get(target, model: string) {
      if (model in target) return target[model];
      return new Proxy({}, { get: (_, method: string) => () => { throw new Error(`unexpected ${model}.${method}`); } });
    },
  }) };
});
vi.mock("@/lib/prisma-tenant", () => ({ withRlsBypass: async (fn: (tx: unknown) => unknown) => fn(db.tx) }));

const realFetch = globalThis.fetch;
beforeEach(() => {
  auth.ok = true;
  db.calls.length = 0;
  window.history.replaceState(null, "", "/admin/tenants");
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

async function renderList(view?: string) {
  const { default: Page } = await import("@/app/admin/tenants/page");
  const element = await Page({ searchParams: Promise.resolve(view ? { view } : {}) });
  return render(element);
}
const findManyWhere = () => (db.calls.find((c) => c.method === "findMany")?.args as { where: unknown }).where;

describe("Tenants list — default view", () => {
  it("still excludes closed clubs at the query and lists only open clubs", async () => {
    await renderList();
    expect(findManyWhere()).toEqual({ deletedAt: null });
    expect(screen.getByText("Open One")).toBeTruthy();
    expect(screen.getByText("Open Two")).toBeTruthy();
    expect(screen.queryByText("Closed Club")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Closed" })).toBeNull();
  });

  it("shows correct counts for both views and the subscription label", async () => {
    await renderList();
    expect(screen.getByText("Showing 2 of 2 open clubs")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Club view" });
    const open = within(nav).getByRole("link", { name: "Open clubs (2)" });
    const closed = within(nav).getByRole("link", { name: "Closed clubs (1)" });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(closed.getAttribute("aria-current")).toBeNull();
    expect(closed.getAttribute("href")).toBe("/admin/tenants?view=closed");
    expect(screen.getByRole("columnheader", { name: "Subscription" })).toBeTruthy();
  });

  it("treats an unknown view value as the default", async () => {
    await renderList("everything");
    expect(findManyWhere()).toEqual({ deletedAt: null });
    expect(screen.queryByText("Closed Club")).toBeNull();
  });
});

describe("Tenants list — Closed clubs view", () => {
  it("queries only closed clubs and shows name, slug, closure date and a details link", async () => {
    await renderList("closed");
    expect(findManyWhere()).toEqual({ deletedAt: { not: null } });
    expect(screen.queryByText("Open One")).toBeNull();
    const rowEl = screen.getByText("Closed Club").closest("tr")!;
    expect(within(rowEl).getByText("closed-club")).toBeTruthy();
    expect(within(rowEl).getByText("16 Oct 2026")).toBeTruthy();
    expect(within(rowEl).getByRole("link", { name: "View Closed Club" }).getAttribute("href")).toBe("/admin/tenants/c1");
    expect(screen.getByRole("columnheader", { name: "Closed" })).toBeTruthy();
    expect(screen.getByText("Showing 1 of 1 closed club")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Club view" })).getByRole("link", { name: "Closed clubs (1)" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the subscription status separate from closure", async () => {
    await renderList("closed");
    const rowEl = screen.getByText("Closed Club").closest("tr")!;
    expect(within(rowEl).getByText("trial")).toBeTruthy(); // subscription status as stored, not "closed"/"deleted"
  });

  it("search and the subscription filter work within the closed view", async () => {
    await renderList("closed");
    fireEvent.change(screen.getByLabelText("Search name, slug, owner email"), { target: { value: "open" } });
    expect(screen.getByText("No clubs match your filters.")).toBeTruthy();
    expect(screen.getByText("Showing 0 of 1 closed club")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search name, slug, owner email"), { target: { value: "closed-club" } });
    expect(screen.getByText("Closed Club")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.queryByText("Closed Club")).toBeNull();
    // Switching view keeps the search and filter in the link.
    expect(screen.getByRole("link", { name: "Open clubs (2)" }).getAttribute("href")).toBe("/admin/tenants?q=closed-club&status=active");
  });

  it("CSV export covers only the closed view's rows and adds the Closed column", async () => {
    const blobs: Blob[] = [];
    let downloadName = "";
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
    await renderList("closed");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV (1)" }));
    const text = await blobs[0].text();
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith(",Closed")).toBe(true);
    expect(lines[1]).toContain("closed-club");
    expect(lines[1].endsWith("2026-10-16T08:46:46.000Z")).toBe(true);
    expect(downloadName).toMatch(/^matflow-tenants-closed-\d{4}-\d{2}-\d{2}\.csv$/);
    click.mockRestore();
  });

  it("the default view's CSV has no Closed column and no closed rows", async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderList();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV (2)" }));
    const text = await blobs[0].text();
    expect(text.split("\n")[0].includes("Closed")).toBe(false);
    expect(text).not.toContain("closed-club");
    click.mockRestore();
  });
});

describe("authorization and no side effects", () => {
  it("an unauthenticated request is redirected before any club is read, in either view", async () => {
    auth.ok = false;
    await expect(renderList()).rejects.toThrow("redirect:/admin/login");
    await expect(renderList("closed")).rejects.toThrow("redirect:/admin/login");
    expect(db.calls).toHaveLength(0);
  });

  it("listing closed clubs only reads", async () => {
    await renderList("closed");
    expect(db.calls.map((c) => c.method).sort()).toEqual(["count", "count", "findMany"]);
  });

  it("opening a closed club's details page only reads (no restore, no write)", async () => {
    const { default: Detail } = await import("@/app/admin/tenants/[id]/page");
    const element = await Detail({ params: Promise.resolve({ id: "c1" }) });
    render(element);
    expect(db.calls.map((c) => c.method)).toEqual(["findUnique"]);
    expect(screen.getByText("deleted")).toBeTruthy(); // Status stat
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy(); // offered, not performed
    expect(db.tenants.find((t) => t.id === "c1")!.deletedAt).not.toBeNull();
  });
});
