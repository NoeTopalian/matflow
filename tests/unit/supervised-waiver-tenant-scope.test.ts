import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({ name: "Test Gym", waiverTitle: null, waiverContent: null }),
    },
    signedWaiver: {
      create: vi.fn().mockResolvedValue({ id: "sw-1", signatureImageUrl: "https://blob.test/sig.png" }),
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@vercel/blob", () => ({
  put: vi.fn().mockResolvedValue({ url: "https://blob.test/sig.png" }),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  })),
}));

vi.mock("@/lib/default-waiver", () => ({
  buildDefaultWaiverTitle: vi.fn().mockReturnValue("Default Waiver Title"),
  buildDefaultWaiverContent: vi.fn().mockReturnValue("Default waiver content."),
}));

// Set BLOB_READ_WRITE_TOKEN so the route doesn't 503
process.env.BLOB_READ_WRITE_TOKEN = "test-token";

// Imports after mocks
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit-log";
import { POST } from "@/app/api/members/[id]/waiver/sign/route";

const mockAuth = vi.mocked(auth);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockLogAudit = vi.mocked(logAudit);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal valid PNG data URL (1x1 transparent PNG, ~68 bytes). */
const VALID_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/members/member-B/waiver/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: BLOB env set
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
});

// ── Test 1: Cross-tenant rejection ─────────────────────────────────────────────

describe("POST /api/members/[id]/waiver/sign — cross-tenant rejection", () => {
  it("returns 404 when member belongs to a different tenant", async () => {
    // Staff session is for tenant-A
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "owner", tenantId: "tenant-A", name: "Owner" },
    } as never);

    // findFirst returns null because member-B belongs to tenant-B, not tenant-A
    mockMemberFindFirst.mockResolvedValue(null);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "John Smith",
      agreedTo: true,
    });

    const res = await POST(req, makeParams("member-from-tenant-B"));
    expect(res.status).toBe(404);

    // Confirm it was called with tenant-A's tenantId
    expect(mockMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-A" }),
      }),
    );

    // No waiver should have been created
    expect(prisma.signedWaiver.create).not.toHaveBeenCalled();
  });
});

// ── Test 2: collectedBy format ─────────────────────────────────────────────────

describe("POST /api/members/[id]/waiver/sign — collectedBy format", () => {
  it("sets collectedBy to admin_device:{userId} in audit log metadata", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-xyz", role: "owner", tenantId: "tenant-A", name: "Owner" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({ id: "member-1", name: "John Smith" } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "John Smith",
      agreedTo: true,
    });

    const res = await POST(req, makeParams("member-1"));
    expect(res.status).toBe(201);

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          collectedBy: "admin_device:user-xyz",
        }),
      }),
    );

    // Also check that prisma.signedWaiver.create was called with the correct collectedBy
    expect(prisma.signedWaiver.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          collectedBy: "admin_device:user-xyz",
        }),
      }),
    );
  });
});

// ── Test 3: Member role rejection ──────────────────────────────────────────────

describe("POST /api/members/[id]/waiver/sign — member role rejection", () => {
  it("returns 403 when the session user has the 'member' role", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-2", role: "member", tenantId: "tenant-A", name: "Regular Member" },
    } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "John Smith",
      agreedTo: true,
    });

    const res = await POST(req, makeParams("member-1"));
    expect(res.status).toBe(403);

    // No DB lookups should have occurred
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
    expect(prisma.signedWaiver.create).not.toHaveBeenCalled();
  });
});
