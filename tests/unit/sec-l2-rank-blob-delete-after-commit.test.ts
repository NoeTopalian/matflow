/**
 * R10-1(a) (lane L2, 12 Oct 2026) — app/api/members/[id]/rank/route.ts must not hold a tenant transaction (and its
 * pooled connection) open while it waits for @vercel/blob del(): the SDK retries with exponential backoff and no
 * request timeout, so one slow storage call could hold a pool slot for minutes. The photo-replacement transaction now
 * only collects the old blob URLs and deletes the rows; the blob delete runs after that transaction has committed —
 * the same post-commit pattern as the Stripe webhook's pendingEmails. A failed delete after commit is logged, never
 * fails the request, and never re-enters the transaction.
 *
 * No database: withTenantContext is replaced by a fake that records whether a call happens inside a transaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  inTx: 0,
  txCount: 0,
  events: [] as string[],
  delImpl: null as null | (() => Promise<void>),
  oldPhotos: [] as Array<{ id: string; url: string }>,
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "staff-1", tenantId: "tenant-L2", role: "owner", email: "o@example.test" } })),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: vi.fn(() => null), refuseSupportSessionUnlessEdit: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => { h.events.push("audit"); }) }));
vi.mock("@/lib/push", () => ({ sendPushToMember: vi.fn(async () => {}) }));
vi.mock("@vercel/blob", () => ({
  del: vi.fn(async () => {
    h.events.push(h.inTx > 0 ? "del-INSIDE-tx" : "del-after-commit");
    if (h.delImpl) await h.delImpl();
  }),
}));

const rankSystem = { id: "rank-blue", name: "Blue", discipline: "BJJ", tenantId: "tenant-L2" };
const tx = {
  member: { findFirst: async () => ({ id: "member-1" }) },
  rankSystem: { findFirst: async () => rankSystem },
  memberRank: {
    findFirst: async () => ({ id: "mr-1", rankSystemId: "rank-white", stripes: 2, rankSystem }),
    update: async () => ({ id: "mr-1", rankSystemId: "rank-blue", stripes: 0, rankSystem }),
    upsert: async () => ({ id: "mr-1", rankSystemId: "rank-blue", stripes: 0, rankSystem }),
  },
  memberPhoto: {
    findMany: async () => h.oldPhotos,
    deleteMany: async () => { h.events.push("rows-deleted"); return { count: h.oldPhotos.length }; },
    create: async () => { h.events.push("photo-created"); return { id: "ph-new" }; },
  },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_tenantId: string, fn: (t: typeof tx) => Promise<unknown>) => {
    h.inTx++;
    h.txCount++;
    const n = h.txCount;
    h.events.push(`tx${n}-begin`);
    try {
      const out = await fn(tx);
      h.events.push(`tx${n}-commit`);
      return out;
    } catch (e) {
      h.events.push(`tx${n}-rollback`);
      throw e;
    } finally {
      h.inTx--;
    }
  },
}));

import { POST } from "@/app/api/members/[id]/rank/route";
import { del } from "@vercel/blob";

const BLOB_A = "https://abc123store.blob.vercel-storage.com/tenants/l2/old-a.png";
const BLOB_B = "https://abc123store.blob.vercel-storage.com/tenants/l2/old-b.png";
const NEW_PHOTO = "https://abc123store.blob.vercel-storage.com/tenants/l2/new.png";

function req(body: unknown): Request {
  return new Request("https://test.local/", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}
const promote = () => POST(req({ rankSystemId: "rank-blue", stripes: 0, photoUrl: NEW_PHOTO }), { params: Promise.resolve({ id: "member-1" }) });

let logs: string[] = [];
beforeEach(() => {
  h.inTx = 0;
  h.txCount = 0;
  h.events = [];
  h.delImpl = null;
  h.oldPhotos = [
    { id: "ph-a", url: BLOB_A },
    { id: "ph-b", url: BLOB_B },
    { id: "ph-inline", url: "data:image/png;base64,AAAA" },
  ];
  vi.mocked(del).mockClear();
  logs = [];
  for (const m of ["error", "warn"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(`${m}: ${a.map(String).join(" ")}`); });
  }
});

describe("R10-1(a): the blob delete runs after the photo transaction has committed", () => {
  it("del() is never called inside a transaction; it runs after the row delete committed, with only the blob URLs", async () => {
    const res = await promote();
    expect(res.status).toBe(200);
    expect(h.events).not.toContain("del-INSIDE-tx");
    expect(h.events).toContain("del-after-commit");
    // tx2 = the photo-replacement transaction: rows deleted, committed, THEN the blob delete.
    const i = (e: string) => h.events.indexOf(e);
    expect(i("rows-deleted")).toBeGreaterThan(i("tx2-begin"));
    expect(i("tx2-commit")).toBeGreaterThan(i("rows-deleted"));
    expect(i("del-after-commit")).toBeGreaterThan(i("tx2-commit"));
    expect(vi.mocked(del)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(del)).toHaveBeenCalledWith([BLOB_A, BLOB_B]);
    expect(h.events).toContain("photo-created");
  });

  it("a failed delete after commit is logged, does not fail the request, and does not re-enter the transaction", async () => {
    h.delImpl = async () => { throw new Error("blob store unavailable"); };
    const res = await promote();
    expect(res.status).toBe(200);
    expect(h.events).toContain("del-after-commit");
    expect(h.events.filter((e) => e.endsWith("-rollback"))).toEqual([]);
    // tx1 rank, tx2 photo rows, tx3 new photo — no extra transaction opened because of the failed delete.
    expect(h.txCount).toBe(3);
    expect(logs.some((l) => /\[rank\/route\].*orphan blob delete failed/.test(l))).toBe(true);
    expect(h.events).toContain("photo-created");
  });

  it("a slow delete is not inside any transaction while it waits", async () => {
    let inTxWhileWaiting = -1;
    h.delImpl = async () => {
      await new Promise((r) => setTimeout(r, 50));
      inTxWhileWaiting = h.inTx;
    };
    const res = await promote();
    expect(res.status).toBe(200);
    expect(inTxWhileWaiting).toBe(0);
  });

  it("no old blob photos (inline only) → no delete call; rows still removed", async () => {
    h.oldPhotos = [{ id: "ph-inline", url: "data:image/png;base64,AAAA" }];
    const res = await promote();
    expect(res.status).toBe(200);
    expect(vi.mocked(del)).not.toHaveBeenCalled();
    expect(h.events).toContain("rows-deleted");
  });
});
