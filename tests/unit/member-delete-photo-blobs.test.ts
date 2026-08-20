import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * DELETE /api/members/[id] must delete the member's photo FILES, not only
 * their rows.
 *
 * MemberPhoto is ON DELETE CASCADE, so Postgres destroys the rows — and with
 * them the only record of where the files live — while the files themselves
 * survive in Vercel Blob with nothing pointing at them. `del()` was already
 * wired into the individual-photo delete paths (profile-picture, photos) and
 * into the DSAR erase route, but NOT into ordinary member deletion. Since DSAR
 * handles it and normal deletion did not, that was a GDPR erasure gap rather
 * than untidiness.
 *
 * lib/member-delete is mocked here on purpose, exactly as
 * member-delete-stripe-cancel.test.ts does: this file is about which files get
 * deleted around the cascade, not the cascade walk itself (covered by
 * tests/integration/member-cascade-delete.test.ts).
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

const { memberFindFirstMock, tenantFindUniqueMock, cancelSubMock, deleteHelperMock, delMock } =
  vi.hoisted(() => ({
    memberFindFirstMock: vi.fn(),
    tenantFindUniqueMock: vi.fn(),
    cancelSubMock: vi.fn(),
    deleteHelperMock: vi.fn(),
    delMock: vi.fn(),
  }));

const fakeTx = {
  member: { findFirst: memberFindFirstMock },
  tenant: { findUnique: tenantFindUniqueMock },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakeTx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
}));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: cancelSubMock }));
vi.mock("@/lib/member-delete", () => ({ deleteParentMemberWithKidsResolution: deleteHelperMock }));
vi.mock("@vercel/blob", () => ({ del: delMock }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const TENANT = "tenant-A";
const PHOTO_A = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/photo-a.webp`;
const PHOTO_B = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/photo-b.webp`;
const KID_PHOTO = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/kid-1.webp`;
const INLINE_PHOTO = "data:image/webp;base64,UklGRhoAAABXRUJQ";

function deleteReq(id: string, query = "confirm=1") {
  return new Request(`https://test.local/api/members/${id}?${query}`, {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

async function callDelete(id: string, query?: string) {
  const { DELETE } = await import("@/app/api/members/[id]/route");
  return DELETE(deleteReq(id, query) as never, { params: Promise.resolve({ id }) });
}

/** Whichever blob URLs del() was actually asked to remove, sorted. */
function deletedUrls(): string[] {
  return delMock.mock.calls.map((c) => c[0] as string).sort();
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  mockAuth.mockResolvedValue({
    user: { id: "u-owner", role: "owner", tenantId: TENANT, email: "owner@gym.test" },
  } as never);
  tenantFindUniqueMock.mockResolvedValue({ stripeAccountId: null });
  deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Sam Fighter", kidsAffected: 0 });
  delMock.mockResolvedValue(undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("DELETE /api/members/[id] — photo blobs are cleaned up", () => {
  it("deletes every blob the member's photos pointed at", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: null,
      photos: [
        { id: "p-1", url: PHOTO_A },
        { id: "p-2", url: PHOTO_B },
      ],
      children: [],
    });

    const res = await callDelete("m-1");

    expect(res.status).toBe(200);
    expect(deletedUrls()).toEqual([PHOTO_A, PHOTO_B].sort());
    const body = (await res.json()) as { photosDeleted: number };
    expect(body.photosDeleted).toBe(2);
  });

  it("reads the URLs BEFORE the cascade destroys the rows", async () => {
    // The rows are ON DELETE CASCADE, so after the helper runs there is
    // nothing left to read a URL from. Ordering is the whole fix.
    const order: string[] = [];
    memberFindFirstMock.mockImplementation(async () => {
      order.push("read-photos");
      return {
        id: "m-1",
        name: "Sam Fighter",
        stripeSubscriptionId: null,
        photos: [{ id: "p-1", url: PHOTO_A }],
        children: [],
      };
    });
    deleteHelperMock.mockImplementation(async () => {
      order.push("cascade");
      return { kind: "ok", name: "Sam Fighter", kidsAffected: 0 };
    });
    delMock.mockImplementation(async () => {
      order.push("blob-del");
    });

    await callDelete("m-1");

    expect(order).toEqual(["read-photos", "cascade", "blob-del"]);
  });

  it("skips inline data: URLs, which have no file behind them", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: null,
      photos: [
        { id: "p-1", url: INLINE_PHOTO },
        { id: "p-2", url: PHOTO_A },
      ],
      children: [],
    });

    const res = await callDelete("m-1");

    expect(deletedUrls()).toEqual([PHOTO_A]);
    const body = (await res.json()) as { photosDeleted: number };
    expect(body.photosDeleted).toBe(1);
  });

  it("cascade strategy also deletes each kid's photo files", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: null,
      photos: [{ id: "ph-1", url: PHOTO_A }],
      children: [
        { id: "k-1", name: "Kid One", stripeSubscriptionId: null, photos: [{ id: "ph-2", url: KID_PHOTO }] },
      ],
    });
    deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Parent Payer", kidsAffected: 1 });

    await callDelete("p-1", "strategy=cascade");

    expect(deletedUrls()).toEqual([PHOTO_A, KID_PHOTO].sort());
  });

  it("orphan strategy leaves the surviving kids' photos alone", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: null,
      photos: [{ id: "ph-1", url: PHOTO_A }],
      children: [
        { id: "k-1", name: "Kid One", stripeSubscriptionId: null, photos: [{ id: "ph-2", url: KID_PHOTO }] },
      ],
    });
    deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Parent Payer", kidsAffected: 1 });

    await callDelete("p-1", "strategy=orphan");

    // The kid stays in the tenant, so their photo must stay with them.
    expect(deletedUrls()).toEqual([PHOTO_A]);
  });

  it("reassign strategy leaves the reassigned kids' photos alone", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: null,
      photos: [{ id: "ph-1", url: PHOTO_A }],
      children: [
        { id: "k-1", name: "Kid One", stripeSubscriptionId: null, photos: [{ id: "ph-2", url: KID_PHOTO }] },
      ],
    });
    deleteHelperMock.mockResolvedValue({ kind: "ok", name: "Parent Payer", kidsAffected: 1 });

    await callDelete("p-1", "strategy=reassign&toParentMemberId=p-2");

    expect(deletedUrls()).toEqual([PHOTO_A]);
  });

  it("deletes nothing on the kids-present picker response", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "p-1",
      name: "Parent Payer",
      stripeSubscriptionId: null,
      photos: [{ id: "ph-1", url: PHOTO_A }],
      children: [
        { id: "k-1", name: "Kid One", stripeSubscriptionId: null, photos: [{ id: "ph-2", url: KID_PHOTO }] },
      ],
    });
    deleteHelperMock.mockResolvedValue({
      kind: "kids-present",
      kids: [{ id: "k-1", name: "Kid One" }],
    });

    const res = await callDelete("p-1");

    expect(res.status).toBe(409);
    expect(delMock).not.toHaveBeenCalled();
  });

  it("deletes nothing when the cascade reports the member was already gone", async () => {
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: null,
      photos: [{ id: "p-1", url: PHOTO_A }],
      children: [],
    });
    deleteHelperMock.mockResolvedValue({ kind: "race" });

    const res = await callDelete("m-1");

    expect(res.status).toBe(409);
    expect(delMock).not.toHaveBeenCalled();
  });

  it("cannot fail the delete when the photo relation is absent from the row", async () => {
    // Caught during this task: cleanup code that throws sits inside the
    // handler's outer try, so it would answer "Failed to delete member" for a
    // member who HAS been deleted. Cleaning up files is never allowed to be
    // load-bearing for the delete.
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: null,
      children: [],
      // no `photos` key at all
    });

    const res = await callDelete("m-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; photosDeleted: number };
    expect(body.success).toBe(true);
    expect(body.photosDeleted).toBe(0);
  });

  it("still reports success when the Blob API refuses — the member IS deleted", async () => {
    // Best-effort, matching the DSAR erase path: the rows are already gone, so
    // a Blob failure leaves an orphaned file, not surviving personal data. It
    // must never turn a completed delete into "Failed to delete member"
    // (docs/RULES.md §2 — a success message must mean success, and so must a
    // failure one).
    memberFindFirstMock.mockResolvedValue({
      id: "m-1",
      name: "Sam Fighter",
      stripeSubscriptionId: null,
      photos: [
        { id: "p-1", url: PHOTO_A },
        { id: "p-2", url: PHOTO_B },
      ],
      children: [],
    });
    delMock.mockRejectedValueOnce(new Error("Blob store unavailable"));

    const res = await callDelete("m-1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; photosDeleted: number };
    expect(body.success).toBe(true);
    // The one that failed is named in the log so it can be cleaned up by hand,
    // and the second photo is still attempted rather than abandoned.
    expect(body.photosDeleted).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("p-1");
  });
});

/**
 * What is NOT covered here, stated rather than implied:
 *
 *  - That `del()` actually removes the file from Vercel Blob. There is no
 *    BLOB_READ_WRITE_TOKEN in this environment, so the SDK is mocked; what is
 *    proved is WHICH urls this route asks it to remove, and when.
 *  - The cascade walk itself (which rows go, which are detached) — that is
 *    tests/integration/member-cascade-delete.test.ts.
 *  - A kid added between the preflight read and the cascade under
 *    ?strategy=cascade. That kid's photo files would be missed. The window is
 *    narrow and the residue is an orphaned file, not surviving personal data
 *    reachable through the app, so it is recorded rather than engineered away.
 *  - SignedWaiver.signatureImageUrl is deliberately NOT deleted here: waivers
 *    are retained under legal hold on member deletion (lib/member-delete.ts)
 *    and are erased only through the DSAR path.
 */
