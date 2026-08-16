import { vi, describe, it, expect, beforeEach } from "vitest";

// Audit P0-3 (storage/memory audit 2026-08-16 §5) — Article 17 erasure must be
// complete, not Member-row-only. Before this, a "completed" erase left face
// photos (rows + blob files), signature PNGs, a live TOTP secret, EmailLog
// recipients, LoginEvent device history, live push channels and email-keyed
// auth tokens intact. These tests pin every surface from §5.

const {
  requireRoleMock,
  checkRateLimitMock,
  logAuditMock,
  cancelSubscriptionMock,
  delMock,
  memberFindFirstMock,
  memberUpdateMock,
  tenantFindUniqueMock,
  photoFindManyMock,
  photoDeleteManyMock,
  waiverFindManyMock,
  waiverUpdateManyMock,
  loginEventCountMock,
  loginEventDeleteManyMock,
  pushCountMock,
  pushDeleteManyMock,
  notificationCountMock,
  notificationDeleteManyMock,
  taskCountMock,
  taskDeleteManyMock,
  magicLinkCountMock,
  magicLinkDeleteManyMock,
  passwordResetCountMock,
  passwordResetDeleteManyMock,
  emailLogCountMock,
  emailLogUpdateManyMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  logAuditMock: vi.fn(),
  cancelSubscriptionMock: vi.fn(),
  delMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  photoFindManyMock: vi.fn(),
  photoDeleteManyMock: vi.fn(),
  waiverFindManyMock: vi.fn(),
  waiverUpdateManyMock: vi.fn(),
  loginEventCountMock: vi.fn(),
  loginEventDeleteManyMock: vi.fn(),
  pushCountMock: vi.fn(),
  pushDeleteManyMock: vi.fn(),
  notificationCountMock: vi.fn(),
  notificationDeleteManyMock: vi.fn(),
  taskCountMock: vi.fn(),
  taskDeleteManyMock: vi.fn(),
  magicLinkCountMock: vi.fn(),
  magicLinkDeleteManyMock: vi.fn(),
  passwordResetCountMock: vi.fn(),
  passwordResetDeleteManyMock: vi.fn(),
  emailLogCountMock: vi.fn(),
  emailLogUpdateManyMock: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@prisma/client", () => ({
  Prisma: { DbNull: "__DbNull__", JsonNull: "__JsonNull__" },
}));

vi.mock("@vercel/blob", () => ({ del: delMock }));
vi.mock("@/lib/authz", () => ({ requireRole: requireRoleMock }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: cancelSubscriptionMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: memberFindFirstMock, update: memberUpdateMock },
    tenant: { findUnique: tenantFindUniqueMock },
    memberPhoto: { findMany: photoFindManyMock, deleteMany: photoDeleteManyMock },
    signedWaiver: { findMany: waiverFindManyMock, updateMany: waiverUpdateManyMock },
    loginEvent: { count: loginEventCountMock, deleteMany: loginEventDeleteManyMock },
    pushSubscription: { count: pushCountMock, deleteMany: pushDeleteManyMock },
    notification: { count: notificationCountMock, deleteMany: notificationDeleteManyMock },
    task: { count: taskCountMock, deleteMany: taskDeleteManyMock },
    magicLinkToken: { count: magicLinkCountMock, deleteMany: magicLinkDeleteManyMock },
    passwordResetToken: {
      count: passwordResetCountMock,
      deleteMany: passwordResetDeleteManyMock,
    },
    emailLog: { count: emailLogCountMock, updateMany: emailLogUpdateManyMock },
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

const MEMBER_ID = "m1";
const TENANT_ID = "tenant-A";
const ORIGINAL_EMAIL = "alice@example.com";
const SENTINEL = `deleted-${MEMBER_ID}@deleted.invalid`;

const BLOB_PHOTO_URL = "https://store1.blob.vercel-storage.com/photos/alice.jpg";
const DATA_PHOTO_URL = "data:image/png;base64,AAAA";
const BLOB_SIG_URL = "https://store1.blob.vercel-storage.com/sigs/alice.png";
const DATA_SIG_URL = "data:image/png;base64,BBBB";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});

  requireRoleMock.mockResolvedValue({
    session: { user: { id: "user-owner-A", tenantId: TENANT_ID } },
  });
  checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  logAuditMock.mockResolvedValue(undefined);
  cancelSubscriptionMock.mockResolvedValue({ ok: true, cancelAt: 1_800_000_000 });

  memberFindFirstMock.mockResolvedValue({
    id: MEMBER_ID,
    status: "active",
    email: ORIGINAL_EMAIL,
    stripeSubscriptionId: "sub_123",
  });
  memberUpdateMock.mockResolvedValue({});
  tenantFindUniqueMock.mockResolvedValue({ stripeAccountId: "acct_123" });

  photoFindManyMock.mockResolvedValue([
    { id: "photo-blob", url: BLOB_PHOTO_URL },
    { id: "photo-data", url: DATA_PHOTO_URL },
  ]);
  photoDeleteManyMock.mockResolvedValue({ count: 2 });
  waiverFindManyMock.mockResolvedValue([
    { id: "waiver-blob", signatureImageUrl: BLOB_SIG_URL },
    { id: "waiver-data", signatureImageUrl: DATA_SIG_URL },
    { id: "waiver-null", signatureImageUrl: null },
  ]);
  waiverUpdateManyMock.mockResolvedValue({ count: 3 });

  loginEventCountMock.mockResolvedValue(4);
  loginEventDeleteManyMock.mockResolvedValue({ count: 4 });
  pushCountMock.mockResolvedValue(2);
  pushDeleteManyMock.mockResolvedValue({ count: 2 });
  notificationCountMock.mockResolvedValue(0);
  notificationDeleteManyMock.mockResolvedValue({ count: 0 });
  taskCountMock.mockResolvedValue(5);
  taskDeleteManyMock.mockResolvedValue({ count: 5 });
  magicLinkCountMock.mockResolvedValue(6);
  magicLinkDeleteManyMock.mockResolvedValue({ count: 6 });
  passwordResetCountMock.mockResolvedValue(1);
  passwordResetDeleteManyMock.mockResolvedValue({ count: 1 });
  emailLogCountMock.mockResolvedValue(10);
  emailLogUpdateManyMock.mockResolvedValue({ count: 10 });

  delMock.mockResolvedValue(undefined);
});

function makeReq() {
  return new Request(`http://localhost/api/admin/dsar/erase?memberId=${MEMBER_ID}`, {
    method: "POST",
  });
}

async function erase() {
  const { POST } = await import("@/app/api/admin/dsar/erase/route");
  return POST(makeReq());
}

describe("POST /api/admin/dsar/erase — audit P0-3 erasure completeness", () => {
  it("scrubs every residual PII column on the Member row", async () => {
    await erase();

    expect(memberUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEMBER_ID },
        data: expect.objectContaining({
          name: "Deleted member",
          email: SENTINEL,
          // Columns that survived the old Member-row-only erase (§5).
          notes: null,
          waiverIpAddress: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          totpEnabled: false,
          totpSecret: null,
          totpRecoveryCodes: "__DbNull__",
          // Pre-existing behaviour must not regress.
          passwordHash: null,
          medicalConditions: null,
          status: "cancelled",
          sessionVersion: { increment: 1 },
        }),
      }),
    );
  });

  it("cancels the Stripe subscription before the id is nulled off the member", async () => {
    await erase();

    expect(cancelSubscriptionMock).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: "sub_123" }),
    );
    expect(cancelSubscriptionMock.mock.invocationCallOrder[0]).toBeLessThan(
      memberUpdateMock.mock.invocationCallOrder[0],
    );
  });

  it("deletes MemberPhoto, LoginEvent, PushSubscription and Notification rows", async () => {
    await erase();

    const scoped = { memberId: MEMBER_ID, tenantId: TENANT_ID };
    expect(photoDeleteManyMock).toHaveBeenCalledWith({ where: scoped });
    expect(loginEventDeleteManyMock).toHaveBeenCalledWith({ where: scoped });
    // PushSubscription carries memberId (set by /api/push/subscribe whenever the
    // session has one), so member push channels really are deleted here.
    expect(pushDeleteManyMock).toHaveBeenCalledWith({ where: scoped });
    expect(notificationDeleteManyMock).toHaveBeenCalledWith({ where: scoped });
  });

  it("deletes member_note Tasks addressed to the member, leaving staff_task alone", async () => {
    await erase();

    expect(taskDeleteManyMock).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, assigneeMemberId: MEMBER_ID, kind: "member_note" },
    });
  });

  it("scrubs SignedWaiver identity columns but keeps the legal-hold snapshot", async () => {
    await erase();

    expect(waiverUpdateManyMock).toHaveBeenCalledWith({
      where: { memberId: MEMBER_ID, tenantId: TENANT_ID },
      data: {
        signatureImageUrl: null,
        signerName: null,
        ipAddress: null,
        userAgent: null,
      },
    });

    // contentSnapshot / titleSnapshot / acceptedAt / memberId are retained
    // under GDPR Art. 17(3)(e) — asserting they are NOT in the update payload.
    const data = waiverUpdateManyMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("contentSnapshot");
    expect(data).not.toHaveProperty("titleSnapshot");
    expect(data).not.toHaveProperty("acceptedAt");
    expect(data).not.toHaveProperty("memberId");
  });

  it("deletes auth tokens by the ORIGINAL email, not the sentinel", async () => {
    await erase();

    expect(magicLinkDeleteManyMock).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, email: ORIGINAL_EMAIL },
    });
    expect(passwordResetDeleteManyMock).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, email: ORIGINAL_EMAIL },
    });
  });

  it("redacts EmailLog.recipient to the sentinel and leaves subject untouched", async () => {
    await erase();

    expect(emailLogUpdateManyMock).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID, recipient: ORIGINAL_EMAIL },
      data: { recipient: SENTINEL },
    });
    expect(emailLogUpdateManyMock.mock.calls[0][0].data).not.toHaveProperty("subject");
  });

  it("deletes photo + signature blobs, skips data: URLs, and runs after the DB commit", async () => {
    await erase();

    expect(delMock).toHaveBeenCalledWith(BLOB_PHOTO_URL);
    expect(delMock).toHaveBeenCalledWith(BLOB_SIG_URL);
    expect(delMock).not.toHaveBeenCalledWith(DATA_PHOTO_URL);
    expect(delMock).not.toHaveBeenCalledWith(DATA_SIG_URL);
    expect(delMock).toHaveBeenCalledTimes(2);

    // Blob deletion is non-transactional, so it must follow the DB writes.
    expect(delMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      photoDeleteManyMock.mock.invocationCallOrder[0],
    );
  });

  it("still erases when the Blob API fails on every file", async () => {
    delMock.mockRejectedValue(new Error("blob store unreachable"));

    const res = await erase();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, memberId: MEMBER_ID });
    expect(memberUpdateMock).toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("MemberPhoto photo-blob"),
      expect.any(Error),
    );
  });

  it("returns the original shape plus per-surface erase counts", async () => {
    const res = await erase();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.memberId).toBe(MEMBER_ID);
    expect(body.erasedAt).toEqual(expect.any(String));
    expect(body.erased).toEqual({
      memberPhotos: 2,
      signedWaiversScrubbed: 3,
      loginEvents: 4,
      pushSubscriptions: 2,
      notifications: 0,
      memberNoteTasks: 5,
      magicLinkTokens: 6,
      passwordResetTokens: 1,
      emailLogsRedacted: 10,
    });
  });

  it("records the erase counts in the pre-erase audit row", async () => {
    await erase();

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.dsar_erase",
        entityId: MEMBER_ID,
        metadata: expect.objectContaining({
          erasedCounts: expect.objectContaining({
            memberPhotos: 2,
            loginEvents: 4,
            emailLogsRedacted: 10,
          }),
        }),
      }),
    );
    // Fulfilment evidence must exist before anything is destroyed.
    expect(logAuditMock.mock.invocationCallOrder[0]).toBeLessThan(
      memberUpdateMock.mock.invocationCallOrder[0],
    );
  });
});
