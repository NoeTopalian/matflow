// One list of payment methods, or the surfaces drift — and they had.
//
// `app/api/payments/manual` accepts cash | exempt | external | comp | other.
// `RecordPaymentModal` kept its own identical copy. And the member profile's
// "Record payment" drawer posted `method: "manual"` — a value nothing has ever
// accepted — so THAT SURFACE RETURNED 400 ON EVERY ATTEMPT, for its entire
// life, while the payments hub worked perfectly. Nobody noticed precisely
// because the other surface worked.
//
// The list, the two predicates and the form check now live in one module that
// the route and both surfaces import. These tests defend the two things that
// could quietly undo it: an invalid method literal reappearing at a call site,
// and the route accepting something the pickers do not offer.

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MANUAL_PAYMENT_METHODS,
  MANUAL_PAYMENT_METHOD_VALUES,
  manualPaymentFormIsValid,
  isFreeMethod,
  methodNeedsNotes,
} from "@/lib/payment-methods";

describe("the shared method list", () => {
  it("offers exactly the five the route accepts", () => {
    expect([...MANUAL_PAYMENT_METHOD_VALUES].sort()).toEqual(
      ["cash", "comp", "exempt", "external", "other"].sort(),
    );
    expect(MANUAL_PAYMENT_METHODS.every((m) => m.label.trim().length > 0)).toBe(true);
  });

  it("knows which methods legitimately record £0", () => {
    expect(isFreeMethod("comp")).toBe(true);
    expect(isFreeMethod("exempt")).toBe(true);
    expect(isFreeMethod("cash")).toBe(false);
    // The defect value itself must never read as free.
    expect(isFreeMethod("manual")).toBe(false);
  });

  it("requires notes only for 'other'", () => {
    expect(methodNeedsNotes("other")).toBe(true);
    expect(methodNeedsNotes("cash")).toBe(false);
  });
});

describe("manualPaymentFormIsValid — the button and the server agree", () => {
  it("accepts cash with a real amount", () => {
    expect(manualPaymentFormIsValid({ description: "", amount: "40", method: "cash" })).toBe(true);
  });

  it("refuses cash at £0 — the route refuses it too", () => {
    expect(manualPaymentFormIsValid({ description: "x", amount: "0", method: "cash" })).toBe(false);
    expect(manualPaymentFormIsValid({ description: "x", amount: "", method: "cash" })).toBe(false);
  });

  it("accepts comp and exempt at £0", () => {
    expect(manualPaymentFormIsValid({ description: "", amount: "", method: "comp" })).toBe(true);
    expect(manualPaymentFormIsValid({ description: "", amount: "0", method: "exempt" })).toBe(true);
  });

  it("refuses 'other' without notes, and accepts it with them", () => {
    expect(manualPaymentFormIsValid({ description: "   ", amount: "40", method: "other" })).toBe(false);
    expect(manualPaymentFormIsValid({ description: "BACS ref 12", amount: "40", method: "other" })).toBe(true);
  });
});

// ── no call site may post a method the route will refuse ─────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("call sites", () => {
  it("never sends a method literal the route would refuse", () => {
    const valid = new Set<string>(MANUAL_PAYMENT_METHOD_VALUES);
    const offenders: string[] = [];

    for (const dir of ["app", "components"]) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, "utf8");
        if (!src.includes("/api/payments/manual")) continue;
        // Strip comments first. The repo's UI-RULES ratchet counts hex
        // literals inside comments and everyone has learned to work around
        // it; a scan that cannot tell code from a comment about code just
        // teaches people not to write the comment.
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        // Any `method: "literal"` in a file that posts to the manual-payment
        // route. A variable (`method: snapshot.method`) does not match and is
        // exactly what the fixed surfaces now send.
        for (const m of code.matchAll(/\bmethod:\s*"([a-z_]+)"/g)) {
          // `method: "POST"` is the fetch verb, not a payment method.
          if (m[1] === "POST") continue;
          if (!valid.has(m[1])) offenders.push(`${file}: method: "${m[1]}"`);
        }
      }
    }

    // This is the assertion that would have caught the original defect on the
    // day it was written.
    expect(offenders).toEqual([]);
  });
});

// ── and the route itself refuses the value that was being sent ───────────────

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { memberFindFirstMock, paymentCreateMock, memberUpdateMock, tenantFindUniqueMock } =
  vi.hoisted(() => ({
    memberFindFirstMock: vi.fn(),
    paymentCreateMock: vi.fn(),
    memberUpdateMock: vi.fn(),
    tenantFindUniqueMock: vi.fn(),
  }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: tenantFindUniqueMock },
    member: { findFirst: memberFindFirstMock, update: memberUpdateMock },
    payment: { create: paymentCreateMock },
  },
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({
    ok: true, session: {} as unknown, tenantId: "tenant-A", userId: "user-1", role: "owner",
  })),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));

type Route = typeof import("@/app/api/payments/manual/route");
let POST: Route["POST"];
beforeAll(async () => { ({ POST } = await import("@/app/api/payments/manual/route")); });

beforeEach(() => {
  vi.clearAllMocks();
  tenantFindUniqueMock.mockResolvedValue({ currency: "GBP" });
  memberFindFirstMock.mockResolvedValue({ id: "member-1", name: "Sean" });
  paymentCreateMock.mockResolvedValue({ id: "payment-1" });
  memberUpdateMock.mockResolvedValue({});
});

function req(body: unknown) {
  return new Request("http://localhost/api/payments/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/payments/manual", () => {
  it('refuses the "manual" method the member profile used to send', async () => {
    const res = await POST(
      req({ memberId: "member-1", amountPence: 4000, method: "manual" }) as never,
    );
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("accepts every method the pickers actually offer", async () => {
    for (const { value } of MANUAL_PAYMENT_METHODS) {
      vi.clearAllMocks();
      tenantFindUniqueMock.mockResolvedValue({ currency: "GBP" });
      memberFindFirstMock.mockResolvedValue({ id: "member-1", name: "Sean" });
      paymentCreateMock.mockResolvedValue({ id: "payment-1" });
      memberUpdateMock.mockResolvedValue({});

      const res = await POST(
        req({
          memberId: "member-1",
          amountPence: isFreeMethod(value) ? 0 : 4000,
          method: value,
          ...(methodNeedsNotes(value) ? { notes: "BACS ref 12" } : {}),
        }) as never,
      );
      expect(res.status, `method "${value}" was refused`).toBe(201);
    }
  });
});
