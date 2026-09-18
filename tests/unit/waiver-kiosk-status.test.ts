// GET /api/waiver/kiosk-status must say "signed" only when the member's
// waiver is actually accepted — not merely when the token has been marked
// used.
//
// `MagicLinkToken.used` is set by a real signature (app/api/waiver/open) AND
// by the invalidate-prior-links step of minting a fresh link (kiosk-request,
// members/[id]/waiver-link). The kiosk polls this route while the member is
// signing on their phone and checks them in the moment it says signed, and
// nothing server-side re-checks the waiver at check-in. So a coach sending a
// new waiver link while a member stood at the kiosk retired the kiosk's
// token, the poll answered "signed", and the tablet wrote an attendance row
// for a member with no waiver. The five-minute gate shipped in X-6 wave two
// made that window thirty times longer. X-6 seat Q1+Q5, wave two, M1.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { tokenFindUniqueMock, memberFindFirstMock, rateLimitMock } = vi.hoisted(() => ({
  tokenFindUniqueMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: rateLimitMock,
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      magicLinkToken: { findUnique: tokenFindUniqueMock },
      member: { findFirst: memberFindFirstMock },
    }),
}));

import { GET } from "@/app/api/waiver/kiosk-status/route";

const req = () => new Request("http://kiosk.test/api/waiver/kiosk-status?tokenId=tok_1");
const future = new Date(Date.now() + 60 * 60 * 1000);

describe("kiosk waiver status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitMock.mockResolvedValue({ allowed: true });
  });

  it("is signed when the token was used AND the member's waiver is accepted", async () => {
    tokenFindUniqueMock.mockResolvedValue({ purpose: "waiver_open", used: true, expiresAt: future, email: "sam@example.test", tenantId: "t1" });
    memberFindFirstMock.mockResolvedValue({ waiverAccepted: true });
    expect(await (await GET(req())).json()).toEqual({ signed: true });
  });

  it("is NOT signed when the token was merely retired by a fresh link (used, but no waiver on the member)", async () => {
    tokenFindUniqueMock.mockResolvedValue({ purpose: "waiver_open", used: true, expiresAt: future, email: "sam@example.test", tenantId: "t1" });
    memberFindFirstMock.mockResolvedValue({ waiverAccepted: false });
    expect(await (await GET(req())).json()).toEqual({ signed: false });
    // The member lookup is scoped to the token's own tenant and address.
    const where = memberFindFirstMock.mock.calls[0][0].where as { tenantId: string; email: string };
    expect(where).toEqual({ tenantId: "t1", email: "sam@example.test" });
  });

  it("is not signed while the token is unused, and reports expiry", async () => {
    tokenFindUniqueMock.mockResolvedValue({ purpose: "waiver_open", used: false, expiresAt: new Date(Date.now() - 1000), email: "sam@example.test", tenantId: "t1" });
    expect(await (await GET(req())).json()).toEqual({ signed: false, expired: true });
    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });

  it("is not signed for a token of another purpose", async () => {
    tokenFindUniqueMock.mockResolvedValue({ purpose: "login", used: true, expiresAt: future, email: "sam@example.test", tenantId: "t1" });
    expect(await (await GET(req())).json()).toEqual({ signed: false });
  });
});
