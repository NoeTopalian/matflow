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

process.env.BLOB_READ_WRITE_TOKEN = "test-token";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/waiver/sign/route";

const mockAuth = vi.mocked(auth);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);

const VALID_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/waiver/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
});

// ── Test 1: Reject when emergency contact is missing ──────────────────────────

describe("POST /api/waiver/sign — emergency contact gate", () => {
  it("rejects with 400 when member has no emergency contact in DB", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "member-1", name: "Alice" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      emergencyContactName: null,
      emergencyContactPhone: null,
      emergencyContactRelation: null,
    } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "Alice Member",
      agreedTo: true,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/emergency contact/i);

    // No SignedWaiver row should have been created
    expect(prisma.signedWaiver.create).not.toHaveBeenCalled();
  });

  it("rejects with 400 when emergencyContactRelation is missing but name+phone are set", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "member-1", name: "Alice" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      emergencyContactName: "Bob",
      emergencyContactPhone: "07700900000",
      emergencyContactRelation: null,
    } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "Alice Member",
      agreedTo: true,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(prisma.signedWaiver.create).not.toHaveBeenCalled();
  });

  it("rejects with 400 when emergency contact fields are present but only whitespace", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "member-1", name: "Alice" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      emergencyContactName: "   ",
      emergencyContactPhone: "   ",
      emergencyContactRelation: "   ",
    } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "Alice Member",
      agreedTo: true,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(prisma.signedWaiver.create).not.toHaveBeenCalled();
  });

  it("returns 201 when all three emergency contact fields are populated", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "member-1", name: "Alice" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      emergencyContactName: "Bob Smith",
      emergencyContactPhone: "07700900000",
      emergencyContactRelation: "Spouse",
    } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "Alice Member",
      agreedTo: true,
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    expect(prisma.signedWaiver.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          collectedBy: "self",
          memberId: "member-1",
          tenantId: "tenant-A",
        }),
      }),
    );
  });
});

// ── Test 2: Tenant scope on the member lookup ─────────────────────────────────

describe("POST /api/waiver/sign — tenant-scoped member lookup", () => {
  it("queries findFirst with both id AND tenantId from session", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "member-1", name: "Alice" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      emergencyContactName: "Bob",
      emergencyContactPhone: "07700900000",
      emergencyContactRelation: "Spouse",
    } as never);

    const req = makeRequest({
      signatureDataUrl: VALID_PNG_DATA_URL,
      signerName: "Alice Member",
      agreedTo: true,
    });

    await POST(req);

    expect(mockMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-1", tenantId: "tenant-A" },
      }),
    );
  });
});
