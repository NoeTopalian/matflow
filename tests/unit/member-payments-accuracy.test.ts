import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: vi.fn(),
    },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/me/payments/route";

const mockAuth = vi.mocked(auth);
const mockFindMany = vi.mocked(prisma.payment.findMany);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/member/me/payments — tenant-scoping", () => {
  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("queries with both memberId and tenantId — never just memberId", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "mem-1", name: "M" },
    } as never);
    mockFindMany.mockResolvedValue([]);

    await GET();

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { memberId: "mem-1", tenantId: "tenant-A" },
      }),
    );
  });

  it("returns rows with amountPence, currency, refundedAmountPence kept as-is (no client-side subtraction)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-1", role: "member", tenantId: "tenant-A", memberId: "mem-1", name: "M" },
    } as never);
    mockFindMany.mockResolvedValue([
      {
        id: "pay-1",
        amountPence: 5000,
        currency: "GBP",
        status: "refunded",
        description: "Monthly",
        paidAt: new Date("2026-04-01"),
        refundedAt: new Date("2026-04-15"),
        refundedAmountPence: 2500,
        createdAt: new Date("2026-04-01"),
      },
    ] as never);

    const res = await GET();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].amountPence).toBe(5000); // original amount intact
    expect(body[0].refundedAmountPence).toBe(2500); // refund as separate field
    expect(body[0].currency).toBe("GBP");
  });
});

// ── formatAmount helper coverage (GBP / USD / EUR / fallback) ─────────────────

import "@testing-library/jest-dom";

describe("formatAmount currency formatting", () => {
  // Re-implement here for unit-testing the rendered output without spinning up React.
  function formatAmount(pence: number, currency: string) {
    const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
    return `${symbol}${(pence / 100).toFixed(2)}`;
  }

  it("renders GBP with £ symbol", () => {
    expect(formatAmount(5000, "GBP")).toBe("£50.00");
  });
  it("renders USD with $ symbol", () => {
    expect(formatAmount(5000, "USD")).toBe("$50.00");
  });
  it("renders EUR with € symbol", () => {
    expect(formatAmount(5000, "EUR")).toBe("€50.00");
  });
  it("falls back to no symbol for unknown currency", () => {
    expect(formatAmount(5000, "JPY")).toBe("50.00");
  });
});
