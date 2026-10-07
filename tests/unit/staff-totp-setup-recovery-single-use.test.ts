/**
 * Staff TOTP enrolment and recovery-code regeneration spend each authenticator
 * code once (review of lanes P + M, defect 10, 7 Oct 2026). Before this, both
 * routes used a plain verifySync: the code that confirmed an enrolment or a
 * regeneration stayed usable for the rest of its 30-second window — on this or
 * another route (sign-in verify, login-email change) — because nothing recorded
 * the time-step. Both now go through lib/login-email.ts consumeUserTotp.
 *
 * The wizard used to replay the enrolment code into /recovery-codes; the
 * enrolment POST now issues the codes itself when asked (`issueRecoveryCodes`),
 * in the same write that turns the authenticator on.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { generateSecret, generateSync } from "otplib";

const SECRET = generateSecret();
const h = vi.hoisted(() => ({
  row: {
    id: "u1", tenantId: "t1", totpSecret: "", totpEnabled: false, mustChangePassword: false,
    totpLastUsedStep: null as number | null, totpRecoveryCodes: null as unknown,
  },
  logAudit: vi.fn(async () => {}),
}));

const tx = {
  user: {
    findUnique: vi.fn(async () => ({ ...h.row })),
    findFirst: vi.fn(async () => ({ ...h.row })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(h.row, data);
      return { ...h.row };
    }),
    // Mirrors the conditional UPDATE in consumeUserTotp.
    updateMany: vi.fn(async ({ data }: { data: { totpLastUsedStep: number } }) => {
      const last = h.row.totpLastUsedStep;
      if (last === null || last < data.totpLastUsedStep) {
        h.row.totpLastUsedStep = data.totpLastUsedStep;
        return { count: 1 };
      }
      return { count: 0 };
    }),
  },
};

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", tenantId: "t1", role: "owner", mustChangePassword: false } })),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: () => null }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn(async () => null), encode: vi.fn(async () => "encoded") }));

import { POST as setup } from "@/app/api/auth/totp/setup/route";
import { POST as regenerate } from "@/app/api/auth/totp/recovery-codes/route";

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
const enrol = (body: unknown) => setup(post("http://localhost/api/auth/totp/setup", body) as never);
const regen = (totpCode: string) => regenerate(post("http://localhost/api/auth/totp/recovery-codes", { totpCode }));
const wrong = () => ("000000" === generateSync({ secret: SECRET }) ? "111111" : "000000");

beforeEach(() => {
  vi.clearAllMocks();
  h.row = {
    id: "u1", tenantId: "t1", totpSecret: SECRET, totpEnabled: false, mustChangePassword: false,
    totpLastUsedStep: null, totpRecoveryCodes: null,
  };
});

describe("POST /api/auth/totp/setup — the enrolment code is spent", () => {
  it("enrols with a fresh code and records its time-step", async () => {
    const res = await enrol({ code: generateSync({ secret: SECRET }) });
    expect(res.status).toBe(200);
    expect(h.row.totpEnabled).toBe(true);
    expect(h.row.totpLastUsedStep).not.toBeNull();
  });

  it("the same code cannot confirm a second enrolment", async () => {
    const code = generateSync({ secret: SECRET });
    expect((await enrol({ code })).status).toBe(200);
    h.row.totpEnabled = false;
    tx.user.update.mockClear();
    expect((await enrol({ code })).status).toBe(400);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("a wrong code spends nothing and enables nothing", async () => {
    expect((await enrol({ code: wrong() })).status).toBe(400);
    expect(h.row.totpLastUsedStep).toBeNull();
    expect(h.row.totpEnabled).toBe(false);
  });

  it("issueRecoveryCodes: the codes come back once, their hashes are stored in the enabling write", async () => {
    const res = await enrol({ code: generateSync({ secret: SECRET }), issueRecoveryCodes: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recoveryCodes?: string[] };
    expect(body.recoveryCodes).toHaveLength(8);
    const write = tx.user.update.mock.calls[0][0] as { data: { totpEnabled: boolean; totpRecoveryCodes: unknown } };
    expect(write.data.totpEnabled).toBe(true);
    expect(Array.isArray(write.data.totpRecoveryCodes)).toBe(true);
    expect((write.data.totpRecoveryCodes as string[]).length).toBe(8);
    // Hashes, never the display codes.
    for (const display of body.recoveryCodes!) {
      expect(write.data.totpRecoveryCodes as string[]).not.toContain(display);
    }
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.totp.recovery_codes.generated" }));
  });

  it("without the flag, enrolment still discards old recovery codes and returns none", async () => {
    const res = await enrol({ code: generateSync({ secret: SECRET }) });
    const body = (await res.json()) as { recoveryCodes?: string[] };
    expect(body.recoveryCodes).toBeUndefined();
    const write = tx.user.update.mock.calls[0][0] as { data: { totpRecoveryCodes: unknown } };
    expect(Array.isArray(write.data.totpRecoveryCodes)).toBe(false);
  });
});

describe("POST /api/auth/totp/recovery-codes — the step-up code is spent", () => {
  beforeEach(() => {
    h.row.totpEnabled = true;
  });

  it("regenerates with a fresh code once; the same code again is refused", async () => {
    const code = generateSync({ secret: SECRET });
    expect((await regen(code)).status).toBe(200);
    tx.user.update.mockClear();
    expect((await regen(code)).status).toBe(401);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("a code already spent elsewhere (e.g. by the enrolment) is refused", async () => {
    const code = generateSync({ secret: SECRET });
    h.row.totpEnabled = false;
    expect((await enrol({ code })).status).toBe(200);
    tx.user.update.mockClear();
    expect((await regen(code)).status).toBe(401);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("refused when the conditional spend matches no row (a racing request won)", async () => {
    tx.user.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await regen(generateSync({ secret: SECRET }))).status).toBe(401);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
