// Round 5 (11 Nov 2026): a member-photo route accepts only a blob uploaded for
// THAT member (or an inline image), so a member cannot point their picture at
// the club logo or another member's photo and then have it deleted (or read
// it back through the image proxy). Real handlers, Neon TEST branch, both
// database roles. The blob store is stubbed and its deletions counted.
// Synthetic clubs (r5b-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
const blob = vi.hoisted(() => ({ deleted: [] as string[] }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async (url: string) => { blob.deleted.push(url); }) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { PUT as putPicture, DELETE as deletePicture } from "@/app/api/members/[id]/profile-picture/route";
import { POST as postChildPhoto } from "@/app/api/member/children/[id]/photos/route";
import { POST as postMemberPhoto } from "@/app/api/members/[id]/photos/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r5b${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });
const STORE = "https://abc123.blob.vercel-storage.com";

describe.skipIf(!HAS_DB)("member photos: only that member's own uploads", () => {
  let tenantId = "";
  let coachId = "";
  let m1 = "";
  let m2 = "";
  let parent = "";
  let kid = "";
  let logoUrl = "";
  const call = async (fn: unknown, id: string, method: string, body?: unknown) => {
    const r = (await (fn as (req: Request, ctx: unknown) => Promise<unknown>)(
      new Request("https://test.local/", { method, headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: body === undefined ? undefined : JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    )) as { status: number };
    return r.status;
  };
  const asMember = (memberId: string) => mockAuth.mockResolvedValue({ user: { id: `${STAMP}-u-${memberId}`, tenantId, role: "member", memberId, email: `${STAMP}@example.test` } } as never);
  const asCoach = () => mockAuth.mockResolvedValue({ user: { id: coachId, tenantId, role: "coach", email: `${STAMP}-c@example.test` } } as never);

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: STAMP, slug: STAMP } })).id;
      logoUrl = `${STORE}/tenants/${tenantId}/logo-abc.webp`;
      await tx.tenant.update({ where: { id: tenantId }, data: { logoUrl } });
      coachId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-c@example.test`, passwordHash: "x", name: "Coach", role: "coach" } })).id;
      m1 = (await tx.member.create({ data: { tenantId, name: `${STAMP} m1`, email: `${STAMP}-1@example.test` } })).id;
      m2 = (await tx.member.create({ data: { tenantId, name: `${STAMP} m2`, email: `${STAMP}-2@example.test` } })).id;
      parent = (await tx.member.create({ data: { tenantId, name: `${STAMP} parent`, email: `${STAMP}-p@example.test`, accountType: "parent" } })).id;
      kid = (await tx.member.create({ data: { tenantId, name: `${STAMP} kid`, email: `${STAMP}-k@no-login.matflow.local`, accountType: "kids", parentMemberId: parent, guardianConfirmedAt: new Date() } as never })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.memberPhoto.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } }); // children first (a child must have a parent)
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("a member cannot set the club logo as their picture, so it can never be deleted through it", async () => {
    asMember(m1);
    blob.deleted.length = 0;
    expect(await call(putPicture, m1, "PUT", { url: logoUrl })).toBe(400);
    await call(deletePicture, m1, "DELETE");
    expect(blob.deleted).not.toContain(logoUrl);
  });

  it("a member cannot set another member's photo as their own", async () => {
    asMember(m1);
    expect(await call(putPicture, m1, "PUT", { url: `${STORE}/tenants/${tenantId}/members/${m2}/p.webp` })).toBe(400);
  });

  it("a member's own upload is accepted, and removing it deletes exactly that file", async () => {
    asMember(m1);
    blob.deleted.length = 0;
    const own = `${STORE}/tenants/${tenantId}/members/${m1}/own.webp`;
    expect(await call(putPicture, m1, "PUT", { url: own })).toBe(200);
    expect(await call(deletePicture, m1, "DELETE")).toBe(200);
    expect(blob.deleted).toEqual([own]);
  });

  it("an inline image is still accepted (the no-store fallback)", async () => {
    asMember(m1);
    expect(await call(putPicture, m1, "PUT", { url: "data:image/webp;base64,UklGRg==" })).toBe(200);
  });

  it("a parent's child photo refuses an outside URL and another member's upload, and accepts an inline image or the child's own upload", async () => {
    asMember(parent);
    expect(await call(postChildPhoto, kid, "POST", { url: "https://tracker.example/pixel.png" })).toBe(400);
    expect(await call(postChildPhoto, kid, "POST", { url: logoUrl })).toBe(400);
    expect(await call(postChildPhoto, kid, "POST", { url: `${STORE}/tenants/${tenantId}/members/${m2}/p.webp` })).toBe(400);
    expect(await call(postChildPhoto, kid, "POST", { url: "data:image/png;base64,iVBORw0KGgo=" })).toBe(201);
    expect(await call(postChildPhoto, kid, "POST", { url: `${STORE}/tenants/${tenantId}/members/${kid}/k.webp` })).toBe(201);
  });

  it("a coach cannot attach the club logo to a member as a photo (it could then be deleted)", async () => {
    asCoach();
    expect(await call(postMemberPhoto, m1, "POST", { url: logoUrl })).toBe(400);
    expect(await call(postMemberPhoto, m1, "POST", { url: `${STORE}/tenants/${tenantId}/members/${m1}/staff.webp` })).toBe(201);
  });
});
