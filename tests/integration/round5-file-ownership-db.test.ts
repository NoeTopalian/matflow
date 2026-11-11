// Round 5 remediation (11 Nov 2026): file OWNERSHIP, not same-club, at attach, read and delete
// (lib/blob-ownership.ts). Upload placement is covered by tests/unit/sec-c2-upload-controls.test.ts.
//
//  - Attach: a promotion photo must be the member's own upload; an announcement image a club-root file.
//  - Read (image proxy, member sessions): a member-path file only by its owner or their confirmed guardian; a
//    legacy club-root file only by the owner of the EARLIEST photo row, so a row planted later never reads it.
//  - Delete: a member's photo removal, an announcement deletion and a DSAR erasure delete a file only when it is the
//    member's own (or a club asset, for announcements) and nothing else in the club still references it.
//
// Real handlers, Neon TEST branch, both database roles. Blob store stubbed (reads answer an image, deletions are
// counted). Synthetic club (r5o-), torn down here.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => {
  class NR extends Response {
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    }
  }
  return { NextRequest: class extends Request {}, NextResponse: NR };
});
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToMember: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const gate = vi.hoisted(() => ({ tenantId: "", userId: "" }));
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: { user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } } });
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok), requireApiRole: vi.fn(ok) };
});
const blob = vi.hoisted(() => ({ deleted: [] as string[] }));
vi.mock("@vercel/blob", () => ({
  del: vi.fn(async (url: string | string[]) => { for (const u of [url].flat()) blob.deleted.push(u); }),
  get: vi.fn(async () => ({ statusCode: 200, stream: "img", blob: { contentType: "image/webp" } })),
}));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as readImage } from "@/app/api/blob-image/route";
import { POST as awardRank } from "@/app/api/members/[id]/rank/route";
import { DELETE as deletePicture } from "@/app/api/members/[id]/profile-picture/route";
import { POST as postAnnouncement } from "@/app/api/announcements/route";
import { DELETE as deleteAnnouncement } from "@/app/api/announcements/[id]/route";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r5o${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });
const STORE = "https://abc123.blob.vercel-storage.com";

describe.skipIf(!HAS_DB)("file ownership at attach, read and delete", () => {
  let tenantId = "";
  let ownerId = "";
  let coachId = "";
  let ada = "";
  let ben = "";
  let parent = "";
  let kid = "";
  let rankSystemId = "";
  const root = (f: string) => `${STORE}/tenants/${tenantId}/${f}`;
  const memberFile = (m: string, f: string) => `${STORE}/tenants/${tenantId}/members/${m}/${f}`;
  const asStaff = (role: "owner" | "coach" | "manager", id: string) => mockAuth.mockResolvedValue({ user: { id, tenantId, role, email: `${STAMP}-${role}@example.test` } } as never);
  const asMember = (memberId: string) => mockAuth.mockResolvedValue({ user: { id: `${STAMP}-u-${memberId}`, tenantId, role: "member", memberId, email: `${STAMP}@example.test` } } as never);
  const req = (method: string, body?: unknown, url = "https://test.local/") =>
    new Request(url, { method, headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (url: string) => (await readImage(req("GET", undefined, `https://test.local/api/blob-image?url=${encodeURIComponent(url)}`))).status;
  const photo = (memberId: string, url: string, kind = "evidence", uploadedAt = new Date()) =>
    withRlsBypass((tx) => tx.memberPhoto.create({ data: { tenantId, memberId, url, kind, uploadedAt } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: STAMP, slug: STAMP } })).id;
      await tx.tenant.update({ where: { id: tenantId }, data: { logoUrl: root("logo.webp") } });
      ownerId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-o@example.test`, passwordHash: "x", name: "Owner", role: "owner" } })).id;
      coachId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-c@example.test`, passwordHash: "x", name: "Coach", role: "coach" } })).id;
      ada = (await tx.member.create({ data: { tenantId, name: `${STAMP} Ada`, email: `${STAMP}-ada@example.test` } })).id;
      ben = (await tx.member.create({ data: { tenantId, name: `${STAMP} Ben`, email: `${STAMP}-ben@example.test` } })).id;
      parent = (await tx.member.create({ data: { tenantId, name: `${STAMP} Parent`, email: `${STAMP}-p@example.test`, accountType: "parent" } })).id;
      kid = (await tx.member.create({ data: { tenantId, name: `${STAMP} Kid`, email: `${STAMP}-k@no-login.matflow.local`, accountType: "kids", parentMemberId: parent, guardianConfirmedAt: new Date() } as never })).id;
      rankSystemId = (await tx.rankSystem.create({ data: { tenantId, discipline: "BJJ", name: "Blue", order: 1 } })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.announcement.deleteMany({ where: { tenantId } });
      await tx.memberPhoto.deleteMany({ where: { tenantId } });
      await tx.rankHistory.deleteMany({ where: { memberRank: { member: { tenantId } } } });
      await tx.memberRank.deleteMany({ where: { member: { tenantId } } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.rankSystem.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  // ── Attach ──
  it("attach: a coach cannot attach another member's photo, the logo or an import file as a promotion photo; the member's own upload is accepted", async () => {
    asStaff("coach", coachId);
    for (const url of [memberFile(ada, "a.webp"), root("logo.webp"), `${STORE}/tenants/${tenantId}/imports/x.csv`]) {
      expect((await awardRank(req("POST", { rankSystemId, stripes: 0, photoUrl: url }), ctx(ben))).status).toBe(400);
    }
    expect(await withRlsBypass((tx) => tx.memberPhoto.count({ where: { memberId: ben } }))).toBe(0);
    expect((await awardRank(req("POST", { rankSystemId, stripes: 1, photoUrl: memberFile(ben, "promo.webp") }), ctx(ben))).status).toBeLessThan(300);
    expect(await withRlsBypass((tx) => tx.memberPhoto.count({ where: { memberId: ben, url: memberFile(ben, "promo.webp") } }))).toBe(1);
  });

  it("attach: an announcement image must be a club-root file, never a member's photo or an import file", async () => {
    asStaff("owner", ownerId);
    for (const imageUrl of [memberFile(ada, "a.webp"), `${STORE}/tenants/${tenantId}/imports/x.csv`]) {
      expect((await postAnnouncement(req("POST", { title: "T", body: "B", imageUrl }))).status).toBe(400);
    }
    expect((await postAnnouncement(req("POST", { title: "T", body: "B", imageUrl: root("poster.webp") }))).status).toBe(201);
  });

  // ── Read ──
  it("read: a member reads their own member-path photo; a confirmed parent reads their child's; nobody reads another member's, even through a planted row", async () => {
    await photo(ada, memberFile(ada, "own.webp"));
    await photo(kid, memberFile(kid, "kid.webp"));
    await photo(ben, memberFile(ada, "own.webp")); // a row planted on Ben pointing at Ada's file
    asMember(ada);
    expect(await read(memberFile(ada, "own.webp"))).toBe(200);
    asMember(parent);
    expect(await read(memberFile(kid, "kid.webp"))).toBe(200);
    asMember(ben);
    expect(await read(memberFile(ada, "own.webp"))).toBe(403);
  });

  it("read: a legacy club-root photo is read by the member whose row came first, never by a row planted later; the logo and imports are never read by a member", async () => {
    const legacy = root("legacy-ada.webp");
    await photo(ada, legacy, "profile", new Date("2026-01-01T00:00:00Z"));
    await photo(ben, legacy, "evidence", new Date("2026-11-10T00:00:00Z")); // planted through the old hole
    asMember(ada);
    expect(await read(legacy)).toBe(200);
    asMember(ben);
    expect(await read(legacy)).toBe(403);
    await photo(ben, root("logo.webp"), "evidence"); // planted at the logo
    expect(await read(root("logo.webp"))).toBe(403);
    expect(await read(`${STORE}/tenants/${tenantId}/imports/x.csv`)).toBe(403);
  });

  // ── Delete ──
  it("delete: removing a picture deletes the member's own file, and a legacy file only when nothing else uses it; never the logo or another member's photo", async () => {
    asMember(ben);
    const cases: Array<[string, boolean]> = [
      [memberFile(ben, "pic.webp"), true], // Ben's own file
      [root("legacy-ben.webp"), true], // legacy, used by nothing else
      [root("legacy-ada.webp"), false], // legacy, still Ada's photo
      [root("logo.webp"), false], // the club logo
    ];
    for (const [url, deleted] of cases) {
      await withRlsBypass((tx) => tx.memberPhoto.deleteMany({ where: { memberId: ben, kind: "profile" } }));
      await photo(ben, url, "profile");
      blob.deleted.length = 0;
      expect((await deletePicture(req("DELETE"), ctx(ben))).status).toBe(200);
      expect(blob.deleted.includes(url)).toBe(deleted);
    }
  });

  it("delete: deleting an announcement deletes its club-root image only when nothing else uses it (not the logo)", async () => {
    const own = await withRlsBypass((tx) => tx.announcement.create({ data: { tenantId, title: "A", body: "B", imageUrl: root("only-here.webp") } }));
    const onLogo = await withRlsBypass((tx) => tx.announcement.create({ data: { tenantId, title: "A", body: "B", imageUrl: root("logo.webp") } })); // planted before the fix
    asStaff("manager", ownerId);
    asStaff("owner", ownerId);
    blob.deleted.length = 0;
    expect((await deleteAnnouncement(req("DELETE"), ctx(own.id))).status).toBe(200);
    expect((await deleteAnnouncement(req("DELETE"), ctx(onLogo.id))).status).toBe(200);
    expect(blob.deleted).toEqual([root("only-here.webp")]);
  });

  it("delete: erasing a member deletes their own photo file, but not the logo or another member's photo their rows pointed at", async () => {
    const dee = (await withRlsBypass((tx) => tx.member.create({ data: { tenantId, name: `${STAMP} Dee`, email: `${STAMP}-dee@example.test` } }))).id;
    await photo(dee, memberFile(dee, "dee.webp"), "profile");
    await photo(dee, root("logo.webp")); // planted at the logo before the fix
    await photo(dee, root("legacy-ada.webp")); // planted at Ada's legacy photo
    gate.tenantId = tenantId;
    gate.userId = ownerId;
    asStaff("owner", ownerId);
    blob.deleted.length = 0;
    const res = await dsarErase(req("POST", undefined, `https://test.local/api/admin/dsar/erase?memberId=${dee}`));
    expect(res.status).toBe(200);
    expect(blob.deleted).toEqual([memberFile(dee, "dee.webp")]);
  });
});
