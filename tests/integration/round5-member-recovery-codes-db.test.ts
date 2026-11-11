// Round 5 (11 Nov 2026): a member's recovery codes.
//  - Replacing them needs a current authenticator code (step-up), as the staff
//    route already does: a stolen session alone cannot swap in codes the thief
//    holds. Attempts are limited per member (real rate-limit store).
//  - A new enrolment starts with no recovery codes, so codes kept from an
//    earlier enrolment (the self-service recovery keeps the unused ones) do
//    not work against the new one.
// Real handlers, Neon TEST branch, both database roles. Synthetic club (r5r-),
// torn down here.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("next/server", () => {
  class NR extends Response {
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    }
  }
  return { NextRequest: class extends Request {}, NextResponse: NR };
});
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null), encode: vi.fn(async () => "x") }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));

import { generateSecret, generateSync } from "otplib";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as regenerate } from "@/app/api/member/totp/recovery-codes/route";
import { POST as enrol } from "@/app/api/member/totp/setup/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r5r${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!HAS_DB)("member recovery codes: step-up, attempt limit, fresh set on enrolment", () => {
  let tenantId = "";
  const secret = generateSecret();
  const member = async (suffix: string, data: Record<string, unknown>) =>
    (await withRlsBypass((tx) => tx.member.create({ data: { tenantId, name: `${STAMP} ${suffix}`, email: `${STAMP}-${suffix}@example.test`, passwordHash: "x", ...data } as never }))).id;
  const as = (memberId: string) => { authState.session = { user: { id: `${STAMP}-u-${memberId}`, tenantId, role: "member", memberId, email: `${STAMP}@example.test` } }; };
  const post = (fn: (req: never) => Promise<Response>, body?: unknown) =>
    fn(new Request("https://test.local/", { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }) as never);
  const codesOf = async (id: string) => (await withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id }, select: { totpRecoveryCodes: true } }))).totpRecoveryCodes;
  /** A six-digit code that is NOT the current one (the current, previous and next steps are all accepted). */
  const wrongCode = () => {
    const now = Date.now();
    const near = new Set([-30_000, 0, 30_000].map((d) => generateSync({ secret, epoch: Math.floor((now + d) / 1000) })));
    for (let i = 0; ; i++) { const c = String(i).padStart(6, "0"); if (!near.has(c)) return c; }
  };

  beforeAll(async () => {
    tenantId = (await withRlsBypass((tx) => tx.tenant.create({ data: { name: STAMP, slug: STAMP } }))).id;
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("without a code, or with a wrong one, the codes are not replaced", async () => {
    const id = await member("a", { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: ["old-hash"] });
    as(id);
    expect((await post(regenerate)).status).toBe(400);
    expect((await post(regenerate, { totpCode: wrongCode() })).status).toBe(401);
    expect(await codesOf(id)).toEqual(["old-hash"]);
  });

  it("with the current code, eight new codes replace the old set", async () => {
    const id = await member("b", { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: ["old-hash"] });
    as(id);
    const res = await post(regenerate, { totpCode: generateSync({ secret }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { codes: string[] }).codes).toHaveLength(8);
    const stored = (await codesOf(id)) as string[];
    expect(stored).toHaveLength(8);
    expect(stored).not.toContain("old-hash");
  });

  it("the previous 30-second step's code is accepted (the enrolment passes on the code it just verified, across a step rollover)", async () => {
    const id = await member("g", { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: ["old-hash"] });
    as(id);
    const previous = generateSync({ secret, epoch: Math.floor(Date.now() / 1000) - 30 });
    expect((await post(regenerate, { totpCode: previous })).status).toBe(200);
  });

  it("after five attempts in the window the next is refused, even with the right code", async () => {
    const id = await member("c", { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: ["old-hash"] });
    as(id);
    for (let i = 0; i < 5; i++) expect((await post(regenerate, { totpCode: wrongCode() })).status).toBe(401);
    const limited = await post(regenerate, { totpCode: generateSync({ secret }) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(await codesOf(id)).toEqual(["old-hash"]);
  });

  it("a new enrolment clears recovery codes kept from an earlier one", async () => {
    // As the self-service recovery leaves a member: second factor off, the unused codes kept.
    const id = await member("d", { totpEnabled: false, totpSecret: secret, totpRecoveryCodes: ["kept-1", "kept-2"] });
    as(id);
    expect((await post(enrol, { code: generateSync({ secret }), issueRecoveryCodes: true })).status).toBe(200);
    const row = await withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id }, select: { totpEnabled: true, totpRecoveryCodes: true } }));
    expect(row).toEqual({ totpEnabled: true, totpRecoveryCodes: null });
  });

  it("another member's session cannot reach this member's codes (the session's own member only)", async () => {
    const victim = await member("e", { totpEnabled: true, totpSecret: secret, totpRecoveryCodes: ["victim-hash"] });
    const other = await member("f", { totpEnabled: false });
    as(other);
    expect((await post(regenerate, { totpCode: generateSync({ secret }) })).status).toBe(400); // "enable 2FA first": the caller's own row
    expect(await codesOf(victim)).toEqual(["victim-hash"]);
  });
});
