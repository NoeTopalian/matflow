// S3 (6 Nov 2026): the dashboard layout reads the password gate, the club and (in review mode) the last import in ONE
// tenant transaction, where it used to open up to three. The reads stay best effort, each on its own: a later read
// failing (which aborts the transaction) must not drop an earlier answer, above all the F-3 password gate.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  tenantTx: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect ${to}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: (t: string, fn: (tx: unknown) => unknown) => h.tenantTx(t, fn) }));
vi.mock("@/lib/authz", () => ({
  requireStaff: async () => ({
    session: { user: { id: "u1", tenantId: "t1", role: "owner", tenantName: "Club", name: "Owner", primaryColor: "#3b82f6", totpEnabled: true } },
  }),
}));
import DashboardLayout from "@/app/dashboard/layout";

const TENANT = { logoUrl: null, logoSize: "md", onboardingCompleted: true, reviewLockedAt: new Date("2026-11-01T00:00:00Z"), reviewSnapshotAt: null, reviewNote: null };

function tx(over: Partial<Record<"user" | "tenant" | "importJob", () => Promise<unknown>>> = {}) {
  return {
    user: { findFirst: over.user ?? (async () => ({ mustChangePassword: false })) },
    tenant: { findUnique: over.tenant ?? (async () => TENANT) },
    importJob: { findFirst: over.importJob ?? (async () => ({ source: "teamup" })) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** Every element in the tree whose props carry `key`. */
function findProps(node: unknown, key: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) findProps(n, key, out);
    return out;
  }
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props) {
    if (key in props) out.push(props);
    findProps(props.children, key, out);
  }
  return out;
}

describe("dashboard layout reads in one transaction", () => {
  it("opens exactly one tenant transaction for the gate, the club and the last import", async () => {
    h.tenantTx.mockImplementation(async (_t: string, fn: (tx: unknown) => unknown) => fn(tx()));
    const el = await DashboardLayout({ children: null });
    expect(h.tenantTx).toHaveBeenCalledTimes(1);
    expect(h.tenantTx.mock.calls[0][0]).toBe("t1");
    // The review banner names the import's platform: all three reads reached the page.
    expect(findProps(el, "sourcePlatform")[0]?.sourcePlatform).toBe("TeamUp");
  });

  it("still sends a temporary-password user to /set-password when a later read fails", async () => {
    h.tenantTx.mockImplementation(async (_t: string, fn: (tx: unknown) => unknown) =>
      fn(tx({ user: async () => ({ mustChangePassword: true }), tenant: async () => { throw new Error("tenant read failed"); } })),
    );
    await expect(DashboardLayout({ children: null })).rejects.toThrow("redirect /set-password");
  });

  it("keeps the club when only the last-import read fails, and renders without the platform name", async () => {
    h.tenantTx.mockImplementation(async (_t: string, fn: (tx: unknown) => unknown) =>
      fn(tx({ importJob: async () => { throw new Error("import read failed"); } })),
    );
    const el = await DashboardLayout({ children: null });
    const banner = findProps(el, "sourcePlatform")[0];
    expect(banner).toBeDefined();
    expect(banner.sourcePlatform).toBeNull();
  });

  it("renders the shell when the transaction cannot start at all", async () => {
    h.tenantTx.mockRejectedValue(new Error("pool timeout"));
    const el = await DashboardLayout({ children: null });
    expect(findProps(el, "sourcePlatform")).toEqual([]);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
