import { vi, describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// Wizard v2 Step 13 — white-glove CSV handoff endpoint.
// Verifies file validation, ImportJob row creation with status='pending_white_glove',
// internal email dispatch, and audit logging. Cross-tenant impossible because
// the route uses requireOwner() which injects tenantId from session.

// The fake prisma below does not model the RateLimitHit store; the limiter is assumed to allow (lane C4, R6-N3).
vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { createMock, findUniqueUserMock, findUniqueTenantMock, sendEmailMock, logAuditMock, blobPutMock, requireOwnerMock, findFirstMock, executeRawMock, delMock, auditFindFirstMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  findUniqueUserMock: vi.fn(),
  findUniqueTenantMock: vi.fn(),
  sendEmailMock: vi.fn().mockResolvedValue({ ok: true }),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  blobPutMock: vi.fn(),
  requireOwnerMock: vi.fn(),
  findFirstMock: vi.fn(),
  executeRawMock: vi.fn(),
  delMock: vi.fn(),
  auditFindFirstMock: vi.fn(),
}));

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    importJob: { create: createMock, findFirst: findFirstMock },
    $executeRaw: executeRawMock,
    auditLog: { findFirst: auditFindFirstMock },
    tenant: { findUnique: findUniqueTenantMock },
    user: { findUnique: findUniqueUserMock },
  },
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, ...(await requireOwnerMock()) }),
}));

vi.mock("@/lib/authz", () => ({
  requireOwner: requireOwnerMock,
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@vercel/blob", () => ({ put: blobPutMock, del: delMock }));

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
  findUniqueTenantMock.mockResolvedValue({ name: "Test Gym", slug: "test-gym" });
  findUniqueUserMock.mockResolvedValue({ name: "Alice Owner", email: "alice@gym.com" });
  blobPutMock.mockResolvedValue({ url: "https://blob.test/imports/handoff-abc.csv" });
  findFirstMock.mockResolvedValue(null);
  executeRawMock.mockResolvedValue(1);
  delMock.mockResolvedValue(undefined);
  auditFindFirstMock.mockResolvedValue(null);
});

const DEFAULT_CSV = "name,email\nAlice,alice@example.test";
const DEFAULT_HASH = createHash("sha256").update(DEFAULT_CSV).digest("hex");

function makeReq(opts?: { file?: File | null; notes?: string; clientRef?: string }) {
  const fd = new FormData();
  if (opts?.file !== null) {
    const file = opts?.file ?? new File([DEFAULT_CSV], "members.csv", { type: "text/csv" });
    fd.append("file", file);
  }
  if (opts?.notes !== undefined) fd.append("notes", opts.notes);
  if (opts?.clientRef !== undefined) fd.append("clientRef", opts.clientRef);
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

  // Mail-dark (7 Oct 2026): the confirmation promised an email ("we'll email
  // you when they're ready") and implied the team had been told, whatever the
  // notification sends returned.
  it("with email turned off, the confirmation promises no email and says the team was not notified", async () => {
    process.env.EMAIL_DELIVERY = "off";
    try {
      createMock.mockResolvedValueOnce({ id: "job-off", fileName: "members.csv" });
      sendEmailMock.mockResolvedValue({ ok: false, logId: "l", suppressed: "delivery_off" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({}));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.teamNotified).toBe(false);
      expect(body.message).toMatch(/Email is turned off for this club/);
      expect(body.message).not.toMatch(/email you when/i);
    } finally {
      delete process.env.EMAIL_DELIVERY;
      sendEmailMock.mockResolvedValue({ ok: true });
    }
  });

  it("when no notification reaches the team (delivery on), the owner is told to email us", async () => {
    createMock.mockResolvedValueOnce({ id: "job-fail", fileName: "members.csv" });
    sendEmailMock.mockResolvedValue({ ok: false, logId: "l" });
    try {
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({}));
      const body = await res.json();
      expect(body.teamNotified).toBe(false);
      expect(body.message).toMatch(/hello@matflow\.studio/);
    } finally {
      sendEmailMock.mockResolvedValue({ ok: true });
    }
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
    // No turnaround or delivery promise (onboarding batch 1, 17 Oct 2026).
    expect(body.message).not.toMatch(/business day|email you|within/i);
    expect(body.message).toMatch(/notification about it was sent to the MatFlow team/);

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

  it("emails the internal team with the gym name + job id + tenant slug + notes", async () => {
    process.env.MATFLOW_APPLICATIONS_TO = "ops@matflow.io,team@matflow.io";
    createMock.mockResolvedValueOnce({ id: "job-1", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    await POST(makeReq({ notes: "Please double-check the phone formatting" }));

    expect(sendEmailMock).toHaveBeenCalledTimes(2); // both recipients
    const firstCall = sendEmailMock.mock.calls[0][0];
    expect(firstCall.templateId).toBe("csv_handoff_internal");
    expect(firstCall.vars).toMatchObject({
      gymName: "Test Gym",
      tenantSlug: "test-gym",
      contactName: "Alice Owner",
      contactEmail: "alice@gym.com",
      fileName: "members.csv",
      notes: "Please double-check the phone formatting",
      jobId: "job-1",
    });
  });

  // Audit P0-1: the blob holds raw member PII. It must be uploaded private,
  // and its URL must never reach an inbox — operators open the CSV through
  // the authenticated admin import flow using the job id.
  it("uploads the CSV as a private blob", async () => {
    createMock.mockResolvedValueOnce({ id: "job-1", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    await POST(makeReq());
    expect(blobPutMock).toHaveBeenCalledWith(
      expect.stringContaining("tenants/tenant-A/imports/handoff-"),
      expect.any(File),
      expect.objectContaining({ access: "private", contentType: "text/csv", addRandomSuffix: true }),
    );
  });

  it("never puts the blob URL in the internal email", async () => {
    process.env.MATFLOW_APPLICATIONS_TO = "ops@matflow.io";
    createMock.mockResolvedValueOnce({ id: "job-1", fileName: "members.csv" });
    const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
    await POST(makeReq({ notes: "Some notes" }));

    const vars = sendEmailMock.mock.calls[0][0].vars;
    expect(vars).not.toHaveProperty("downloadUrl");
    expect(JSON.stringify(vars)).not.toContain("https://blob.test/");
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

  // ── Round 4, carried twice: the caller's fault was hidden behind ours ─────
  //
  // `route.ts:41-43` checked `BLOB_READ_WRITE_TOKEN` before it read the form
  // at all, so on any deployment without blob storage an empty upload, a
  // .docx and a 20 MB file were ALL answered 503 "File uploads not
  // configured". Three costs, the same three the initiative-attachments route
  // was fixed for in round 2: the refusals the product is supposed to make
  // were unprovable in any environment; a 5xx tells the owner to retry
  // something that can never work; and the message is about our storage
  // rather than about their file. Validation is the caller's business and
  // storage is ours, so the caller's half is settled first and the 503 is
  // reached only by a file that would otherwise have been stored.
  //
  // The oversize case is judged from `Content-Length` before the body is read,
  // because Next truncates the body clone it makes for the proxy at 10 MB
  // (node_modules/next/dist/server/body-streams.js:30, 93-103) and the
  // handler is then given a multipart body cut off mid-part.
  describe("a bad upload is refused on its merits, not on the storage config", () => {
    it("no file is 400 even with no blob token, not 503", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ file: null }));
      expect(res.status, "an empty upload is the caller's fault, forever").toBe(400);
      expect(blobPutMock).not.toHaveBeenCalled();
    });

    it("a .png is 400 even with no blob token, not 503", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const png = new File(["fake"], "image.png", { type: "image/png" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ file: png }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/csv/i) });
    });

    it("an 11 MB file is 400 even with no blob token, not 503", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.csv", { type: "text/csv" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ file: big }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/too large/i) });
    });

    it("a body that DECLARES 20 MB is refused for its size, before it is read", async () => {
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const truncated = [
        "------x",
        'Content-Disposition: form-data; name="file"; filename="big.csv"',
        "Content-Type: text/csv",
        "",
        "a,b,c", // the body stops here — no closing boundary
      ].join("\r\n");
      const res = await POST(
        new Request("http://localhost/api/onboarding/csv-handoff", {
          method: "POST",
          headers: {
            "Content-Type": "multipart/form-data; boundary=----x",
            "Content-Length": String(20 * 1024 * 1024),
          },
          body: truncated,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/too large/i) });
      expect(blobPutMock).not.toHaveBeenCalled();
    });

    it("a valid CSV with no token still gets the honest 503", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq());
      expect(res.status, "our config is our problem, and it is a 5xx").toBe(503);
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  // Onboarding batch 1 (16 Oct 2026): a retry after a lost response must not
  // store the file again, create a second job or email the team twice.
  describe("clientRef: a retried hand-off is received once", () => {
    const REF = "0123456789abcdef0123456789abcdef";

    it("a fresh reference is stored under that reference, behind a per-reference lock", async () => {
      createMock.mockResolvedValueOnce({ id: "job-new", fileName: "members.csv" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(201);
      expect(blobPutMock.mock.calls[0][0]).toBe(`tenants/tenant-A/imports/handoff-${REF}.csv`);
      expect(executeRawMock).toHaveBeenCalledTimes(1);
      expect(createMock).toHaveBeenCalledTimes(1);
      // Both lookups are scoped to this club, this owner and this reference.
      expect(findFirstMock).toHaveBeenCalledTimes(2);
      for (const [arg] of findFirstMock.mock.calls) {
        expect(arg.where).toEqual({ tenantId: "tenant-A", createdById: "user-owner-A", status: "pending_white_glove", fileBlobUrl: { contains: `/handoff-${REF}` } });
      }
    });

    it("a reference that already arrived returns that job: nothing stored, created or emailed", async () => {
      findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ jobId: "job-first", alreadyReceived: true });
      expect(blobPutMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(logAuditMock).not.toHaveBeenCalled();
    });

    it("a retry that overlaps the first attempt creates no second job and drops its copy of the file", async () => {
      findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
      blobPutMock.mockResolvedValueOnce({ url: `https://blob.test/imports/handoff-${REF}-x1.csv` });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ jobId: "job-first", alreadyReceived: true });
      expect(createMock).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(delMock).toHaveBeenCalledWith(`https://blob.test/imports/handoff-${REF}-x1.csv`);
    });

    // Final review (16 Oct 2026): the owner may never have seen the first
    // reply, so a replay must say what that reply would have said.
    it("a replay with email off repeats that the team was not notified", async () => {
      process.env.EMAIL_DELIVERY = "off";
      try {
        findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
        const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
        const body = await (await POST(makeReq({ clientRef: REF }))).json();
        expect(body.message).toMatch(/already have this file/i);
        expect(body.message).toMatch(/Email is turned off for this club/);
      } finally {
        delete process.env.EMAIL_DELIVERY;
      }
    });

    it("a replay says the team was told only when the first attempt recorded it", async () => {
      findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
      auditFindFirstMock.mockResolvedValueOnce({ metadata: { teamNotified: true } });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const body = await (await POST(makeReq({ clientRef: REF }))).json();
      expect(body.message).toMatch(/A notification about it was sent to the MatFlow team/);
      expect(auditFindFirstMock.mock.calls[0][0].where).toEqual({ tenantId: "tenant-A", action: "onboarding.csv_handoff", entityId: "job-first" });
    });

    it("a replay with no record of notifying the team says so and gives the address", async () => {
      for (const row of [null, { metadata: { teamNotified: false } }, { metadata: {} }]) {
        findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
        auditFindFirstMock.mockResolvedValueOnce(row);
        const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
        const body = await (await POST(makeReq({ clientRef: REF }))).json();
        expect(body.message).toMatch(/can't confirm the MatFlow team was told/);
        expect(body.message).toMatch(/hello@matflow\.studio/);
      }
    });

    it("the first attempt records whether the team was reached, for a later replay", async () => {
      createMock.mockResolvedValueOnce({ id: "job-new", fileName: "members.csv" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      await POST(makeReq({ clientRef: REF }));
      expect(logAuditMock.mock.calls[0][0].metadata).toMatchObject({ teamNotified: true });
    });

    it("a replay reports whether the notes sent now match what the first upload stored", async () => {
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const cases: Array<[unknown, string | undefined, boolean | null]> = [
        [{ metadata: { notes: "phones in G" } }, "phones in G", true],
        [{ metadata: { notes: "phones in G" } }, "something else", false],
        [{ metadata: { notes: null } }, undefined, true],
        [null, "anything", null],
      ];
      for (const [row, notes, expected] of cases) {
        findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
        auditFindFirstMock.mockResolvedValueOnce(row);
        const body = await (await POST(makeReq({ clientRef: REF, notes }))).json();
        expect(body.notesMatch).toBe(expected);
      }
    });

    it("changed notes on a replay are reported in the same channel as the reply", async () => {
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
      auditFindFirstMock.mockResolvedValueOnce({ metadata: { notes: "first", teamNotified: true } });
      const on = await (await POST(makeReq({ clientRef: REF, notes: "second" }))).json();
      expect(on.message).toMatch(/weren't added — email them to hello@matflow\.studio/);
      process.env.EMAIL_DELIVERY = "off";
      try {
        findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
        auditFindFirstMock.mockResolvedValueOnce({ metadata: { notes: "first" } });
        const off = await (await POST(makeReq({ clientRef: REF, notes: "second" }))).json();
        expect(off.message).toMatch(/let your MatFlow contact know/);
        expect(off.message).toMatch(/weren't added — pass them to your MatFlow contact too/);
        expect(off.message).not.toMatch(/hello@/);
      } finally {
        delete process.env.EMAIL_DELIVERY;
      }
    });

    it("a failed durable audit write is logged, not swallowed silently", async () => {
      createMock.mockResolvedValueOnce({ id: "job-new", fileName: "members.csv" });
      logAuditMock.mockRejectedValueOnce(new Error("audit store down"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      expect((await POST(makeReq({ clientRef: REF }))).status).toBe(201);
      expect(warn).toHaveBeenCalledWith("[onboarding/csv-handoff] audit write failed", "audit store down");
      warn.mockRestore();
    });

    it("the uploads-unavailable 503 carries a machine code the wizard can tell apart", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq());
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "uploads_unavailable" });
    });

    it("the hand-off audit row is written durably (awaited), and its failure does not fail the upload", async () => {
      createMock.mockResolvedValueOnce({ id: "job-new", fileName: "members.csv" });
      logAuditMock.mockRejectedValueOnce(new Error("audit store down"));
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(201);
      expect(logAuditMock.mock.calls[0][0]).toMatchObject({ durable: true });
    });

    it("the same reference with different file content is refused, not replayed (CSV-2)", async () => {
      findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: "0".repeat(64) });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "handoff_ref_mismatch" });
      expect(blobPutMock).not.toHaveBeenCalled();
      expect(createMock).not.toHaveBeenCalled();
    });

    it("an overlapping retry with different content is refused and its copy dropped (CSV-2)", async () => {
      findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "job-first", fileHash: "0".repeat(64) });
      blobPutMock.mockResolvedValueOnce({ url: `https://blob.test/imports/handoff-${REF}-x2.csv` });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(409);
      expect(createMock).not.toHaveBeenCalled();
      expect(delMock).toHaveBeenCalledWith(`https://blob.test/imports/handoff-${REF}-x2.csv`);
    });

    it("a new job records the content hash it was made from (CSV-2)", async () => {
      createMock.mockResolvedValueOnce({ id: "job-new", fileName: "members.csv" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      await POST(makeReq({ clientRef: REF }));
      expect(createMock.mock.calls[0][0].data.fileHash).toBe(DEFAULT_HASH);
    });

    it("stored but the job transaction failed: the orphaned file is deleted (CSV-3)", async () => {
      blobPutMock.mockResolvedValueOnce({ url: `https://blob.test/imports/handoff-${REF}-x3.csv` });
      createMock.mockRejectedValueOnce(new Error("db down"));
      findFirstMock.mockResolvedValue(null);
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      const res = await POST(makeReq({ clientRef: REF }));
      expect(res.status).toBe(500);
      expect(delMock).toHaveBeenCalledWith(`https://blob.test/imports/handoff-${REF}-x3.csv`);
    });

    it("a job does point at the stored file (commit landed, answer lost): nothing is deleted (CSV-3)", async () => {
      blobPutMock.mockResolvedValueOnce({ url: `https://blob.test/imports/handoff-${REF}-x4.csv` });
      createMock.mockRejectedValueOnce(new Error("connection reset after commit"));
      findFirstMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "job-landed" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      expect((await POST(makeReq({ clientRef: REF }))).status).toBe(500);
      expect(delMock).not.toHaveBeenCalled();
    });

    it("a stored URL without the reference marker is logged (CSV-4)", async () => {
      blobPutMock.mockResolvedValueOnce({ url: "https://blob.test/imports/reshaped-pathname.csv" });
      createMock.mockResolvedValueOnce({ id: "job-new", fileName: "members.csv" });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      expect((await POST(makeReq({ clientRef: REF }))).status).toBe(201);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/clientRef not in blob url/));
      err.mockRestore();
    });

    it("a replay follows what the first attempt recorded, not today's mail setting", async () => {
      process.env.EMAIL_DELIVERY = "off";
      try {
        findFirstMock.mockResolvedValueOnce({ id: "job-first", fileHash: DEFAULT_HASH });
        auditFindFirstMock.mockResolvedValueOnce({ metadata: { teamNotified: true } });
        const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
        const body = await (await POST(makeReq({ clientRef: REF }))).json();
        expect(body.message).toMatch(/A notification about it was sent to the MatFlow team/);
        expect(body.message).not.toMatch(/not notified/i);
      } finally {
        delete process.env.EMAIL_DELIVERY;
      }
    });

    it("a malformed reference is refused before anything is stored", async () => {
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      for (const bad of ["abc", "../../x", `${REF}0`, REF.toUpperCase()]) {
        const res = await POST(makeReq({ clientRef: bad }));
        expect(res.status).toBe(400);
      }
      expect(blobPutMock).not.toHaveBeenCalled();
      expect(findFirstMock).not.toHaveBeenCalled();
    });

    it("without a reference the route behaves as before (no lookup, no lock)", async () => {
      createMock.mockResolvedValueOnce({ id: "job-plain", fileName: "members.csv" });
      const { POST } = await import("@/app/api/onboarding/csv-handoff/route");
      expect((await POST(makeReq())).status).toBe(201);
      expect(findFirstMock).not.toHaveBeenCalled();
      expect(executeRawMock).not.toHaveBeenCalled();
    });
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
