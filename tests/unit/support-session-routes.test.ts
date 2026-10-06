/**
 * Support sessions are refused INSIDE the credential, access, money, export and
 * destructive routes — direct route-handler calls, no proxy in front.
 *
 * Remediation lane B, 6 Oct 2026. proxy.ts is the central enforcement point
 * (tests/unit/support-session-readonly.test.ts); these routes carry the same
 * refusal as a one-line in-route guard (lib/api-authz.ts refuseSupportSession)
 * so that a matcher edit can never re-open them. Each case calls the real
 * handler with an impersonated session and asserts: 403, the read-only message,
 * and NO side effect — no database call at all, no Stripe client, no email, no
 * blob write.
 *
 * Positive controls: the same session may READ (staff list), and the owner's
 * own session passes the guard on the same routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown>; expires: string },
  effects: [] as string[],
  allowDb: false,
}));

vi.mock("@/auth", () => ({ auth: vi.fn(async () => st.session), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

function dbProxy(label: string): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      return dbProxy(`${label}.${String(prop)}`);
    },
    apply() {
      st.effects.push(`db:${label}`);
      if (st.allowDb) return Promise.resolve([]);
      throw new Error(`DB touched: ${label}`);
    },
  });
}
vi.mock("@/lib/prisma", () => ({ prisma: dbProxy("prisma") }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => {
    st.effects.push("db:withTenantContext");
    if (st.allowDb) return fn(dbProxy("tx"));
    throw new Error("DB touched: withTenantContext");
  },
  withRlsBypass: async (fn: (tx: unknown) => unknown) => {
    st.effects.push("db:withRlsBypass");
    if (st.allowDb) return fn(dbProxy("tx"));
    throw new Error("DB touched: withRlsBypass");
  },
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => { st.effects.push("email"); return { ok: true }; }) }));
vi.mock("stripe", () => ({
  default: class {
    constructor() { st.effects.push("stripe:new"); }
  },
}));
vi.mock("@/lib/stripe/subscriptions", () => ({
  createSubscriptionForMember: vi.fn(async () => { st.effects.push("stripe:create"); }),
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => { st.effects.push("stripe:cancel"); }),
}));
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async () => { st.effects.push("blob:put"); return { url: "x" }; }),
  del: vi.fn(async () => { st.effects.push("blob:del"); }),
  head: vi.fn(async () => { st.effects.push("blob:head"); }),
  list: vi.fn(async () => { st.effects.push("blob:list"); return { blobs: [] }; }),
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async () => { st.effects.push("audit"); }),
  logAuditStrict: vi.fn(async () => { st.effects.push("audit"); }),
  auditLogRetentionWhere: () => ({}),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const SUPPORT = {
  user: {
    id: "u-owner", tenantId: "t-club", tenantSlug: "club", tenantName: "Club", role: "owner",
    totpPending: false, requireTotpSetup: false, totpEnabled: true, mustChangePassword: false,
    impersonatedBy: "op-noe", impersonationReason: "support ticket 41",
  },
  expires: "2099-01-01",
};
const OWNER = { ...SUPPORT, user: { ...SUPPORT.user, impersonatedBy: undefined, impersonationReason: undefined } };

const ORIGIN = "http://localhost:3000";
function req(method: string, path: string) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, host: "localhost:3000" },
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify({}),
  });
}
const ctx = { params: Promise.resolve({ id: "x1" }) };

type H = (r: Request, c?: unknown) => Promise<Response>;
async function handler(file: string, method: string): Promise<H> {
  const mod = (await import(/* @vite-ignore */ `../../${file}`)) as Record<string, H>;
  const h = mod[method];
  if (typeof h !== "function") throw new Error(`${file} has no ${method}`);
  return h;
}

// [class, file, method] — the refused classes named in the brief.
const CASES: [string, string, string][] = [
  ["credential: set own password", "app/api/auth/set-password/route.ts", "POST"],
  ["credential: TOTP setup GET (writes a secret)", "app/api/auth/totp/setup/route.ts", "GET"],
  ["credential: TOTP enable", "app/api/auth/totp/setup/route.ts", "POST"],
  ["credential: recovery codes", "app/api/auth/totp/recovery-codes/route.ts", "POST"],
  ["credential: disable 2FA", "app/api/auth/totp/disable/route.ts", "POST"],
  ["session: sign the owner out everywhere", "app/api/auth/logout-all/route.ts", "POST"],
  ["access: unlock a staff account", "app/api/auth/staff-unlock/[id]/route.ts", "POST"],
  ["access: create staff with a chosen password", "app/api/staff/route.ts", "POST"],
  ["access: change staff / reset staff password", "app/api/staff/[id]/route.ts", "PATCH"],
  ["access: remove staff", "app/api/staff/[id]/route.ts", "DELETE"],
  ["access: transfer ownership (owner side)", "app/api/staff/[id]/transfer-ownership/route.ts", "POST"],
  ["credential: reset a staff member's 2FA", "app/api/staff/[id]/totp-reset/route.ts", "POST"],
  ["credential: reset a member's 2FA", "app/api/members/[id]/totp-reset/route.ts", "POST"],
  ["access: member invite link", "app/api/members/[id]/invite-link/route.ts", "POST"],
  ["access: bulk invite", "app/api/members/bulk-invite/route.ts", "POST"],
  ["destructive: member edit", "app/api/members/[id]/route.ts", "PATCH"],
  ["destructive: member delete", "app/api/members/[id]/route.ts", "DELETE"],
  ["destructive: DSAR erase", "app/api/admin/dsar/erase/route.ts", "POST"],
  ["export: DSAR export", "app/api/admin/dsar/export/route.ts", "GET"],
  ["destructive: import commit", "app/api/admin/import/[id]/commit/route.ts", "POST"],
  ["destructive: import rollback", "app/api/admin/import/[id]/rollback/route.ts", "POST"],
  ["export: attendance ledger", "app/api/admin/import/attendance/export/route.ts", "GET"],
  ["export: payments CSV", "app/api/payments/export.csv/route.ts", "GET"],
  ["money: refund", "app/api/payments/[id]/refund/route.ts", "POST"],
  ["money: charge a member", "app/api/members/[id]/charge/route.ts", "POST"],
  ["money: Stripe connect start", "app/api/stripe/connect/route.ts", "GET"],
  ["money: Stripe connect callback", "app/api/stripe/connect/callback/route.ts", "GET"],
  ["money: Stripe disconnect", "app/api/stripe/disconnect/route.ts", "POST"],
  ["consent: supervised waiver signature", "app/api/members/[id]/waiver/sign/route.ts", "POST"],
  ["consent: waiver signature", "app/api/waiver/sign/route.ts", "POST"],
  ["settings: club settings", "app/api/settings/route.ts", "PATCH"],
];

beforeEach(() => {
  st.effects = [];
  st.allowDb = false;
});

describe("a support session is refused, with no side effect", () => {
  it.each(CASES)("%s — %s %s", async (_cls, file, method) => {
    st.session = SUPPORT;
    const h = await handler(file, method);
    const res = await h(req(method, "/api/x"), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(String(body.error)).toMatch(/read-only/i);
    expect(st.effects, "no database, Stripe, email, blob or audit call").toEqual([]);
  });
});

describe("positive controls", () => {
  it("the owner's OWN session gets past the support guard on the same routes (something else answers)", async () => {
    for (const [, file, method] of CASES) {
      st.session = OWNER;
      st.effects = [];
      const h = await handler(file, method);
      let status = 0;
      let body: { error?: string } = {};
      try {
        const res = await h(req(method, "/api/x"), ctx);
        status = res.status;
        body = await res.clone().json().catch(() => ({}));
      } catch {
        status = 500; // a stub threw past the guard: the guard let it through
      }
      expect(String(body.error ?? ""), `${method} ${file} (status ${status})`).not.toMatch(/read-only/i);
    }
  });

  it("a support session may READ: the staff list answers 200", async () => {
    st.session = SUPPORT;
    st.allowDb = true;
    const h = await handler("app/api/staff/route.ts", "GET");
    const res = await h(req("GET", "/api/staff"));
    expect(res.status).toBe(200);
  });
});
