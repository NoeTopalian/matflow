/**
 * Support (impersonation) sessions are READ-ONLY — the central rule.
 *
 * Operator security audit 5 Oct 2026, Q3: "Almost everything an owner can. No
 * server check reads `impersonatedBy`." Remediation lane B, 6 Oct 2026:
 * lib/support-session.ts holds the policy; proxy.ts enforces it for every
 * request the matcher reaches; the routes outside the matcher guard themselves.
 *
 * This file proves it three ways:
 *   1. the pure policy (methods, the EMPTY allow-list, the exits, refused GETs,
 *      the operator plane);
 *   2. the real proxy handler, driven with a support session, for EVERY
 *      mutating handler under app/api found on disk (so a route added tomorrow
 *      is covered without anyone remembering this file) and for page POSTs
 *      (Server Actions);
 *   3. coverage: every mutating handler the proxy matcher does NOT reach either
 *      carries the in-route guard or is listed below as session-less, with why.
 *
 * Red on revert: delete the support block in proxy.ts and section 2 fails for
 * ~150 handlers; delete a guard line in an /api/auth route and section 3 fails.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  supportRequestDecision,
  isSupportSession,
  SUPPORT_MUTATION_ALLOWLIST,
  SUPPORT_EXIT_ROUTES,
} from "@/lib/support-session";

vi.mock("@/auth", () => ({ auth: (fn: unknown) => fn }));

const ROOT = process.cwd();
const proxySource = readFileSync(resolve(ROOT, "proxy.ts"), "utf8");
function matcherPattern(): string {
  const match = proxySource.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) throw new Error("could not find the matcher pattern in proxy.ts");
  return match[1].replace(/\\\\/g, "\\");
}
const proxyReaches = (path: string) => new RegExp(`^${matcherPattern()}$`).test(path);

const SUPPORT_USER = {
  id: "u-owner", tenantId: "t-club", role: "owner",
  totpPending: false, requireTotpSetup: false, mustChangePassword: false,
  impersonatedBy: "op-noe", impersonationReason: "support ticket 41",
};
const OWNER_USER = { ...SUPPORT_USER, impersonatedBy: undefined, impersonationReason: undefined };

async function runProxy(method: string, pathname: string, user: Record<string, unknown> | null) {
  const mod = await import("../../proxy");
  const proxy = mod.default as unknown as (req: unknown) => Promise<Response>;
  const url = `http://localhost:3847${pathname}`;
  return proxy({
    method,
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    cookies: { get: () => undefined },
    auth: user ? { user } : null,
  });
}
const location = (res: Response) => {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
};

// ── enumerate app/api handlers from disk ─────────────────────────────────────
type Handler = { file: string; method: string; path: string; src: string };
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}
const HANDLERS: Handler[] = walk(join(ROOT, "app/api")).flatMap((full) => {
  const file = relative(ROOT, full).replace(/\\/g, "/");
  const src = readFileSync(full, "utf8");
  const path = "/" + file
    .replace(/^app\//, "")
    .replace(/\/route\.ts$/, "")
    .replace(/\[\.\.\.[^\]]+\]/g, "signin")
    .replace(/\[[^\]]+\]/g, "x1");
  const methods = [...src.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
  // `export const { GET, POST } = handlers` (NextAuth) and `export const POST = ...` count too.
  for (const m of src.matchAll(/export\s+const\s+\{([^}]*)\}\s*=/g)) {
    for (const name of m[1].split(",").map((x) => x.trim())) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(name)) methods.push(name);
  }
  for (const m of src.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=/g)) methods.push(m[1]);
  return [...new Set(methods)].map((method) => ({ file, method, path, src }));
});
const MUTATING = HANDLERS.filter((h) => h.method !== "GET");

/** The handler's own source text, from its `export` to the next top-level export. */
function handlerBody(h: Handler): string {
  const start = h.src.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${h.method}\\b`));
  const rest = h.src.slice(start + 1);
  const next = rest.search(/\nexport\s+(?:async\s+)?function\s+/);
  return next < 0 ? rest : rest.slice(0, next);
}

// Mutating handlers the proxy does not reach AND that do not act on a club
// session at all, so a support session gains nothing there. Each with why.
const SESSIONLESS: Record<string, string> = {
  "app/api/auth/[...nextauth]/route.ts": "NextAuth itself: sign-in replaces the token; sign-out only removes authority",
  "app/api/auth/forgot-password/route.ts": "public; emails a link to the address on file, never to the caller",
  "app/api/auth/reset-password/route.ts": "credential is the emailed one-time token, not the session",
  "app/api/auth/totp/recover/route.ts": "public; credential is a recovery code",
  "app/api/auth/totp/verify/route.ts": "acts only on a token with totpPending, which a support session never carries",
  "app/api/stripe/webhook/route.ts": "Stripe-signed webhook",
  "app/api/webhooks/resend/route.ts": "Resend-signed webhook",
  "app/api/kiosk/[token]/checkin/route.ts": "kiosk device token",
  "app/api/magic-link/request/route.ts": "public; emails the address on file",
};

describe("1. the policy", () => {
  it("the mutation allow-list is EMPTY (an entry needs a written proof it only reads)", () => {
    expect(SUPPORT_MUTATION_ALLOWLIST).toEqual([]);
  });

  it("every exit only removes authority, and says why", () => {
    expect(SUPPORT_EXIT_ROUTES.map((r) => `${r.method} ${r.path.source}`)).toEqual([
      "DELETE ^\\/api\\/admin\\/impersonate\\/?$",
      "POST ^\\/api\\/admin\\/auth\\/logout\\/?$",
    ]);
    for (const r of SUPPORT_EXIT_ROUTES) expect(r.why.length).toBeGreaterThan(20);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "post", undefined])("refuses %s on a club route (undefined = GET)", (m) => {
    const d = supportRequestDecision(m as string | undefined, "/api/members/m1");
    if (m === undefined) expect(d.allowed).toBe(true);
    else expect(d).toMatchObject({ allowed: false, reason: "read_only" });
  });

  it.each([
    "/api/admin/dsar/export",
    "/api/payments/export.csv",
    "/api/admin/import/attendance/export",
    "/api/admin/import/job-1/exceptions",
    "/api/stripe/connect",
    "/api/stripe/connect/callback",
    "/api/drive/connect",
    "/api/drive/callback",
    "/api/auth/totp/setup",
    "/api/payments/export%2Ecsv",
    "//api//admin//dsar//export",
  ])("refuses the GET %s (an export or a GET with side effects)", (p) => {
    expect(supportRequestDecision("GET", p)).toMatchObject({ allowed: false, reason: "export" });
  });

  it.each(["/admin", "/admin/tenants", "/api/admin/activity", "/api/admin/customers/t1/force-password-reset", "/api/admin/impersonate"])(
    "refuses the operator plane %s to a support session (no nesting), whatever the method",
    (p) => {
      expect(supportRequestDecision("GET", p)).toMatchObject({ allowed: false, reason: "operator_plane" });
      expect(supportRequestDecision("POST", p)).toMatchObject({ allowed: false, reason: "operator_plane" });
    },
  );

  it.each(["/api/dashboard/stats", "/api/members", "/api/admin/import", "/api/admin/import/job-1", "/dashboard", "/api/reports"])(
    "allows the read %s",
    (p) => expect(supportRequestDecision("GET", p)).toEqual({ allowed: true }),
  );

  it("allows the two exits", () => {
    expect(supportRequestDecision("DELETE", "/api/admin/impersonate")).toEqual({ allowed: true });
    expect(supportRequestDecision("POST", "/api/admin/auth/logout")).toEqual({ allowed: true });
  });

  it("isSupportSession reads impersonatedBy and nothing else", () => {
    expect(isSupportSession({ user: SUPPORT_USER })).toBe(true);
    expect(isSupportSession({ user: OWNER_USER })).toBe(false);
    expect(isSupportSession({ user: { impersonatedBy: "" } })).toBe(false);
    expect(isSupportSession(null)).toBe(false);
  });
});

describe("2. proxy.ts refuses every mutating /api handler on disk to a support session", () => {
  const reached = MUTATING.filter((h) => proxyReaches(h.path));

  it("the enumeration found the routes (sanity)", () => {
    expect(MUTATING.length).toBeGreaterThan(120);
    expect(reached.length).toBeGreaterThan(100);
  });

  it.each(reached.map((h) => [`${h.method} ${h.path}`, h] as const))("%s", async (_label, h) => {
    const exit = SUPPORT_EXIT_ROUTES.some((r) => r.method === h.method && r.path.test(h.path));
    const res = await runProxy(h.method, h.path, SUPPORT_USER);
    if (exit) {
      expect(res.status, "an exit must stay open").toBe(200);
      return;
    }
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.supportReadOnly).toBe(true);
  });

  it.each(["/dashboard", "/dashboard/settings", "/dashboard/members/m1"])(
    "a page POST (Server Action shape) to %s is refused",
    async (p) => {
      expect((await runProxy("POST", p, SUPPORT_USER)).status).toBe(403);
    },
  );

  it.each(["/api/admin/dsar/export", "/api/payments/export.csv", "/api/admin/import/attendance/export", "/api/stripe/connect"])(
    "the export / connect GET %s is refused",
    async (p) => {
      expect((await runProxy("GET", p, SUPPORT_USER)).status).toBe(403);
    },
  );

  it("an operator page from inside a support session goes back to the club view", async () => {
    const res = await runProxy("GET", "/admin/tenants", SUPPORT_USER);
    expect(res.status).toBe(307);
    expect(location(res)).toBe("/dashboard");
  });

  it("starting another support session from inside one is refused (no nesting)", async () => {
    expect((await runProxy("POST", "/api/admin/impersonate", SUPPORT_USER)).status).toBe(403);
  });

  it.each(["/dashboard", "/dashboard/members", "/api/dashboard/stats", "/api/members", "/api/admin/import"])(
    "positive control: support may READ %s",
    async (p) => {
      const res = await runProxy("GET", p, SUPPORT_USER);
      expect(res.status).toBe(200);
      expect(location(res)).toBeNull();
    },
  );

  it("positive control: the owner's own session is untouched by the rule", async () => {
    expect((await runProxy("POST", "/api/staff", OWNER_USER)).status).toBe(200);
    expect((await runProxy("GET", "/api/payments/export.csv", OWNER_USER)).status).toBe(200);
  });
});

describe("3. mutating handlers outside the proxy matcher guard themselves", () => {
  const unreached = MUTATING.filter((h) => !proxyReaches(h.path));

  it.each(unreached.map((h) => [`${h.method} ${h.file}`, h] as const))("%s", (_label, h) => {
    if (SESSIONLESS[h.file]) return;
    expect(
      handlerBody(h),
      `${h.method} ${h.file} acts on a session outside proxy.ts: add refuseSupportSession(...) or list it in SESSIONLESS with why`,
    ).toMatch(/refuseSupportSession\(/);
  });

  it("the TOTP setup GET (it WRITES a new secret) is guarded too", () => {
    const h = HANDLERS.find((x) => x.file === "app/api/auth/totp/setup/route.ts" && x.method === "GET")!;
    expect(handlerBody(h)).toMatch(/refuseSupportSession\(/);
  });

  it("every SESSIONLESS entry still exists (no stale exemptions)", () => {
    const files = new Set(HANDLERS.map((h) => h.file));
    for (const f of Object.keys(SESSIONLESS)) expect(files.has(f), f).toBe(true);
  });
});
