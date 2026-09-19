// Campaign lane L-B, J62 round 3: choosing a Drive folder with no grant was a 500.
//
// The run's exact failure
// (tests/e2e/campaign/assess/lb-3-ownership-and-integrations.spec.ts:394):
//
//   [L-B J62] select-folder with a traversal folderId → 500
//   Error: a traversal folder id is not a 500
//   Expected: < 500   Received: 500
//
// The traversal id was a red herring: `folderId` is an opaque Google id that
// never touches a filesystem path, so "../../etc/passwd" is just a string the
// route had no opinion about. What made it a 500 is that the seeded club holds
// no `GoogleDriveConnection`, and the handler went straight to
// `googleDriveConnection.update({ where: { tenantId } })`, which throws
// Prisma's P2025 ("record to update not found"). That landed in the catch and
// came back as `apiError("Google Drive operation failed", 500)` — a minted
// reference, a logged server fault, and an invitation to retry, for the most
// ordinary state a club can be in: it has never connected Drive.
//
// The sibling route already answers this properly — `app/api/drive/index`
// returns 400 "No folder selected" — so select-folder now checks the grant
// first and refuses in the same voice, before anything is deleted.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { findUnique, update, deleteMany, indexFolder, apiError } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  indexFolder: vi.fn(),
  apiError: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      googleDriveConnection: { findUnique, update },
      indexedDriveFile: { deleteMany },
    }),
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, tenantId: "t-A", userId: "u-1" }),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/google-drive", () => ({ indexFolder }));
vi.mock("@/lib/api-error", () => ({ apiError }));

import { POST } from "@/app/api/drive/select-folder/route";

function req(body: unknown): Request {
  return {
    method: "POST",
    headers: new Headers({ origin: "http://localhost:3847" }),
    json: async () => body,
  } as unknown as Request;
}

/** What Prisma actually throws when `update` finds no row. */
function p2025(): Error {
  const e = new Error("An operation failed because it depends on one or more records that were required but not found.");
  (e as unknown as { code: string }).code = "P2025";
  return e;
}

describe("POST /api/drive/select-folder — a club with no Drive grant", () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
    deleteMany.mockReset();
    indexFolder.mockReset();
    apiError.mockReset();
    // The real client's behaviour: an update with no matching row rejects.
    update.mockImplementation(async () => {
      throw p2025();
    });
    deleteMany.mockResolvedValue({ count: 0 });
    indexFolder.mockResolvedValue({ indexed: 0, skipped: 0 });
    apiError.mockReturnValue({ status: 500, json: async () => ({ error: "Google Drive operation failed" }) });
  });

  it("refuses with 400 and names the missing connection, never a 500", async () => {
    findUnique.mockResolvedValue(null);

    const res = await POST(req({ folderId: "1AbCdEf", folderName: "Belt tests" }));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/drive is not connected/i);
    expect(apiError, "no server fault is logged for a caller-side state").not.toHaveBeenCalled();
  });

  it("writes nothing — the club's indexed files are not wiped on the way to the refusal", async () => {
    findUnique.mockResolvedValue(null);

    await POST(req({ folderId: "1AbCdEf", folderName: "Belt tests" }));

    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("the traversal folder id is refused the same way — it is a string, not a path", async () => {
    findUnique.mockResolvedValue(null);

    const res = await POST(req({ folderId: "../../etc/passwd", folderName: "y" }));

    expect(res.status).toBe(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a connected club still selects a folder, and the id reaches the row and the index", async () => {
    findUnique.mockResolvedValue({ tenantId: "t-A" });
    update.mockResolvedValue({ tenantId: "t-A" });

    const res = await POST(req({ folderId: "../../etc/passwd", folderName: "y" }));

    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { tenantId: "t-A" },
      data: { folderId: "../../etc/passwd", folderName: "y" },
    });
    expect(indexFolder).toHaveBeenCalledWith("t-A", "../../etc/passwd");
  });

  it("a malformed body is still a 400 before any of this", async () => {
    findUnique.mockResolvedValue({ tenantId: "t-A" });

    const res = await POST(req({ folderId: "", folderName: "" }));

    expect(res.status).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
