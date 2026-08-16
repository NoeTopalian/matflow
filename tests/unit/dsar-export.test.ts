import { vi, describe, it, expect, beforeEach } from "vitest";

// Assessment Fix #3 — DSAR scripted export endpoint.
// Verifies tenant scoping, member-not-found 404, missing-query 400,
// the export shape, and audit logging.
//
// Audit P1-7 / P2-9 / P2-10 (storage/memory audit 2026-08-16) extend this:
// the Article 15 export must carry the surfaces it used to omit (photos,
// login/device history, push channels, waitlist/roster, member notes, token
// metadata), must never silently truncate, must hand over proxy URLs rather
// than raw blob URLs, and must not write the member's cleartext email into
// AuditLog (which re-planted PII for an already-erased member).

const {
  requireOwnerMock,
  checkRateLimitMock,
  memberFindFirstMock,
  attendanceFindManyMock,
  attendanceCountMock,
  paymentFindManyMock,
  paymentCountMock,
  orderFindManyMock,
  orderCountMock,
  waiverFindManyMock,
  waiverCountMock,
  subFindManyMock,
  packFindManyMock,
  rankFindManyMock,
  emailLogFindManyMock,
  emailLogCountMock,
  auditLogFindManyMock,
  auditLogCountMock,
  photoFindManyMock,
  loginEventFindManyMock,
  pushFindManyMock,
  waitlistFindManyMock,
  rosterFindManyMock,
  taskFindManyMock,
  magicLinkAggregateMock,
  passwordResetAggregateMock,
  logAuditMock,
} = vi.hoisted(() => ({
  requireOwnerMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  attendanceFindManyMock: vi.fn(),
  attendanceCountMock: vi.fn(),
  paymentFindManyMock: vi.fn(),
  paymentCountMock: vi.fn(),
  orderFindManyMock: vi.fn(),
  orderCountMock: vi.fn(),
  waiverFindManyMock: vi.fn(),
  waiverCountMock: vi.fn(),
  subFindManyMock: vi.fn(),
  packFindManyMock: vi.fn(),
  rankFindManyMock: vi.fn(),
  emailLogFindManyMock: vi.fn(),
  emailLogCountMock: vi.fn(),
  auditLogFindManyMock: vi.fn(),
  auditLogCountMock: vi.fn(),
  photoFindManyMock: vi.fn(),
  loginEventFindManyMock: vi.fn(),
  pushFindManyMock: vi.fn(),
  waitlistFindManyMock: vi.fn(),
  rosterFindManyMock: vi.fn(),
  taskFindManyMock: vi.fn(),
  magicLinkAggregateMock: vi.fn(),
  passwordResetAggregateMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ requireOwner: requireOwnerMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
// Mocked so repeated GETs in this file can't trip the real 10/hr bucket
// (checkRateLimit falls back to a module-level in-memory store under test).
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: memberFindFirstMock },
    attendanceRecord: { findMany: attendanceFindManyMock, count: attendanceCountMock },
    payment: { findMany: paymentFindManyMock, count: paymentCountMock },
    order: { findMany: orderFindManyMock, count: orderCountMock },
    signedWaiver: { findMany: waiverFindManyMock, count: waiverCountMock },
    classSubscription: { findMany: subFindManyMock },
    memberClassPack: { findMany: packFindManyMock },
    memberRank: { findMany: rankFindManyMock },
    emailLog: { findMany: emailLogFindManyMock, count: emailLogCountMock },
    auditLog: { findMany: auditLogFindManyMock, count: auditLogCountMock },
    memberPhoto: { findMany: photoFindManyMock },
    loginEvent: { findMany: loginEventFindManyMock },
    pushSubscription: { findMany: pushFindManyMock },
    classWaitlist: { findMany: waitlistFindManyMock },
    classRoster: { findMany: rosterFindManyMock },
    task: { findMany: taskFindManyMock },
    magicLinkToken: { aggregate: magicLinkAggregateMock },
    passwordResetToken: { aggregate: passwordResetAggregateMock },
  },
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

const MEMBER = {
  id: "m1",
  email: "alice@example.com",
  name: "Alice",
  tenantId: "tenant-A",
  parent: null,
  children: [],
};

const BLOB_PHOTO_URL = "https://store1.blob.vercel-storage.com/photos/alice.jpg";
const BLOB_SIG_URL = "https://store1.blob.vercel-storage.com/sigs/alice.png";
const EMPTY_TOKEN_AGG = { _count: { _all: 0 }, _max: { createdAt: null } };

beforeEach(() => {
  vi.resetAllMocks();
  requireOwnerMock.mockResolvedValue({
    tenantId: "tenant-A",
    userId: "user-owner-A",
    role: "owner",
  });
  checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  logAuditMock.mockResolvedValue(undefined);

  memberFindFirstMock.mockResolvedValue(MEMBER);
  for (const m of [
    attendanceFindManyMock,
    paymentFindManyMock,
    orderFindManyMock,
    waiverFindManyMock,
    subFindManyMock,
    packFindManyMock,
    rankFindManyMock,
    emailLogFindManyMock,
    auditLogFindManyMock,
    photoFindManyMock,
    loginEventFindManyMock,
    pushFindManyMock,
    waitlistFindManyMock,
    rosterFindManyMock,
    taskFindManyMock,
  ]) {
    m.mockResolvedValue([]);
  }
  for (const c of [
    attendanceCountMock,
    paymentCountMock,
    orderCountMock,
    waiverCountMock,
    emailLogCountMock,
    auditLogCountMock,
  ]) {
    c.mockResolvedValue(0);
  }
  magicLinkAggregateMock.mockResolvedValue(EMPTY_TOKEN_AGG);
  passwordResetAggregateMock.mockResolvedValue(EMPTY_TOKEN_AGG);
});

function makeReq(memberId?: string) {
  const url = memberId
    ? `http://localhost/api/admin/dsar/export?memberId=${memberId}`
    : "http://localhost/api/admin/dsar/export";
  return new Request(url);
}

// The response body is a one-shot stream, so read it once and hand back both
// the parsed object and the raw JSON text (several assertions need the text).
async function exportJson(memberId = "m1") {
  const { GET } = await import("@/app/api/admin/dsar/export/route");
  const res = await GET(makeReq(memberId));
  const raw = await res.text();
  return { res, raw, body: JSON.parse(raw) };
}

describe("GET /api/admin/dsar/export — Assessment Fix #3", () => {
  it("returns 400 when memberId query param is missing", async () => {
    const { GET } = await import("@/app/api/admin/dsar/export/route");
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-tenant memberId (tenant scope enforced)", async () => {
    memberFindFirstMock.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/admin/dsar/export/route");
    const res = await GET(makeReq("foreign-member"));
    expect(res.status).toBe(404);
    // Confirm the lookup was tenant-scoped — the load-bearing assertion.
    expect(memberFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign-member", tenantId: "tenant-A" },
      }),
    );
  });

  it("returns a JSON download with Content-Disposition: attachment", async () => {
    const { res } = await exportJson();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="dsar-alice_example_com-/);
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("includes all 9 original collections in the export package", async () => {
    const { body } = await exportJson();

    // The 9 collections from the assessment doc + member + counts + meta.
    expect(body).toHaveProperty("member");
    expect(body).toHaveProperty("attendances");
    expect(body).toHaveProperty("payments");
    expect(body).toHaveProperty("orders");
    expect(body).toHaveProperty("signedWaivers");
    expect(body).toHaveProperty("classSubscriptions");
    expect(body).toHaveProperty("classPacks");
    expect(body).toHaveProperty("ranks");
    expect(body).toHaveProperty("emailLogs");
    expect(body).toHaveProperty("auditLogs");
    expect(body).toHaveProperty("counts");
    expect(body).toHaveProperty("_meta");
    expect(body._meta.version).toBe(2);
  });

  it("queries each PII collection scoped to the member (and tenant where the model has a tenantId column)", async () => {
    await exportJson();

    // Tenant-scoped collections (have tenantId column)
    expect(paymentFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" }) }),
    );
    expect(orderFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" }) }),
    );
    expect(waiverFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" }) }),
    );

    // EmailLog is queried by recipient (email) within the tenant
    expect(emailLogFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-A", recipient: "alice@example.com" }),
      }),
    );

    // AuditLog is queried by entity ref + tenant
    expect(auditLogFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-A",
          entityType: "Member",
          entityId: "m1",
        }),
      }),
    );
  });
});

describe("GET /api/admin/dsar/export — audit P1-7 Article 15 completeness", () => {
  it("carries the surfaces the export used to omit entirely", async () => {
    photoFindManyMock.mockResolvedValue([
      { id: "ph1", kind: "profile", caption: "Grading", url: BLOB_PHOTO_URL, uploadedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    loginEventFindManyMock.mockResolvedValue([
      {
        id: "le1",
        deviceHash: "hash-abc",
        ipApprox: "203.0.113.0/24",
        uaSummary: "Chrome 121 on Windows",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    pushFindManyMock.mockResolvedValue([
      { endpoint: "https://fcm.googleapis.com/fcm/send/abc", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    waitlistFindManyMock.mockResolvedValue([{ id: "wl1", position: 2, status: "waiting" }]);
    rosterFindManyMock.mockResolvedValue([{ id: "rs1", classId: "c1" }]);
    taskFindManyMock.mockResolvedValue([
      { id: "t1", title: "Renew waiver", body: "New insurance terms", status: "open", createdAt: "2026-03-01T00:00:00.000Z", completedAt: null },
    ]);
    magicLinkAggregateMock.mockResolvedValue({ _count: { _all: 6 }, _max: { createdAt: "2026-05-01T00:00:00.000Z" } });
    passwordResetAggregateMock.mockResolvedValue({ _count: { _all: 1 }, _max: { createdAt: "2026-04-01T00:00:00.000Z" } });

    const { body } = await exportJson();

    expect(body.memberPhotos).toHaveLength(1);
    expect(body.loginEvents[0]).toMatchObject({
      deviceHash: "hash-abc",
      ipApprox: "203.0.113.0/24",
      uaSummary: "Chrome 121 on Windows",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-02-01T00:00:00.000Z",
    });
    expect(body.pushSubscriptions).toHaveLength(1);
    expect(body.classWaitlists).toHaveLength(1);
    expect(body.classRosters).toHaveLength(1);
    expect(body.memberNotes[0]).toMatchObject({ title: "Renew waiver", body: "New insurance terms" });

    // Token surfaces are metadata-only: counts + latest createdAt.
    expect(body.authTokens).toEqual({
      magicLinkTokens: { count: 6, latestCreatedAt: "2026-05-01T00:00:00.000Z" },
      passwordResetTokens: { count: 1, latestCreatedAt: "2026-04-01T00:00:00.000Z" },
    });
    expect(body.counts).toMatchObject({
      memberPhotos: 1,
      loginEvents: 1,
      pushSubscriptions: 1,
      classWaitlists: 1,
      classRosters: 1,
      memberNotes: 1,
      magicLinkTokens: 6,
      passwordResetTokens: 1,
    });
  });

  it("scopes the new surfaces to the member (and tenant where the column exists)", async () => {
    await exportJson();

    const scoped = expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" });
    expect(photoFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: scoped }));
    expect(loginEventFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: scoped }));
    expect(pushFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: scoped }));
    expect(rosterFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: scoped }));
    // ClassWaitlist has no tenantId column — memberId is already tenant-bounded.
    expect(waitlistFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { memberId: "m1" } }),
    );
    // Only staff notes ADDRESSED to the member, never internal staff tasks.
    expect(taskFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "tenant-A", assigneeMemberId: "m1", kind: "member_note" },
      }),
    );
    expect(magicLinkAggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-A", email: "alice@example.com" } }),
    );
    expect(passwordResetAggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-A", email: "alice@example.com" } }),
    );
  });

  it("never exports Web Push encryption keys or token hashes", async () => {
    pushFindManyMock.mockResolvedValue([
      { endpoint: "https://fcm.googleapis.com/fcm/send/abc", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);

    const { raw, body } = await exportJson();

    // The select is the mechanism: p256dh/auth are live Web Push credentials
    // and are never read out of the database in the first place.
    expect(pushFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ select: { endpoint: true, createdAt: true } }),
    );
    expect(Object.keys(body.pushSubscriptions[0])).toEqual(["endpoint", "createdAt"]);
    expect(raw).not.toContain("tokenHash");
    // ...and the aggregate is a count, not a row dump.
    expect(magicLinkAggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({ _count: { _all: true }, _max: { createdAt: true } }),
    );
  });
});

describe("GET /api/admin/dsar/export — audit P2-10 no raw storage URLs", () => {
  it("hands over the blob-image proxy URL for photos, never the blob URL", async () => {
    photoFindManyMock.mockResolvedValue([
      { id: "ph1", kind: "profile", caption: null, url: BLOB_PHOTO_URL, uploadedAt: "2026-01-01T00:00:00.000Z" },
      { id: "ph2", kind: "evidence", caption: null, url: "data:image/png;base64,AAAA", uploadedAt: "2026-01-02T00:00:00.000Z" },
    ]);

    const { raw, body } = await exportJson();

    expect(body.memberPhotos[0].url).toBe(
      `/api/blob-image?url=${encodeURIComponent(BLOB_PHOTO_URL)}`,
    );
    // data: fallbacks have no blob behind them and pass through unchanged.
    expect(body.memberPhotos[1].url).toBe("data:image/png;base64,AAAA");
    // The raw blob host must not appear anywhere unencoded in the payload.
    expect(raw).not.toContain("https://store1.blob.vercel-storage.com/photos/alice.jpg");
  });

  it("emits /api/waiver/{id}/signature instead of signatureImageUrl", async () => {
    waiverFindManyMock.mockResolvedValue([
      { id: "w1", signerName: "Alice", signatureImageUrl: BLOB_SIG_URL },
      { id: "w2", signerName: "Alice", signatureImageUrl: null },
    ]);
    waiverCountMock.mockResolvedValue(2);

    const { raw, body } = await exportJson();

    expect(body.signedWaivers.items[0].signatureImageUrl).toBe("/api/waiver/w1/signature");
    // A waiver with no signature stays null rather than inventing a URL.
    expect(body.signedWaivers.items[1].signatureImageUrl).toBeNull();
    expect(raw).not.toContain(BLOB_SIG_URL);
  });
});

describe("GET /api/admin/dsar/export — audit P1-7 truncation honesty", () => {
  it("marks truncated:true with the true total when rows were capped", async () => {
    emailLogFindManyMock.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    emailLogCountMock.mockResolvedValue(4321);
    auditLogFindManyMock.mockResolvedValue([{ id: "al1" }]);
    auditLogCountMock.mockResolvedValue(9000);

    const { body } = await exportJson();

    expect(body.emailLogs).toMatchObject({ total: 4321, truncated: true });
    expect(body.emailLogs.items).toHaveLength(2);
    expect(body.auditLogs).toMatchObject({ total: 9000, truncated: true });
    // counts report the TRUE totals, not the capped page length.
    expect(body.counts.emailLogs).toBe(4321);
    expect(body.counts.auditLogs).toBe(9000);
  });

  it("marks truncated:false when everything fitted", async () => {
    attendanceFindManyMock.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    attendanceCountMock.mockResolvedValue(2);
    paymentFindManyMock.mockResolvedValue([{ id: "p1" }]);
    paymentCountMock.mockResolvedValue(1);

    const { body } = await exportJson();

    expect(body.attendances).toMatchObject({ total: 2, truncated: false });
    expect(body.payments).toMatchObject({ total: 1, truncated: false });
    expect(body.emailLogs).toMatchObject({ total: 0, truncated: false, items: [] });
  });

  it("caps every unbounded history section (P2-9 memory safety) and declares the caps", async () => {
    const { body } = await exportJson();

    for (const m of [attendanceFindManyMock, paymentFindManyMock, orderFindManyMock, waiverFindManyMock]) {
      expect(m).toHaveBeenCalledWith(expect.objectContaining({ take: 5000 }));
    }
    for (const m of [emailLogFindManyMock, auditLogFindManyMock]) {
      expect(m).toHaveBeenCalledWith(expect.objectContaining({ take: 1000 }));
    }
    expect(body._meta.cappedSections.caps).toEqual({
      attendances: 5000,
      payments: 5000,
      orders: 5000,
      signedWaivers: 5000,
      emailLogs: 1000,
      auditLogs: 1000,
    });
  });
});

describe("GET /api/admin/dsar/export — audit P0-3 audit metadata", () => {
  it("audit-logs member.dsar_export with counts and a hashed, not cleartext, email", async () => {
    attendanceFindManyMock.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    attendanceCountMock.mockResolvedValue(2);
    paymentFindManyMock.mockResolvedValue([{ id: "p1" }]);
    paymentCountMock.mockResolvedValue(1);

    await exportJson();

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.dsar_export",
        entityType: "Member",
        entityId: "m1",
        metadata: expect.objectContaining({
          counts: expect.objectContaining({ attendances: 2, payments: 1 }),
        }),
      }),
    );

    const metadata = logAuditMock.mock.calls[0][0].metadata as Record<string, unknown>;
    // The cleartext address must be gone — running a SAR on an erased member
    // previously re-planted it in AuditLog (audit §5).
    expect(metadata).not.toHaveProperty("memberEmail");
    expect(JSON.stringify(metadata)).not.toContain("alice@example.com");
    // HMAC-SHA256 hex, not a 32-bit hashSnippet.
    expect(metadata.memberEmailHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
