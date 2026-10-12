// SF-35 (lockout existence oracle) + SF-59 (targeted lockout DoS) against a
// REAL database — security campaign iteration 2, lane A2, 9 Oct 2026. Neon TEST
// branch only, both roles through the guarded runners.
//
// The real authorize() of auth.ts is captured (next-auth's plumbing replaced,
// as in tests/unit/account-lockout-counter.test.ts) and driven with real rows,
// real bcrypt hashes, real LoginEvent rows and the real RateLimitHit counters.
// The per-IP ATTEMPT throttle (checkRateLimit) is replaced by "always allowed":
// that models an attacker who paces requests under it (or spreads them over
// many addresses), which is the attacker both findings are about. The failure
// lockout under test does not go through checkRateLimit.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;
const captured = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a2-lockout-db-secret-0123456789abcdef0123456789";
  return { authorize: undefined as undefined | Authorize };
});

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    return { handlers: {}, auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { deviceHash } from "@/lib/login-fingerprint";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const PASSWORD = "secA2-correct-horse-battery";
// Synthetic documentation-range networks (RFC 5737), one /24 per role so the
// two runs never share a counter; a random octet keeps reruns apart too.
const NET = Math.floor(Math.random() * 200) + 20;
const ip = (host: number, net = NET) => `198.51.${net}.${host}`;
const VICTIM_IP = "203.0.113.77";
const VICTIM_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ATTACKER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

type Outcome = "admitted" | "refused" | `code:${string}`;

describe.skipIf(!HAS_DB)("lockout v2 on Postgres: no existence oracle, no targeted lockout", () => {
  const ids = { tenant: "", slug: "", member: "" };

  async function attempt(email: string, password: string, fromIp: string, ua = ATTACKER_UA): Promise<Outcome> {
    if (!captured.authorize) await import("@/auth");
    try {
      const r = await captured.authorize!(
        { email, password, tenantSlug: ids.slug },
        new Request("http://localhost/api/auth/callback/credentials", {
          method: "POST",
          headers: { "x-vercel-forwarded-for": fromIp, "user-agent": ua },
        }),
      );
      return r ? "admitted" : "refused";
    } catch (e) {
      return `code:${(e as { code?: string }).code ?? "error"}`;
    }
  }

  beforeAll(async () => {
    const hash = bcrypt.hashSync(PASSWORD, 4);
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      for (const who of ["victim", "oracle", "spread"]) {
        const m = await tx.member.create({ data: { tenantId: t.id, email: E(who), name: `secA2 ${who}`, passwordHash: hash } });
        if (who === "victim") ids.member = m.id;
        // A device this member has signed in from before (not disowned, recent).
        await tx.loginEvent.create({
          data: { tenantId: t.id, memberId: m.id, deviceHash: deviceHash(VICTIM_IP, VICTIM_UA), ipApprox: "203.0.113.0", uaSummary: "Safari 17 on macOS" },
        });
      }
    });
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await new Promise((r) => setTimeout(r, 500));
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.loginEvent.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.member.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.tenant.delete({ where: { id: ids.tenant } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: ids.tenant } }),
      members: await tx.member.count({ where: { tenantId: ids.tenant } }),
      events: await tx.loginEvent.count({ where: { tenantId: ids.tenant } }),
    }));
    expect(left).toEqual({ tenants: 0, members: 0, events: 0 });
    // Counter rows are keyed by an HMAC of these synthetic addresses and expire
    // with the hour window; RateLimitHit has no tenant column to sweep by.
  }, 120_000);

  it("positive control: the right password from a fresh network is admitted", async () => {
    expect(await attempt(E("victim"), PASSWORD, ip(1))).toBe("admitted");
  }, 60_000);

  it("SF-35: twelve wrong passwords give the SAME answers for an address with and without an account", async () => {
    const real: Outcome[] = [];
    const none: Outcome[] = [];
    for (let i = 0; i < 12; i++) {
      real.push(await attempt(E("oracle"), "wrong-password-a2", ip(2)));
      none.push(await attempt(E("nobody-has-this"), "wrong-password-a2", ip(2)));
    }
    expect(real, `account: ${real.join(",")} / none: ${none.join(",")}`).toEqual(none);
    expect(real.slice(0, 10).every((o) => o === "refused")).toBe(true);
    expect(real.slice(10).every((o) => o === "code:rate_limited")).toBe(true);
    expect(real.join(","), "no account-specific code anywhere").not.toContain("account_locked");
  }, 120_000);

  it("SF-59: an attacker who knows the address cannot keep the person out of their known device", async () => {
    for (let i = 0; i < 12; i++) await attempt(E("victim"), "wrong-password-a2", ip(3));
    // The attacker's own network is shut, even with the right password.
    expect(await attempt(E("victim"), PASSWORD, ip(3))).toBe("code:rate_limited");
    // The person, from the phone they always use: in.
    expect(await attempt(E("victim"), PASSWORD, VICTIM_IP, VICTIM_UA)).toBe("admitted");
    // Their row was never locked by the attack.
    const row = await withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: ids.member }, select: { lockedUntil: true } }));
    expect(row.lockedUntil).toBeNull();
  }, 120_000);

  it("distributed guessing (one failure per network) caps the address for unknown devices only", async () => {
    for (let n = 0; n < 10; n++) await attempt(E("spread"), "wrong-password-a2", ip(9, ((NET + n + 1) % 250) + 1));
    // An eleventh network, right password, unknown device: refused, generic.
    expect(await attempt(E("spread"), PASSWORD, "192.0.2.200")).toBe("code:rate_limited");
    // Known device: in.
    expect(await attempt(E("spread"), PASSWORD, VICTIM_IP, VICTIM_UA)).toBe("admitted");
  }, 120_000);

  it("a header cannot pick a fresh counter: a spoofed leading x-forwarded-for is ignored", async () => {
    // Twelve failures, each claiming a different client in x-forwarded-for;
    // the platform-set header names the same network every time.
    let last: Outcome = "refused";
    for (let i = 0; i < 12; i++) {
      if (!captured.authorize) await import("@/auth");
      try {
        const r = await captured.authorize!(
          { email: E("nobody-two"), password: "wrong-password-a2", tenantSlug: ids.slug },
          new Request("http://localhost/api/auth/callback/credentials", {
            method: "POST",
            headers: { "x-forwarded-for": `10.${i}.0.1, ${ip(4)}`, "x-vercel-forwarded-for": ip(4), "user-agent": ATTACKER_UA },
          }),
        );
        last = r ? "admitted" : "refused";
      } catch (e) {
        last = `code:${(e as { code?: string }).code}`;
      }
    }
    expect(last).toBe("code:rate_limited");
  }, 120_000);
});
