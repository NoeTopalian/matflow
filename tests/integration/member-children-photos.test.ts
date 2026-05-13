// US-5: kid photo evidence — upload, list, delete, cross-parent guard, and
// cascade-on-kid-delete (proves the ON DELETE CASCADE FK on memberId).
//
// Strategy mirrors tests/integration/member-children-lifecycle.test.ts: mock
// auth + csrf + audit, drive route handlers directly with constructed
// Request objects. Uses tests/setup-test-db.ts gate.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

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

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import {
  GET as listPhotos,
  POST as createPhoto,
} from "@/app/api/member/children/[id]/photos/route";
import { DELETE as deletePhoto } from "@/app/api/member/children/[id]/photos/[photoId]/route";
import { deleteMemberCascade } from "@/lib/member-delete";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function jsonReq(body: unknown): Request {
  return new Request("https://test.local/api/member/children/x/photos", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}
function getReq(): Request {
  return new Request("https://test.local/", {
    method: "GET",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}
function delReq(): Request {
  return new Request("https://test.local/", {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

describe.skipIf(!HAS_DB)("US-5 — kid photo evidence", () => {
  let tenantId: string;
  let parentAId: string;
  let kidAId: string;
  let parentBId: string;
  let kidBId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: "Photos-T", slug: `photos-${STAMP}` } });
      tenantId = t.id;
      const pA = await tx.member.create({
        data: { tenantId, name: "Parent A", email: `pa-${STAMP}@photos.test` },
      });
      parentAId = pA.id;
      const kA = await tx.member.create({
        data: { tenantId, name: "Kid A", email: `kid-a-${STAMP}@kids.local`, parentMemberId: pA.id },
      });
      kidAId = kA.id;
      const pB = await tx.member.create({
        data: { tenantId, name: "Parent B", email: `pb-${STAMP}@photos.test` },
      });
      parentBId = pB.id;
      const kB = await tx.member.create({
        data: { tenantId, name: "Kid B", email: `kid-b-${STAMP}@kids.local`, parentMemberId: pB.id },
      });
      kidBId = kB.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.memberPhoto.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.member.deleteMany({ where: { tenantId } }).catch(() => {});
      await tx.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    });
  });

  it("parent uploads + lists their own kid's photo", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);

    const createRes = await createPhoto(
      jsonReq({ url: "https://blob.example/img1.png", caption: "First stripe!", kind: "milestone" }),
      { params: Promise.resolve({ id: kidAId }) },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; kind: string; caption: string | null };
    expect(created.kind).toBe("milestone");
    expect(created.caption).toBe("First stripe!");

    const listRes = await listPhotos(getReq(), { params: Promise.resolve({ id: kidAId }) });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.find((p) => p.id === created.id)).toBeTruthy();
  });

  it("cross-parent upload returns 404", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);

    const res = await createPhoto(
      jsonReq({ url: "https://blob.example/img-x.png" }),
      { params: Promise.resolve({ id: kidBId }) },
    );
    expect(res.status).toBe(404);

    const leak = await withRlsBypass((tx) =>
      tx.memberPhoto.count({ where: { memberId: kidBId } }),
    );
    expect(leak).toBe(0);
  });

  it("cross-parent list returns 404", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);

    const res = await listPhotos(getReq(), { params: Promise.resolve({ id: kidBId }) });
    expect(res.status).toBe(404);
  });

  it("cross-parent DELETE returns 404 and row remains", async () => {
    // Seed a photo for kidB via parentB so we have something to attempt
    let kidBPhotoId = "";
    await withRlsBypass(async (tx) => {
      const p = await tx.memberPhoto.create({
        data: { tenantId, memberId: kidBId, url: "https://blob.example/keep.png", uploadedByMemberId: parentBId },
      });
      kidBPhotoId = p.id;
    });

    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);

    const res = await deletePhoto(delReq(), {
      params: Promise.resolve({ id: kidBId, photoId: kidBPhotoId }),
    });
    expect(res.status).toBe(404);

    const still = await withRlsBypass((tx) =>
      tx.memberPhoto.findUnique({ where: { id: kidBPhotoId } }),
    );
    expect(still).not.toBeNull();
  });

  it("CASCADE: deleting a kid via lib/member-delete.ts removes their photos", async () => {
    // Create a fresh kid + photo so we can delete the kid cleanly
    let throwawayKidId = "";
    let throwawayPhotoId = "";
    await withRlsBypass(async (tx) => {
      const k = await tx.member.create({
        data: { tenantId, name: "Throwaway", email: `throw-${STAMP}@kids.local`, parentMemberId: parentAId },
      });
      throwawayKidId = k.id;
      const p = await tx.memberPhoto.create({
        data: { tenantId, memberId: k.id, url: "https://blob.example/throwaway.png" },
      });
      throwawayPhotoId = p.id;
    });

    await withRlsBypass(async (tx) => {
      const outcome = await deleteMemberCascade(tx, {
        id: throwawayKidId,
        tenantId,
        parentMemberId: parentAId,
      });
      expect(outcome.kind).toBe("ok");
    });

    const kidStill = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: throwawayKidId } }),
    );
    expect(kidStill).toBeNull();

    const photoStill = await withRlsBypass((tx) =>
      tx.memberPhoto.findUnique({ where: { id: throwawayPhotoId } }),
    );
    expect(photoStill).toBeNull();
  });
});
