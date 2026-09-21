import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Lane L-C round 3 — approved policies 2 and 4 (Noe, 19 Sep 2026).
 *
 * 2. An adult with no email address may now be a member. A real club has
 *    walk-ins, older members and families sharing one inbox; refusing them a row
 *    sent them to paper and took the attendance, the payments and the waiver
 *    with them. `Member.email` stays NOT NULL — the row carries a synthesised
 *    placeholder, the same mechanism kids already use — and every send path
 *    excludes it, so the club is never told it invited somebody it did not.
 *
 * 4. `POST /api/members/bulk-invite` narrows from `requireApiStaff` to
 *    owner+manager. It was the one route where a coach — the lowest-trust staff
 *    role, and the one a club hands out most freely — could mass-mail the whole
 *    roster.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

import {
  isSynthesisedEmail,
  synthesiseMemberEmail,
  synthesiseKidEmail,
  NOT_SYNTHESISED_EMAIL,
  NO_LOGIN_EMAIL_DOMAIN,
} from "@/lib/synthesise-kid-email";

describe("the placeholder address is recognisable", () => {
  it("recognises both flavours it mints", () => {
    expect(isSynthesisedEmail(synthesiseMemberEmail("adult"))).toBe(true);
    expect(isSynthesisedEmail(synthesiseKidEmail())).toBe(true);
  });

  it("never mistakes a real address for one", () => {
    for (const real of ["jordan@example.com", "a@no-login.matflow.local.evil.com", "", null, undefined]) {
      expect(isSynthesisedEmail(real)).toBe(false);
    }
  });

  it("matches on the domain, case-insensitively, not on the kid/adult label", () => {
    expect(isSynthesisedEmail(`WHATEVER-123@${NO_LOGIN_EMAIL_DOMAIN.toUpperCase()}`)).toBe(true);
  });

  it("never collides", () => {
    const seen = new Set(Array.from({ length: 200 }, () => synthesiseMemberEmail("adult")));
    expect(seen.size).toBe(200);
  });

  it("the SQL-side exclusion and the predicate name the same domain", () => {
    expect(NOT_SYNTHESISED_EMAIL.email.not.endsWith).toBe(`@${NO_LOGIN_EMAIL_DOMAIN}`);
  });

  it("carries no node builtin, so a client component can import the recogniser", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../lib/synthesise-kid-email.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/from "(node:)?crypto"/);
  });
});

// ── POST /api/members — an adult with no address ─────────────────────────────

const { createMock, tokenCreateMock, sendEmailMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  tokenCreateMock: vi.fn(),
  sendEmailMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { create: createMock, findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
      magicLinkToken: { create: tokenCreateMock, updateMany: vi.fn() },
      tenant: { findUnique: vi.fn(async () => ({ name: "Total BJJ" })) },
      // Attribution (M1): create route records the funnel start event in-tx.
      memberStatusEvent: { create: vi.fn(async () => ({ id: "evt" })) },
    }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/membership-tier", () => ({
  resolveMembershipTier: vi.fn(async () => null),
  membershipTierWrite: () => ({}),
}));

import { POST as createMember } from "@/app/api/members/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

function asRole(role: string) {
  mockAuth.mockResolvedValue({
    user: { id: "u1", role, tenantId: "t-A" },
  } as unknown as Awaited<ReturnType<typeof auth>>);
}

function postReq(body: Record<string, unknown>): Request {
  return {
    url: "http://localhost:3847/api/members",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailMock.mockResolvedValue({ ok: true });
  createMock.mockImplementation(async ({ data }: { data: { email: string; name: string } }) => ({
    id: "m-new",
    tenantId: "t-A",
    name: data.name,
    email: data.email,
    accountType: "adult",
  }));
});

describe("POST /api/members — an adult with no email", () => {
  it("is created, with a placeholder address the roster can recognise", async () => {
    asRole("owner");
    const res = await createMember(postReq({ name: "Walk-in Wendy" }));
    expect(res.status).toBe(201);
    const written = createMock.mock.calls[0][0].data.email as string;
    expect(isSynthesisedEmail(written)).toBe(true);
    expect((await res.json() as { noEmail: boolean }).noEmail).toBe(true);
  });

  it("is never sent an invite — no token, no mail, no inviteUrl", async () => {
    asRole("owner");
    const res = await createMember(postReq({ name: "Walk-in Wendy" }));
    expect(tokenCreateMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect((await res.json() as { inviteUrl: string | null }).inviteUrl).toBeNull();
  });

  it("an adult WITH an email is unchanged: real address, token minted, invite sent", async () => {
    asRole("owner");
    const res = await createMember(postReq({ name: "Jordan", email: "Jordan@Example.com" }));
    const written = createMock.mock.calls[0][0].data.email as string;
    expect(isSynthesisedEmail(written)).toBe(false);
    expect(written).toBe("jordan@example.com");
    expect(tokenCreateMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((await res.json() as { noEmail: boolean }).noEmail).toBe(false);
  });
});

// ── POST /api/members/bulk-invite ────────────────────────────────────────────

describe("bulk-invite", () => {
  it("is owner + manager, and a coach is refused", async () => {
    const mod = await import("@/app/api/members/bulk-invite/route");
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../app/api/members/bulk-invite/route.ts", import.meta.url), "utf8"),
    );
    expect(typeof mod.POST).toBe("function");
    // The gate itself, read from the source: `requireApiStaff` admits coach and
    // admin, `requireApiOwnerOrManager` does not. The live proof is the e2e
    // cell (lc-2), which drives all four roles with real sessions.
    expect(src).toContain("requireApiOwnerOrManager()");
    expect(src).not.toContain("requireApiStaff()");
  });

  it("excludes synthesised addresses from the candidate set, in the query and again in the loop", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../app/api/members/bulk-invite/route.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("NOT_SYNTHESISED_EMAIL");
    expect(src).toContain("isSynthesisedEmail(email)");
  });
});
