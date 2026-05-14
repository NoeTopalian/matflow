// Verifies the data: URL fallback for waiver signing — closes the gap flagged
// as Check 7 in docs/KIDS-SYSTEM-VERIFICATION-2026-05-14.md.
//
// The three sign routes (member-self, parent-of-kid, staff-supervised) all
// previously hard-503'd when BLOB_READ_WRITE_TOKEN was unset. They now share
// `lib/waiver-signature-upload.ts` which falls back to a
// `data:image/png;base64,...` URL stored directly in
// SignedWaiver.signatureImageUrl. The proxy at
// `/api/waiver/[signedWaiverId]/signature` detects the data: prefix and
// decodes inline.
//
// Strategy: vi.stubEnv("BLOB_READ_WRITE_TOKEN", "") before importing the
// route, drive the parent-of-kid sign flow (covers the most user-facing
// surface), assert response is 201 (not 503) and that the persisted row's
// signatureImageUrl is a data: URL. Then call the proxy and assert it
// returns image/png bytes without attempting an upstream fetch.

import { vi, describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";

// NextResponse needs both shapes: static .json() for the sign routes AND a
// constructor form `new NextResponse(buf, { headers })` for the proxy's
// binary-bytes return path.
vi.mock("next/server", () => {
  class MockNextResponse {
    status: number;
    headers: Headers;
    private bodyValue: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.bodyValue = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers ?? {});
    }
    async json() { return this.bodyValue; }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

// A 1×1 transparent PNG, base64-encoded — minimum valid PNG that passes the
// PNG_MAGIC check the route uses.
const VALID_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function jsonReq(body: unknown): Request {
  return new Request("https://test.local/api/waiver/sign-for-child", {
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

describe.skipIf(!HAS_DB)("Waiver signing — data: URL fallback when Blob unavailable", () => {
  let tenantId: string;
  let parentId: string;
  let kidId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: "Waiver-Fallback", slug: `wfb-${STAMP}` },
      });
      tenantId = t.id;
      const parent = await tx.member.create({
        data: {
          tenantId,
          name: "Parent",
          email: `parent-${STAMP}@wfb.test`,
          // Parent needs the safeguarding trio set or the sign route will 400.
          emergencyContactName: "Emergency Person",
          emergencyContactPhone: "07000000000",
          emergencyContactRelation: "Friend",
        },
      });
      parentId = parent.id;
      const kid = await tx.member.create({
        data: {
          tenantId,
          name: "Kid",
          email: `kid-${STAMP}@kids.local`,
          parentMemberId: parent.id,
          accountType: "kids",
        },
      });
      kidId = kid.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass((tx) => tx.signedWaiver.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  beforeEach(() => {
    // Force the no-Blob path. `vi.stubEnv` resets between tests automatically.
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  });

  it("parent-of-kid sign returns 201 (not 503) when Blob token is unset", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);
    const { POST: signForChild } = await import("@/app/api/waiver/sign-for-child/route");

    const res = await signForChild(
      jsonReq({
        childMemberId: kidId,
        signatureDataUrl: VALID_PNG_DATA_URL,
        signerName: "Parent Person",
        agreedTo: true,
      }),
    );
    expect(res.status).toBe(201);
  });

  it("persists a data: URL in SignedWaiver.signatureImageUrl (not a blob.vercel-storage URL)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);
    const { POST: signForChild } = await import("@/app/api/waiver/sign-for-child/route");

    await signForChild(
      jsonReq({
        childMemberId: kidId,
        signatureDataUrl: VALID_PNG_DATA_URL,
        signerName: "Parent Person",
        agreedTo: true,
      }),
    );

    const row = await withRlsBypass((tx) =>
      tx.signedWaiver.findFirst({
        where: { memberId: kidId, tenantId },
        orderBy: { acceptedAt: "desc" },
        select: { signatureImageUrl: true },
      }),
    );
    expect(row?.signatureImageUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("flips kid.waiverAccepted to true on successful fallback path", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);
    const { POST: signForChild } = await import("@/app/api/waiver/sign-for-child/route");

    await signForChild(
      jsonReq({
        childMemberId: kidId,
        signatureDataUrl: VALID_PNG_DATA_URL,
        signerName: "Parent Person",
        agreedTo: true,
      }),
    );

    const kid = await withRlsBypass((tx) =>
      tx.member.findUnique({ where: { id: kidId }, select: { waiverAccepted: true } }),
    );
    expect(kid?.waiverAccepted).toBe(true);
  });

  it("proxy serves image/png bytes for a data: URL signature without upstream fetch", async () => {
    // First, sign so we have a SignedWaiver row whose signatureImageUrl is a
    // data: URL (other tests have already created some, but we want a known
    // fresh one so we can assert content-type cleanly).
    mockAuth.mockResolvedValue({
      user: { id: "u-parent", memberId: parentId, tenantId, role: "member", email: "parent" },
    } as never);
    const { POST: signForChild } = await import("@/app/api/waiver/sign-for-child/route");
    const signRes = await signForChild(
      jsonReq({
        childMemberId: kidId,
        signatureDataUrl: VALID_PNG_DATA_URL,
        signerName: "Parent Person",
        agreedTo: true,
      }),
    );
    const signBody = await signRes.json() as { signedWaiverId: string };

    // Spy on global fetch — the data: URL branch must NOT call it.
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(originalFetch);
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      // Authorise the same parent as a member-self read of the kid's signature.
      // The proxy treats parent as member-self because session.user.memberId
      // equals signed.memberId in the kid-of-parent case? No — that check is
      // signed.memberId === sessionMemberId. The signed row is for the KID
      // (memberId=kidId), but the parent is signed in. The proxy will return
      // 403 for a non-staff non-self viewer. So mock staff role instead.
      mockAuth.mockResolvedValue({
        user: { id: "u-owner", tenantId, role: "owner", email: "owner" },
      } as never);
      const { GET: proxy } = await import("@/app/api/waiver/[signedWaiverId]/signature/route");
      const res = await proxy(getReq() as never, { params: Promise.resolve({ signedWaiverId: signBody.signedWaiverId }) } as never);

      expect(res.status).toBe(200);
      const headers = (res as unknown as { headers: Headers }).headers;
      expect(headers.get("Content-Type")).toBe("image/png");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
