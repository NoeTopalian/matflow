import { vi, describe, it, expect, beforeEach } from "vitest";

// Wizard v2 Step 13 — white-glove CSV handoff endpoint.
// Verifies file validation, ImportJob row creation with status='pending_white_glove',
// internal email dispatch, and audit logging. Cross-tenant impossible because
// the route uses requireOwner() which injects tenantId from session.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { createMock, findUniqueUserMock, findUniqueTenantMock, sendEmailMock, logAuditMock, blobPutMock, requireOwnerMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
  findUniqueTenantMock: vi.fn(),
  sendEmailMock: vi.fn().mockResolvedValue({ ok: true }),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  blobPutMock: vi.fn(),
  requireOwnerMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { create: createMock },
    tenant: { findUnique: findUniqueTenantMock },
    user: { findUnique: findUniqueUserMock },
  },
}));

vi.mock("@/lib/authz", () => ({
  requireOwner: requireOwnerMock,
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@vercel/blob", () => ({ put: blobPutMock }));

vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  requireOwnerMock.mockResolvedValue({
    tenantId: "tenant-A",
    userId: "user-owner-A",
    role: "owner",
  });
  findUniqueTenantMock.mockResolvedValue({ name: "Test Gym" });
  findUniqueUserMock.mockResolvedValue({ name: "Alice Owner", email: "alice@gym.com" });
  blobPutMock.mockResolvedValue({ url: "https://blob.test/imports/handoff-abc.csv" });
});

function makeReq(opts?: { file?: File | null; notes?: string }) {
  const fd = new FormData();
  if (opts?.file !== null) {
    const file = opts?.file ?? new File(["name,email\nAlice,alice@x.com"], "members.csv", { type: "text/csv" });
    fd.append("file", file);
  }
  if (opts?.notes !== undefined) fd.append("notes", opts.notes);
  return new Request("http://localhost/api/onboarding/csv-handoff", {
    method: "POST",
    body: fd,
  });
}

describe("POST /api/onboarding/csv-handoff", () => {
  it("returns 503 when BLOB_READ_WRITE_TOKEN is unset", async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    const res = await POST(makeReq());
    expect(res.status).toBe(503);
    expect(blobPutMock).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is provided", async () => {
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    const res = await POST(makeReq({ file: null }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 when file exceeds 10MB", async () => {
    const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.csv", { type: "text/csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    const res = await POST(makeReq({ file: big }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 400 when file is not CSV (rejected MIME + extension)", async () => {
    const png = new File(["fake"], "image.png", { type: "image/png" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    const res = await POST(makeReq({ file: png }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates ImportJob with status='pending_white_glove' on success", async () => {
    createMock.mockResolvedValueOnce({ id: "job-xyz", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    const res = await POST(makeReq({ notes: "Members exported from MindBody last week" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.jobId).toBe("job-xyz");
    expect(body.message).toMatch(/1 business day/i);

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-A",
        createdById: "user-owner-A",
        source: "generic",
        fileName: "members.csv",
        fileBlobUrl: "https://blob.test/imports/handoff-abc.csv",
        status: "pending_white_glove",
      }),
    });
  });

  it("emails the internal team with the gym name + download URL + notes", async () => {
    process.env.MATFLOW_APPLICATIONS_TO = "ops@matflow.io,team@matflow.io";
    createMock.mockResolvedValueOnce({ id: "job-1", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    await POST(makeReq({ notes: "Please double-check the phone formatting" }));

    expect(sendEmailMock).toHaveBeenCalledTimes(2); // both recipients
    const firstCall = sendEmailMock.mock.calls[0][0];
    expect(firstCall.templateId).toBe("csv_handoff_internal");
    expect(firstCall.vars).toMatchObject({
      gymName: "Test Gym",
      contactName: "Alice Owner",
      contactEmail: "alice@gym.com",
      fileName: "members.csv",
      downloadUrl: "https://blob.test/imports/handoff-abc.csv",
      notes: "Please double-check the phone formatting",
      jobId: "job-1",
    });
  });

  it("audit-logs onboarding.csv_handoff with metadata", async () => {
    createMock.mockResolvedValueOnce({ id: "job-1", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    await POST(makeReq({ notes: "Some notes" }));
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "onboarding.csv_handoff",
        entityType: "ImportJob",
        entityId: "job-1",
        metadata: expect.objectContaining({
          fileName: "members.csv",
          notes: "Some notes",
        }),
      }),
    );
  });

  it("trims notes and caps at 500 chars", async () => {
    const longNotes = "x".repeat(600);
    createMock.mockResolvedValueOnce({ id: "job-1", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    await POST(makeReq({ notes: `   ${longNotes}   ` }));
    const auditCall = logAuditMock.mock.calls[0][0];
    expect(auditCall.metadata.notes.length).toBe(500);
    expect(auditCall.metadata.notes).not.toMatch(/^\s/);
  });
});
