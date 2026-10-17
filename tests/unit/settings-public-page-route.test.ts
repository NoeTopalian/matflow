// T9c owner settings route: owner-only, every support session refused
// (acceptance 5), strict body, tiers from another club refused, and a durable
// audit row in the same transaction for publish / unpublish / edit.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const h = vi.hoisted(() => ({
  session: null as unknown,
  gate: null as unknown,
  tenant: {} as Record<string, unknown>,
  tiers: [] as { id: string; tenantId: string; showOnPublicPage: boolean }[],
  audits: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  tierUpdates: [] as Record<string, unknown>[],
}));

vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: async () => h.gate }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit-log", () => ({
  logAuditStrict: async (_tx: unknown, args: Record<string, unknown>) => {
    h.audits.push(args);
  },
}));

function matches(t: { id: string; tenantId: string; showOnPublicPage: boolean }, where: Record<string, unknown>) {
  if (where.tenantId !== undefined && t.tenantId !== where.tenantId) return false;
  if (where.showOnPublicPage !== undefined && t.showOnPublicPage !== where.showOnPublicPage) return false;
  const id = where.id as { in?: string[]; notIn?: string[] } | undefined;
  if (id?.in && !id.in.includes(t.id)) return false;
  if (id?.notIn && id.notIn.includes(t.id)) return false;
  return true;
}

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    expect(tenantId).toBe("t-A");
    return fn({
      tenant: {
        findFirst: async ({ where }: { where: { id: string } }) => (where.id === "t-A" ? { ...h.tenant } : null),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          expect(where.id).toBe("t-A");
          h.updates.push(data);
          Object.assign(h.tenant, data);
          return { ...h.tenant };
        },
      },
      membershipTier: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          h.tiers.filter((t) => matches(t, where)).map((t) => ({ id: t.id })),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: { showOnPublicPage: boolean } }) => {
          expect(where.tenantId).toBe("t-A");
          h.tierUpdates.push({ where, data });
          for (const t of h.tiers) if (matches(t, where)) t.showOnPublicPage = data.showOnPublicPage;
          return { count: 0 };
        },
      },
    });
  },
}));

import { GET, PATCH } from "@/app/api/settings/public-page/route";

const OWNER = { user: { id: "u-1", tenantId: "t-A", role: "owner" } };
const OK_GATE = { ok: true, session: OWNER, tenantId: "t-A", userId: "u-1", role: "owner" };

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/settings/public-page", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
}

beforeEach(() => {
  h.session = OWNER;
  h.gate = OK_GATE;
  h.tenant = {
    id: "t-A",
    slug: "northside",
    publicPageEnabled: false,
    publicPageEnabledAt: null,
    publicPageDescription: null,
    publicPageEmail: null,
    publicPagePhone: null,
    publicPageAddress: null,
  };
  h.tiers = [
    { id: "tier-a1", tenantId: "t-A", showOnPublicPage: false },
    { id: "tier-a2", tenantId: "t-A", showOnPublicPage: true },
    { id: "tier-b1", tenantId: "t-B", showOnPublicPage: false },
  ];
  h.audits = [];
  h.updates = [];
  h.tierUpdates = [];
});

describe("PATCH /api/settings/public-page", () => {
  it("refuses an Edit support session and a View support session, writing nothing", async () => {
    for (const scope of ["edit", "view"]) {
      h.session = { user: { ...OWNER.user, impersonatedBy: "op-1", supportScope: scope } };
      const res = await patch({ enabled: true });
      expect(res.status, scope).toBe(403);
    }
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it("refuses a non-owner (the owner gate's own response)", async () => {
    h.gate = { ok: false, response: { status: 403, json: async () => ({ error: "Forbidden" }) } };
    const res = await patch({ enabled: true });
    expect(res.status).toBe(403);
    expect(h.updates).toEqual([]);
  });

  it("refuses an unknown key rather than answering 200 for something it did not save", async () => {
    const res = await patch({ enabled: true, contactEmail: "x@y.z" });
    expect(res.status).toBe(400);
    expect(h.updates).toEqual([]);
  });

  it("publishing stamps enabledAt and writes a durable 'published' audit row", async () => {
    const res = await patch({ enabled: true, description: "  Gi and no-gi  ", email: "", phone: "+44 115 000 0000" });
    expect(res.status).toBe(200);
    expect(h.tenant.publicPageEnabled).toBe(true);
    expect(h.tenant.publicPageEnabledAt).toBeInstanceOf(Date);
    expect(h.tenant.publicPageDescription).toBe("Gi and no-gi");
    expect(h.tenant.publicPageEmail).toBeNull();
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: "tenant.public_page.published", tenantId: "t-A", userId: "u-1", entityId: "t-A" });
    expect((h.audits[0].metadata as { after: Record<string, unknown> }).after).toMatchObject({ publicPageEnabled: true });
  });

  it("unpublishing clears enabledAt and audits 'unpublished'; a content edit audits 'update'", async () => {
    h.tenant.publicPageEnabled = true;
    h.tenant.publicPageEnabledAt = new Date();
    await patch({ enabled: false });
    expect(h.tenant.publicPageEnabled).toBe(false);
    expect(h.tenant.publicPageEnabledAt).toBeNull();
    expect(h.audits.at(-1)).toMatchObject({ action: "tenant.public_page.unpublished" });

    await patch({ address: "1 High Street" });
    expect(h.audits.at(-1)).toMatchObject({ action: "tenant.public_page.update" });
  });

  it("replaces the set of public tiers within this club and records it in the audit row", async () => {
    const res = await patch({ publicTierIds: ["tier-a1"] });
    expect(res.status).toBe(200);
    expect(h.tiers.find((t) => t.id === "tier-a1")!.showOnPublicPage).toBe(true);
    expect(h.tiers.find((t) => t.id === "tier-a2")!.showOnPublicPage).toBe(false);
    expect(h.audits.at(-1)).toMatchObject({
      action: "tenant.public_page.update",
      metadata: expect.objectContaining({ publicTierIdsBefore: ["tier-a2"], publicTierIdsAfter: ["tier-a1"] }),
    });
  });

  it("refuses a tier id from another club and changes nothing", async () => {
    const res = await patch({ publicTierIds: ["tier-a1", "tier-b1"] });
    expect(res.status).toBe(400);
    expect(h.tierUpdates).toEqual([]);
    expect(h.tiers.find((t) => t.id === "tier-b1")!.showOnPublicPage).toBe(false);
    expect(h.audits).toEqual([]);
  });

  it("rejects a malformed phone and email with plain-English messages", async () => {
    const badPhone = await patch({ phone: "call me" });
    expect(badPhone.status).toBe(400);
    const phoneBody = (await badPhone.json()) as { details: { fieldErrors: Record<string, string[]> } };
    expect(phoneBody.details.fieldErrors.phone[0]).toMatch(/^Enter a phone number/);
    const badEmail = await patch({ email: "not-an-email" });
    expect(badEmail.status).toBe(400);
    const emailBody = (await badEmail.json()) as { details: { fieldErrors: Record<string, string[]> } };
    expect(emailBody.details.fieldErrors.email[0]).toMatch(/^Enter a valid email address/);
    expect(h.updates).toEqual([]);
  });

  it("a phone or email of only spaces clears the field instead of failing", async () => {
    h.tenant.publicPageEmail = "old@club.example";
    h.tenant.publicPagePhone = "+44 115 000 0000";
    const res = await patch({ email: "   ", phone: "  " });
    expect(res.status).toBe(200);
    expect(h.tenant.publicPageEmail).toBeNull();
    expect(h.tenant.publicPagePhone).toBeNull();
  });

  it("trims a valid email and phone before saving", async () => {
    await patch({ email: "  hello@club.example ", phone: " 0115 000 0000 " });
    expect(h.tenant.publicPageEmail).toBe("hello@club.example");
    expect(h.tenant.publicPagePhone).toBe("0115 000 0000");
  });
});

describe("GET /api/settings/public-page", () => {
  const read = async () =>
    (await (GET() as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>)).json();

  beforeEach(() => {
    h.tiers = [];
    h.tenant.reviewLockedAt = null;
  });

  it("flags a logo the public page cannot show (legacy blob or external)", async () => {
    h.tenant.logoUrl = "https://abc.private.blob.vercel-storage.com/tenants/t-A/logo.png";
    expect((await read()).logoNotPublic).toBe(true);
  });

  it("does not flag an inline logo, or no logo at all", async () => {
    h.tenant.logoUrl = "data:image/webp;base64,UklGRhIAAABXRUJQ";
    expect((await read()).logoNotPublic).toBe(false);
    h.tenant.logoUrl = null;
    expect((await read()).logoNotPublic).toBe(false);
  });
});
