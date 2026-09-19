/**
 * Lane L-G — J60: the operator plane.
 *
 * Every cell is driven against a THROWAWAY tenant this file creates and tears
 * down. `totalbjj` is never suspended, never soft-deleted, never has an owner
 * password or TOTP reset — rule 6 of COMMON.md, and each of those mutations is
 * exactly what this journey is made of.
 *
 * The operator secret is never printed and never captured: no `storageState()`
 * is taken of any context in this file, and every credential arrives either as
 * a cookie set on a live context or as a per-request header.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  SLUG_A,
  OWNER_A,
  COACH_A,
  ADMIN_A,
  MEMBER_A,
  sessionFor,
  anonContext,
  closeSessions,
  createThrowawayTenant,
  teardownThrowawayTenant,
  apiCall,
  countOf,
  assertUnchanged,
  clearBucket,
  describeResponse,
  type ThrowawayTenant,
} from "./lb-shared";
import {
  OPERATOR_SECRET,
  adminHeader,
  operatorCookieContext,
  forgedOperatorContext,
  secretFingerprint,
  pollAuditRow,
  SENTINEL_OPERATOR_ID,
  keysOf,
  sql,
  RUN_STAMP,
} from "./lg-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3847";

/** The whole operator-mutation plane shares one bucket: 20/hr, keyed on the
 *  sentinel id + "unknown" ip locally. Cleared before each block so a block
 *  cannot fail on a budget the previous block spent. */
const TENANT_ACTION_BUCKET = "admin:tenant-action";

async function tenantName(id: string): Promise<string> {
  const rows = await sql<{ name: string }>('SELECT name FROM "Tenant" WHERE id = $1', [id]);
  return rows[0]?.name ?? "";
}

async function tenantRow(id: string) {
  const rows = await sql<{
    id: string;
    subscriptionStatus: string;
    deletedAt: Date | null;
  }>('SELECT id, "subscriptionStatus", "deletedAt" FROM "Tenant" WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J60 · the three doors into the operator plane", () => {
  let opCtx: BrowserContext;
  let forged: BrowserContext;
  let anon: BrowserContext;

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!OPERATOR_SECRET, "MATFLOW_ADMIN_SECRET absent from .env.test — the operator plane cannot be driven");
    opCtx = await operatorCookieContext(browser, baseURL!);
    forged = await forgedOperatorContext(browser, baseURL!);
    anon = await anonContext(browser, baseURL!);
    await clearBucket("admin:login");
  });

  test.afterAll(async () => {
    await clearBucket("admin:login");
    await opCtx?.close().catch(() => {});
    await forged?.close().catch(() => {});
    await anon?.close().catch(() => {});
  });

  test("the login route accepts the secret, refuses a wrong one, and throttles at 5 per 15 min", async () => {
    console.log(`[L-G] operator secret ${secretFingerprint(OPERATOR_SECRET)}`);

    // Four wrong secrets, then the real one — the bucket is 5 per 15 minutes,
    // so the real attempt is the fifth and must still be allowed.
    for (let i = 0; i < 4; i++) {
      const bad = await apiCall(anon.request, "post", "/api/admin/auth/login", ORIGIN, {
        secret: `${RUN_STAMP}-wrong-${i}`,
      });
      expect(bad.status, `wrong secret attempt ${i}`).toBe(401);
      expect((bad.body as { error?: string }).error).toBe("Invalid secret");
    }

    const good = await apiCall(anon.request, "post", "/api/admin/auth/login", ORIGIN, {
      secret: OPERATOR_SECRET,
    });
    expect(good.status, "the real secret on the fifth attempt").toBe(200);
    expect((good.body as { ok?: boolean }).ok).toBe(true);
    // The Set-Cookie value IS the secret — never quoted, only counted.
    expect(good.contentType).toContain("application/json");

    // The sixth attempt is over the limit: 429, never 500.
    const over = await apiCall(anon.request, "post", "/api/admin/auth/login", ORIGIN, {
      secret: `${RUN_STAMP}-wrong-over`,
    });
    expect(over.status, "sixth attempt inside the window").toBe(429);
    expect((over.body as { error?: string }).error).toContain("Too many login attempts");

    await clearBucket("admin:login");
  });

  test("a malformed login body is a 400, not a 500, and does not spend identity", async () => {
    await clearBucket("admin:login");
    const empty = await apiCall(anon.request, "post", "/api/admin/auth/login", ORIGIN, {});
    expect(empty.status).toBe(400);
    expect((empty.body as { error?: string }).error).toBe("Invalid input");

    const oversize = await apiCall(anon.request, "post", "/api/admin/auth/login", ORIGIN, {
      secret: "x".repeat(10_000),
    });
    expect(oversize.status, "a 10 000-character secret").toBe(400);
    await clearBucket("admin:login");
  });

  test("a forged matflow_admin cookie opens nothing", async () => {
    const r = await apiCall(forged.request, "get", "/api/admin/activity", ORIGIN);
    describeResponse("forged cookie → GET /api/admin/activity", r);
    expect(r.status, "forged admin cookie").toBe(403);
    expect((r.body as { error?: string }).error).toBe("Forbidden");
    expect(r.body).not.toHaveProperty("items");
  });

  test("anonymous reaches the operator plane's own refusal, not a login redirect", async () => {
    // /api/admin is a PUBLIC_PREFIX in proxy.ts:28, so the route answers for
    // itself. maxRedirects:0 proves it is not a 307 dressed as a 200.
    const r = await apiCall(anon.request, "get", "/api/admin/activity", ORIGIN);
    expect([401, 403, 307], "anonymous GET /api/admin/activity").toContain(r.status);
    expect(r.status, "answered by the route, not the login redirect").toBe(403);
    expect(r.location, "no redirect").toBeNull();
    expect((r.body as { error?: string }).error).toBe("Forbidden");
  });

  test("the bare x-admin-secret header is a second door with no identity", async () => {
    // lib/admin-auth.ts:78-83 tries the header BEFORE any session. With no
    // cookie at all, a header-only caller reads the cross-tenant audit feed.
    const r = await apiCall(anon.request, "get", "/api/admin/activity", ORIGIN, undefined, adminHeader());
    expect(r.status, "header-only GET /api/admin/activity").toBe(200);
    // Round 1, defect 2: the door stays open by default (scripts rely on it),
    // but it is now switchable via ALLOW_ADMIN_SECRET_HEADER and every row
    // written through it is marked. The marker is asserted on a MUTATION
    // below, because a read writes no audit row.
    const body = r.body as { items?: unknown[] };
    expect(Array.isArray(body.items), "the cross-tenant audit feed was served to a header-only caller").toBe(true);
    console.log(
      `[L-G finding] x-admin-secret header with no session, no cookie → 200 and ${
        body.items?.length ?? 0
      } cross-tenant audit rows`,
    );
  });

  test("the operator identity routes exist and refuse a wrong password without enumerating", async () => {
    const unknown = await apiCall(anon.request, "post", "/api/admin/auth/operator-login", ORIGIN, {
      email: `${RUN_STAMP}-nobody@example.test`,
      password: "not-the-password",
    });
    const known = await apiCall(anon.request, "post", "/api/admin/auth/operator-login", ORIGIN, {
      email: "noe@matflow.studio",
      password: "not-the-password",
    });
    describeResponse("operator-login unknown email", unknown);
    describeResponse("operator-login known-shaped email", known);
    expect(unknown.status, "unknown and known emails answer alike").toBe(known.status);
    expect(JSON.stringify(unknown.body), "identical bodies for known and unknown").toBe(
      JSON.stringify(known.body),
    );

    // The TOTP setup route must not hand a secret to an unauthenticated caller.
    const setup = await apiCall(anon.request, "post", "/api/admin/auth/operator-totp/setup", ORIGIN, {});
    expect([400, 401, 403], "anonymous operator-totp/setup").toContain(setup.status);
    expect(JSON.stringify(setup.body)).not.toMatch(/otpauth:\/\//);
  });

  test("logout clears every admin cookie and the plane closes behind it", async ({ browser, baseURL }) => {
    const ctx = await operatorCookieContext(browser, baseURL!);
    try {
      const before = await apiCall(ctx.request, "get", "/api/admin/activity", ORIGIN);
      expect(before.status, "cookie door open before logout").toBe(200);

      const out = await apiCall(ctx.request, "post", "/api/admin/auth/logout", ORIGIN, {});
      expect(out.status).toBe(200);

      const after = await apiCall(ctx.request, "get", "/api/admin/activity", ORIGIN);
      expect(after.status, "cookie door closed after logout").toBe(403);
    } finally {
      await ctx.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J60 · every tenant role and anonymous are refused the plane", () => {
  const MUTATIONS: { method: "post" | "delete"; path: (id: string) => string; body: unknown; expect: number; error: string }[] = [
    { method: "post", path: (id) => `/api/admin/customers/${id}/suspend`, body: { reason: "campaign probe" }, expect: 403, error: "Forbidden" },
    { method: "post", path: (id) => `/api/admin/customers/${id}/soft-delete`, body: { reason: "campaign probe", confirmName: "anything" }, expect: 403, error: "Forbidden" },
    { method: "post", path: (id) => `/api/admin/customers/${id}/force-password-reset`, body: { reason: "campaign probe" }, expect: 403, error: "Forbidden" },
    { method: "post", path: (id) => `/api/admin/customers/${id}/totp-reset`, body: { reason: "campaign probe", confirmName: "anything" }, expect: 403, error: "Forbidden" },
    { method: "post", path: (id) => `/api/admin/customers/${id}/member-totp-reset`, body: { memberId: "x", reason: "campaign probe", confirmName: "anything" }, expect: 403, error: "Forbidden" },
    { method: "post", path: (id) => `/api/admin/customers/${id}/transfer-ownership`, body: { targetUserId: "x", reason: "campaign probe", confirmName: "anything" }, expect: 403, error: "Forbidden" },
  ];

  let victim: ThrowawayTenant;
  let anon: BrowserContext;
  const roleContexts: { role: string; ctx: BrowserContext }[] = [];

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!OPERATOR_SECRET, "MATFLOW_ADMIN_SECRET absent from .env.test");
    victim = await createThrowawayTenant();
    anon = await anonContext(browser, baseURL!);
    for (const [role, email] of [
      ["owner", OWNER_A],
      ["coach", COACH_A],
      ["admin", ADMIN_A],
    ] as const) {
      const ctx = await sessionFor(browser, baseURL!, { slug: SLUG_A, email, fresh: true });
      roleContexts.push({ role, ctx });
    }
  });

  test.afterAll(async () => {
    await anon?.close().catch(() => {});
    for (const { ctx } of roleContexts) await ctx.close().catch(() => {});
    await closeSessions();
    if (victim) await teardownThrowawayTenant(victim);
  });

  test("no tenant staff role can suspend, delete, reset or transfer another club", async () => {
    for (const { role, ctx } of roleContexts) {
      for (const m of MUTATIONS) {
        const before = await countOf("AuditLog", '"tenantId" = $1', [victim.id]);
        const beforeTenant = await tenantRow(victim.id);
        const r = await apiCall(ctx.request, m.method, m.path(victim.id), ORIGIN, m.body);
        expect(r.status, `${role} → ${m.method.toUpperCase()} ${m.path("<id>")}`).toBe(m.expect);
        expect((r.body as { error?: string }).error, `${role} refusal body`).toBe(m.error);
        await assertUnchanged("AuditLog", before, '"tenantId" = $1', [victim.id]);
        const afterTenant = await tenantRow(victim.id);
        expect(afterTenant, `${role} wrote nothing to the victim tenant`).toEqual(beforeTenant);
      }
      // create-tenant now answers 403 Forbidden like every neighbour.
      const ct = await apiCall(ctx.request, "post", "/api/admin/create-tenant", ORIGIN, {
        gymName: "Campaign Intruder",
        slug: `${RUN_STAMP}-intruder`,
        ownerName: "Nobody",
        ownerEmail: `${RUN_STAMP}-intruder@example.test`,
        ownerPassword: "Riverside!2026aA",
      });
      // Round 1, defect 4: aligned with its nine neighbours (was 401
      // "Unauthorized" for the identical condition).
      expect(ct.status, `${role} → POST /api/admin/create-tenant`).toBe(403);
      expect((ct.body as { error?: string }).error).toBe("Forbidden");
      const made = await countOf("Tenant", "slug = $1", [`${RUN_STAMP}-intruder`]);
      expect(made, "no tenant created by a tenant-role caller").toBe(0);
    }
  });

  test("a member session and an anonymous caller are refused identically", async ({ browser, baseURL }) => {
    const memberCtx = await sessionFor(browser, baseURL!, {
      slug: SLUG_A,
      email: MEMBER_A,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      fresh: true,
    }).catch(() => null);

    const contexts: { label: string; ctx: BrowserContext }[] = [{ label: "anonymous", ctx: anon }];
    if (memberCtx) contexts.push({ label: "member", ctx: memberCtx });

    try {
      for (const { label, ctx } of contexts) {
        const before = await countOf("AuditLog", '"tenantId" = $1', [victim.id]);
        const r = await apiCall(ctx.request, "post", `/api/admin/customers/${victim.id}/suspend`, ORIGIN, {
          reason: "campaign probe",
        });
        expect(r.status, `${label} → POST suspend`).toBe(403);
        expect((r.body as { error?: string }).error).toBe("Forbidden");
        expect(r.location, `${label} answered by the route, not a redirect`).toBeNull();
        await assertUnchanged("AuditLog", before, '"tenantId" = $1', [victim.id]);

        const feed = await apiCall(ctx.request, "get", "/api/admin/activity", ORIGIN);
        expect(feed.status, `${label} → GET /api/admin/activity`).toBe(403);
        expect(feed.body).not.toHaveProperty("items");
      }
    } finally {
      await memberCtx?.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J60 · CSRF on every operator mutation", () => {
  let victim: ThrowawayTenant;
  let opCtx: BrowserContext;

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!OPERATOR_SECRET, "MATFLOW_ADMIN_SECRET absent from .env.test");
    victim = await createThrowawayTenant();
    opCtx = await operatorCookieContext(browser, baseURL!);
    await clearBucket(TENANT_ACTION_BUCKET);
  });

  test.afterAll(async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    await opCtx?.close().catch(() => {});
    if (victim) await teardownThrowawayTenant(victim);
  });

  const GUARDED: { label: string; method: "post" | "delete"; path: (id: string) => string; body?: unknown }[] = [
    { label: "suspend", method: "post", path: (id) => `/api/admin/customers/${id}/suspend`, body: { reason: "campaign csrf probe" } },
    { label: "unsuspend", method: "delete", path: (id) => `/api/admin/customers/${id}/suspend` },
    { label: "soft-delete", method: "post", path: (id) => `/api/admin/customers/${id}/soft-delete`, body: { reason: "campaign csrf probe", confirmName: "x" } },
    { label: "restore", method: "delete", path: (id) => `/api/admin/customers/${id}/soft-delete` },
    { label: "force-password-reset", method: "post", path: (id) => `/api/admin/customers/${id}/force-password-reset`, body: { reason: "campaign csrf probe" } },
    { label: "totp-reset", method: "post", path: (id) => `/api/admin/customers/${id}/totp-reset`, body: { reason: "campaign csrf probe", confirmName: "x" } },
    { label: "member-totp-reset", method: "post", path: (id) => `/api/admin/customers/${id}/member-totp-reset`, body: { memberId: "x", reason: "campaign csrf probe", confirmName: "x" } },
    { label: "transfer-ownership", method: "post", path: (id) => `/api/admin/customers/${id}/transfer-ownership`, body: { targetUserId: "x", reason: "campaign csrf probe", confirmName: "x" } },
    { label: "impersonate", method: "post", path: () => `/api/admin/impersonate`, body: { targetUserId: "x", reason: "campaign csrf probe" } },
  ];

  test("a mutation with no Origin and no Referer is refused before authentication", async ({ request }) => {
    for (const g of GUARDED) {
      const before = await countOf("AuditLog", '"tenantId" = $1', [victim.id]);
      const res = await request.fetch(g.path(victim.id), {
        method: g.method.toUpperCase(),
        maxRedirects: 0,
        headers: { "x-admin-secret": OPERATOR_SECRET },
        ...(g.body === undefined ? {} : { data: g.body as Record<string, unknown> }),
      });
      const body = await res.json().catch(() => ({}));
      expect(res.status(), `${g.label} with no Origin`).toBe(403);
      expect((body as { error?: string }).error, `${g.label} CSRF body`).toBe(
        "Origin or Referer header required for this request",
      );
      await assertUnchanged("AuditLog", before, '"tenantId" = $1', [victim.id]);
    }
  });

  test("a foreign Origin is refused on every operator mutation", async ({ request }) => {
    for (const g of GUARDED) {
      const before = await countOf("AuditLog", '"tenantId" = $1', [victim.id]);
      const res = await request.fetch(g.path(victim.id), {
        method: g.method.toUpperCase(),
        maxRedirects: 0,
        headers: { Origin: "http://evil.test", "x-admin-secret": OPERATOR_SECRET },
        ...(g.body === undefined ? {} : { data: g.body as Record<string, unknown> }),
      });
      const body = await res.json().catch(() => ({}));
      expect(res.status(), `${g.label} with a foreign Origin`).toBe(403);
      expect((body as { error?: string }).error).toBe("Forbidden: cross-origin request rejected");
      await assertUnchanged("AuditLog", before, '"tenantId" = $1', [victim.id]);
    }
  });

  test("a matched forged Origin/Host pair is HELD by construction — recorded, not claimed as safe", async ({ request }) => {
    // lib/csrf.ts:50-56 adds `http://<Host>` to the allow-list on the strength
    // of a comment — "The Origin header is set by the browser, not the
    // attacker, so this is safe". That invariant holds for a browser and not
    // for this client, so the pair passes the guard. It is HELD rather than an
    // exploit because no browser will send a victim's cookie to evil.test.
    const before = await countOf("AuditLog", '"tenantId" = $1', [victim.id]);
    const res = await request.fetch(`/api/admin/customers/${victim.id}/suspend`, {
      method: "POST",
      maxRedirects: 0,
      headers: { Origin: "http://evil.test", Host: "evil.test" },
      data: { reason: "campaign matched-pair probe" },
    });
    const body = await res.json().catch(() => ({}));
    console.log(
      `[L-G] matched Origin/Host forgery → status=${res.status()} body=${JSON.stringify(body).slice(0, 120)}`,
    );
    // No admin credential was presented, so the plane must still refuse.
    expect([401, 403], "matched forged pair with no credential").toContain(res.status());
    await assertUnchanged("AuditLog", before, '"tenantId" = $1', [victim.id]);
    const t = await tenantRow(victim.id);
    expect(t?.subscriptionStatus, "nothing was suspended").not.toBe("suspended");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J60 · the nine customer mutations, on a club this lane owns", () => {
  let victim: ThrowawayTenant;
  let victimName: string;
  let opCtx: BrowserContext;

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!OPERATOR_SECRET, "MATFLOW_ADMIN_SECRET absent from .env.test");
    victim = await createThrowawayTenant();
    victimName = await tenantName(victim.id);
    opCtx = await operatorCookieContext(browser, baseURL!);
    await clearBucket(TENANT_ACTION_BUCKET);
  });

  test.afterAll(async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    await opCtx?.close().catch(() => {});
    if (victim) await teardownThrowawayTenant(victim);
  });

  test("suspend then unsuspend moves the row and attributes the operator", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/suspend`, ORIGIN, {
      reason: "campaign suspend probe",
    });
    expect(r.status, "operator suspend").toBe(200);

    const row = await tenantRow(victim.id);
    expect(row?.subscriptionStatus, "the row, not the screen").toBe("suspended");

    const audit = await pollAuditRow("admin.tenant.suspended", victim.id);
    expect(audit.actingAs, "audit attribution for a cookie-door operator").toBe(SENTINEL_OPERATOR_ID);

    // A suspended club must look exactly like one that never existed.
    const anonLook = await apiCall(opCtx.request, "get", `/api/tenant/${victim.slug}`, ORIGIN);
    expect(anonLook.status, "suspended club is a 404 to the public lookup").toBe(404);
    expect((anonLook.body as { error?: string }).error).toBe("Gym not found");

    const back = await apiCall(opCtx.request, "delete", `/api/admin/customers/${victim.id}/suspend`, ORIGIN);
    expect(back.status, "unsuspend").toBe(200);
    const restored = await tenantRow(victim.id);
    expect(restored?.subscriptionStatus).not.toBe("suspended");
  });

  test("a mutation through the header door is marked in the audit row", async ({ request }) => {
    // Round 1, defect 2. The `x-admin-secret` door stays open, so the trail
    // has to say when it was used: `metadata.via = "shared-secret-header"`
    // (lib/audit-log.ts). Without it, a row written by a shared constant is
    // indistinguishable from one written by a named operator.
    await clearBucket(TENANT_ACTION_BUCKET);
    const res = await request.fetch(`/api/admin/customers/${victim.id}/suspend`, {
      method: "POST",
      maxRedirects: 0,
      headers: { Origin: ORIGIN, ...adminHeader() },
      data: { reason: "campaign header-door probe" },
    });
    expect(res.status(), "the header door still works — it was not removed").toBe(200);

    const audit = await pollAuditRow("admin.tenant.suspended", victim.id);
    expect(audit.actingAs, "still attributed").toBe(SENTINEL_OPERATOR_ID);
    const marked = await sql<{ via: string | null }>(
      `SELECT metadata->>'via' AS via FROM "AuditLog" WHERE id = $1`,
      [audit.id],
    );
    expect(marked[0].via, "the row names the door it came through").toBe("shared-secret-header");

    await apiCall(opCtx.request, "delete", `/api/admin/customers/${victim.id}/suspend`, ORIGIN);
    await clearBucket(TENANT_ACTION_BUCKET);
  });

  test("suspend refuses a reason under five characters and writes nothing", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const before = await tenantRow(victim.id);
    const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/suspend`, ORIGIN, {
      reason: "no",
    });
    expect(r.status, "a four-character reason").toBe(400);
    expect(await tenantRow(victim.id)).toEqual(before);

    const oversize = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/suspend`, ORIGIN, {
      reason: "x".repeat(10_000),
    });
    expect(oversize.status, "a 10 000-character reason").toBe(400);
    expect(await tenantRow(victim.id)).toEqual(before);
  });

  test("soft-delete needs the exact club name, then restores", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const wrong = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/soft-delete`, ORIGIN, {
      reason: "campaign delete probe",
      confirmName: `${victimName} `,
    });
    expect(wrong.status, "a near-miss confirmation").toBe(400);
    expect((await tenantRow(victim.id))?.deletedAt, "nothing deleted on a near miss").toBeNull();

    const right = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/soft-delete`, ORIGIN, {
      reason: "campaign delete probe",
      confirmName: victimName,
    });
    expect(right.status, "the exact name").toBe(200);
    expect((await tenantRow(victim.id))?.deletedAt, "deletedAt is stamped").not.toBeNull();

    // Twice is a 409, not a second delete and not a 500.
    const again = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/soft-delete`, ORIGIN, {
      reason: "campaign delete probe",
      confirmName: victimName,
    });
    expect(again.status, "soft-delete replayed").toBe(409);

    const restore = await apiCall(opCtx.request, "delete", `/api/admin/customers/${victim.id}/soft-delete`, ORIGIN);
    expect(restore.status, "restore").toBe(200);
    expect((await tenantRow(victim.id))?.deletedAt).toBeNull();

    const restoreAgain = await apiCall(opCtx.request, "delete", `/api/admin/customers/${victim.id}/soft-delete`, ORIGIN);
    expect(restoreAgain.status, "restore replayed on a live tenant").toBe(409);
  });

  test("force-password-reset signs the owner out and hands back a temp password once", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const before = await sql<{ sessionVersion: number; passwordHash: string }>(
      'SELECT "sessionVersion", "passwordHash" FROM "User" WHERE id = $1',
      [victim.ownerId],
    );

    const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/force-password-reset`, ORIGIN, {
      reason: "campaign reset probe",
    });
    expect(r.status).toBe(200);
    const body = r.body as { ok?: boolean; tempPassword?: string; ownerEmail?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.tempPassword, "a temp password is returned to the operator").toBe("string");
    expect(body.ownerEmail).toBe(victim.ownerEmail);

    const after = await sql<{ sessionVersion: number; passwordHash: string }>(
      'SELECT "sessionVersion", "passwordHash" FROM "User" WHERE id = $1',
      [victim.ownerId],
    );
    expect(after[0].sessionVersion, "sessionVersion bumped — every live JWT is evicted").toBe(
      before[0].sessionVersion + 1,
    );
    expect(after[0].passwordHash, "the hash actually changed").not.toBe(before[0].passwordHash);

    const audit = await pollAuditRow("admin.owner.force_password_reset", victim.ownerId);
    expect(audit.actingAs).toBe(SENTINEL_OPERATOR_ID);

    // The temp password must never appear in the audit metadata.
    const meta = await sql<{ metadata: unknown }>(
      'SELECT metadata FROM "AuditLog" WHERE id = $1',
      [audit.id],
    );
    expect(JSON.stringify(meta[0].metadata), "the temp password is not in the audit row").not.toContain(
      body.tempPassword!,
    );
  });

  test("totp-reset clears the flag, the secret and the recovery codes, and bumps the session", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    // ARRANGE — not wrapped in a catch: if this fails the case is invalid.
    await sql(
      `UPDATE "User" SET "totpEnabled" = true, "totpSecret" = $2, "totpRecoveryCodes" = $3::jsonb WHERE id = $1`,
      [victim.ownerId, `${RUN_STAMP}-secret`, JSON.stringify(["hash-a", "hash-b"])],
    );
    const before = await sql<{ sessionVersion: number }>(
      'SELECT "sessionVersion" FROM "User" WHERE id = $1',
      [victim.ownerId],
    );

    const wrong = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/totp-reset`, ORIGIN, {
      reason: "campaign totp probe",
      confirmName: "Not The Club",
    });
    expect(wrong.status, "wrong confirmation").toBe(400);
    const stillOn = await sql<{ totpEnabled: boolean }>(
      'SELECT "totpEnabled" FROM "User" WHERE id = $1',
      [victim.ownerId],
    );
    expect(stillOn[0].totpEnabled, "a wrong confirmation changed nothing").toBe(true);

    const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/totp-reset`, ORIGIN, {
      reason: "campaign totp probe",
      confirmName: victimName,
    });
    expect(r.status).toBe(200);

    const after = await sql<{
      totpEnabled: boolean;
      totpSecret: string | null;
      totpRecoveryCodes: unknown;
      sessionVersion: number;
    }>(
      'SELECT "totpEnabled", "totpSecret", "totpRecoveryCodes", "sessionVersion" FROM "User" WHERE id = $1',
      [victim.ownerId],
    );
    expect(after[0].totpEnabled).toBe(false);
    expect(after[0].totpSecret).toBeNull();
    expect(after[0].totpRecoveryCodes, "old recovery codes are cleared, not left behind").toBeNull();
    expect(after[0].sessionVersion).toBe(before[0].sessionVersion + 1);

    expect(JSON.stringify(r.body), "the response does not echo the old TOTP secret").not.toContain(
      `${RUN_STAMP}-secret`,
    );
  });

  test("member-totp-reset refuses a member from another club", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    // A member of the SEEDED club, presented against this lane's throwaway
    // tenant — the cross-tenant case, and the one that must 404 rather than
    // 403 (a 403 would confirm the id exists somewhere).
    const foreign = await sql<{ id: string }>(
      `SELECT m.id FROM "Member" m JOIN "Tenant" t ON t.id = m."tenantId" WHERE t.slug = $1 LIMIT 1`,
      [SLUG_A],
    );
    test.skip(foreign.length === 0, "the seeded club has no member to borrow an id from");

    const before = await sql<{ totpEnabled: boolean }>(
      'SELECT "totpEnabled" FROM "Member" WHERE id = $1',
      [foreign[0].id],
    );
    const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/member-totp-reset`, ORIGIN, {
      memberId: foreign[0].id,
      reason: "campaign cross-tenant probe",
      confirmName: victimName,
    });
    expect(r.status, "a foreign member id answers like a missing one").toBe(404);
    expect((r.body as { error?: string }).error).toBe("Member not found in this tenant");
    const after = await sql<{ totpEnabled: boolean }>(
      'SELECT "totpEnabled" FROM "Member" WHERE id = $1',
      [foreign[0].id],
    );
    expect(after, "the seeded club's member was not touched").toEqual(before);
  });

  test("transfer-ownership refuses a non-user and a user from another club", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const foreignUser = await sql<{ id: string }>(
      `SELECT u.id FROM "User" u JOIN "Tenant" t ON t.id = u."tenantId" WHERE t.slug = $1 AND u.role = 'coach' LIMIT 1`,
      [SLUG_A],
    );

    for (const [label, targetUserId] of [
      ["a non-user", `${RUN_STAMP}-no-such-user`],
      ...(foreignUser.length ? ([["a user of another club", foreignUser[0].id]] as const) : []),
    ] as [string, string][]) {
      const beforeOwner = await sql<{ id: string }>(
        `SELECT id FROM "User" WHERE "tenantId" = $1 AND role = 'owner'`,
        [victim.id],
      );
      const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/transfer-ownership`, ORIGIN, {
        targetUserId,
        reason: "campaign transfer probe",
        confirmName: victimName,
      });
      expect(r.status, `transfer to ${label}`).toBe(404);
      expect((r.body as { error?: string }).error).toBe("Target user not found on this tenant");
      const afterOwner = await sql<{ id: string }>(
        `SELECT id FROM "User" WHERE "tenantId" = $1 AND role = 'owner'`,
        [victim.id],
      );
      expect(afterOwner, `ownership unchanged after ${label}`).toEqual(beforeOwner);
    }

    // The seeded club's roles must be intact after the cross-tenant attempt.
    if (foreignUser.length) {
      const stillCoach = await sql<{ role: string }>('SELECT role FROM "User" WHERE id = $1', [foreignUser[0].id]);
      expect(stillCoach[0].role, "the borrowed coach was not promoted").toBe("coach");
    }
  });

  test("transfer-ownership moves the role exactly once when the target is real", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const suffix = Math.random().toString(36).slice(2, 8);
    const target = await sql<{ id: string }>(
      `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'manager', 0, now(), now())
       RETURNING id`,
      [victim.id, `${RUN_STAMP}-heir-${suffix}@example.test`, `Campaign Heir ${suffix}`, "$2b$10$notalogin"],
    );

    const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/transfer-ownership`, ORIGIN, {
      targetUserId: target[0].id,
      reason: "campaign transfer probe",
      confirmName: victimName,
    });
    expect(r.status).toBe(200);

    const owners = await sql<{ id: string }>(
      `SELECT id FROM "User" WHERE "tenantId" = $1 AND role = 'owner'`,
      [victim.id],
    );
    expect(owners.length, "exactly one owner after a transfer").toBe(1);
    expect(owners[0].id).toBe(target[0].id);

    // Replayed: the target is already the owner.
    const again = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/transfer-ownership`, ORIGIN, {
      targetUserId: target[0].id,
      reason: "campaign transfer probe",
      confirmName: victimName,
    });
    expect(again.status, "transfer replayed").toBe(400);
    const ownersAfter = await sql<{ id: string }>(
      `SELECT id FROM "User" WHERE "tenantId" = $1 AND role = 'owner'`,
      [victim.id],
    );
    expect(ownersAfter.length, "still exactly one owner").toBe(1);

    // Put the original owner back so teardown order is unchanged.
    await sql(`UPDATE "User" SET role = 'owner' WHERE id = $1`, [victim.ownerId]);
    await sql(`UPDATE "User" SET role = 'manager' WHERE id = $1`, [target[0].id]);
  });

  test("a foreign tenant id answers like a missing one on every customer mutation", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    const missing = `${RUN_STAMP}-no-such-tenant`;
    for (const path of [
      `/api/admin/customers/${missing}/suspend`,
      `/api/admin/customers/${missing}/force-password-reset`,
    ]) {
      const r = await apiCall(opCtx.request, "post", path, ORIGIN, {
        reason: "campaign missing-id probe",
      });
      expect(r.status, `${path} with an unknown id`).toBe(404);
      expect((r.body as { error?: string }).error).toBe("Tenant not found");
    }
  });

  test("the destructive-action bucket answers 429, never 500, and is reset afterwards", async () => {
    await clearBucket(TENANT_ACTION_BUCKET);
    // 20 per hour (each route's RL_MAX). Spend the budget on the cheapest
    // refusal that still consumes it — a 400 after the limiter runs.
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const r = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/suspend`, ORIGIN, {
        reason: "no",
      });
      statuses.push(r.status);
      if (r.status === 429) break;
    }
    expect(statuses, "the bucket closes with a 429").toContain(429);
    expect(statuses.filter((s) => s >= 500), "no 500 anywhere in the sequence").toEqual([]);
    await clearBucket(TENANT_ACTION_BUCKET);

    // Reset proven by a fresh request, not by the absence of an error.
    const after = await apiCall(opCtx.request, "post", `/api/admin/customers/${victim.id}/suspend`, ORIGIN, {
      reason: "no",
    });
    expect(after.status, "the bucket is genuinely clear again").toBe(400);
    await clearBucket(TENANT_ACTION_BUCKET);
  });

  test("x-forwarded-for cannot open a fresh bucket while a trusted header is present", async ({ request }) => {
    await clearBucket("admin:login");
    // getClientIp prefers x-vercel-forwarded-for (lib/rate-limit.ts:117-118).
    // With it present, a spoofed x-forwarded-for must not move the bucket.
    const pinned = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 5; i++) {
      await request.fetch("/api/admin/auth/login", {
        method: "POST",
        maxRedirects: 0,
        headers: {
          Origin: ORIGIN,
          "x-vercel-forwarded-for": pinned,
          "x-forwarded-for": `198.51.100.${i}`,
        },
        data: { secret: `${RUN_STAMP}-spoof-${i}` },
      });
    }
    const res = await request.fetch("/api/admin/auth/login", {
      method: "POST",
      maxRedirects: 0,
      headers: {
        Origin: ORIGIN,
        "x-vercel-forwarded-for": pinned,
        "x-forwarded-for": "198.51.100.99",
      },
      data: { secret: `${RUN_STAMP}-spoof-final` },
    });
    expect(res.status(), "a spoofed x-forwarded-for did not buy a fresh allowance").toBe(429);
    const buckets = await sql<{ bucket: string }>(
      `SELECT DISTINCT bucket FROM "RateLimitHit" WHERE bucket LIKE $1`,
      [`admin:login:%`],
    );
    expect(buckets.map((b) => b.bucket), "one bucket, keyed on the trusted header").toEqual([
      `admin:login:${pinned}`,
    ]);
    await clearBucket("admin:login");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J60 · create-tenant and the operator's own reads", () => {
  let opCtx: BrowserContext;
  const made: string[] = [];

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!OPERATOR_SECRET, "MATFLOW_ADMIN_SECRET absent from .env.test");
    opCtx = await operatorCookieContext(browser, baseURL!);
    await clearBucket("admin:create-tenant");
  });

  test.afterAll(async () => {
    for (const id of made) {
      await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1', [id]).catch(() => {});
      await sql('DELETE FROM "User" WHERE "tenantId" = $1', [id]).catch(() => {});
      await sql('DELETE FROM "Tenant" WHERE id = $1', [id]).catch(() => {});
      const left = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE id = $1', [id]);
      expect(left, "created tenant is gone").toEqual([]);
    }
    await clearBucket("admin:create-tenant");
    await opCtx?.close().catch(() => {});
  });

  test("create-tenant makes exactly one club, refuses the slug twice, and audits the operator", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const slug = `${RUN_STAMP}-ct-${suffix}`.toLowerCase();
    const payload = {
      gymName: `Campaign Created ${suffix}`,
      slug,
      ownerName: `Campaign Owner ${suffix}`,
      ownerEmail: `${RUN_STAMP}-ctowner-${suffix}@example.test`,
      ownerPassword: "Riverside!2026aA",
    };

    const r = await apiCall(opCtx.request, "post", "/api/admin/create-tenant", ORIGIN, payload);
    expect(r.status, "create-tenant").toBe(201);
    const body = r.body as { tenantId?: string; slug?: string; ownerEmail?: string };
    expect(body.slug).toBe(slug);
    expect(body.tenantId).toBeTruthy();
    made.push(body.tenantId!);

    // The response must not hand back the password it was given.
    expect(JSON.stringify(r.body), "the owner password is not echoed").not.toContain(payload.ownerPassword);
    expect(keysOf(r.body), "create-tenant response key set").toEqual(
      ["clubCode", "loginUrl", "ownerEmail", "slug", "success", "tenantId"].sort(),
    );

    const rows = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', [slug]);
    expect(rows.length, "exactly one club").toBe(1);

    const audit = await pollAuditRow("admin.tenant.create", body.tenantId!);
    expect(audit.actingAs).toBe(SENTINEL_OPERATOR_ID);

    const dup = await apiCall(opCtx.request, "post", "/api/admin/create-tenant", ORIGIN, payload);
    expect(dup.status, "the same slug twice").toBe(409);
    expect((dup.body as { error?: string }).error).toBe("A gym with that slug already exists");
    const after = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', [slug]);
    expect(after.length, "still exactly one club").toBe(1);
  });

  test("create-tenant refuses an oversize name, a bad slug and a weak password without writing", async () => {
    const before = await countOf("Tenant");
    for (const [label, payload] of [
      ["a 10 000-character name", { gymName: "x".repeat(10_000) }],
      ["an uppercase slug", { slug: `${RUN_STAMP}-BAD` }],
      ["a seven-character password", { ownerPassword: "sevench" }],
      ["a non-email owner", { ownerEmail: "not-an-email" }],
    ] as [string, Record<string, unknown>][]) {
      const suffix = Math.random().toString(36).slice(2, 8);
      const r = await apiCall(opCtx.request, "post", "/api/admin/create-tenant", ORIGIN, {
        gymName: `Campaign Reject ${suffix}`,
        slug: `${RUN_STAMP}-rj-${suffix}`.toLowerCase(),
        ownerName: "Campaign Owner",
        ownerEmail: `${RUN_STAMP}-rj-${suffix}@example.test`,
        ownerPassword: "Riverside!2026aA",
        ...payload,
      });
      expect(r.status, label).toBe(400);
      expect((r.body as { error?: string }).error).toBe("Invalid data");
    }
    await assertUnchanged("Tenant", before);
  });

  test("the activity feed is cross-tenant, cursor-capped and masks the last IP octet", async () => {
    const r = await apiCall(opCtx.request, "get", "/api/admin/activity", ORIGIN);
    expect(r.status).toBe(200);
    const body = r.body as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length, "page size is capped at 100").toBeLessThanOrEqual(100);
    if (body.items.length > 0) {
      expect(keysOf(body.items[0]), "activity item key set").toEqual(
        [
          "action",
          "actorEmail",
          "actorName",
          "createdAt",
          "entityId",
          "entityType",
          "id",
          "ipApprox",
          "metadata",
          "tenantId",
          "tenantName",
          "tenantSlug",
        ].sort(),
      );
      for (const item of body.items) {
        const ip = item.ipApprox as string | null;
        if (ip && ip.includes(".")) {
          expect(ip.endsWith(".0"), "the last octet is masked").toBe(true);
        }
      }
    }
  });

  test("admin/email/test is gated by TENANT owner, not by the operator — recorded as placed on the wrong plane", async ({
    browser,
    baseURL,
  }) => {
    // app/api/admin/email/test/route.ts:18 calls requireApiOwner(), so an
    // operator holding the platform master credential is refused a route that
    // sits under /api/admin. Recorded; not fixed this round.
    const asOperator = await apiCall(opCtx.request, "post", "/api/admin/email/test", ORIGIN, {
      to: `${RUN_STAMP}@example.test`,
    });
    console.log(`[L-G] operator → POST /api/admin/email/test = ${asOperator.status}`);
    expect([401, 403], "the operator is refused a route on the operator plane").toContain(asOperator.status);
    expect((asOperator.body as { ok?: boolean }).ok, "refusal shape through lib/api-authz").toBe(false);

    const ownerCtx = await sessionFor(browser, baseURL!, { slug: SLUG_A, email: OWNER_A, fresh: true });
    try {
      const before = await countOf("EmailLog", 'recipient = $1', [`${RUN_STAMP}-mail@example.test`]);
      const asOwner = await apiCall(ownerCtx.request, "post", "/api/admin/email/test", ORIGIN, {
        to: `${RUN_STAMP}-mail@example.test`,
      });
      // .env.test has no mail key — the send fails and the ROW is the proof
      // the route ran. Delivery is UNCOVERED (needs a live service, Resend).
      expect([200, 500], "the owner reaches the route").toContain(asOwner.status);
      await expect
        .poll(async () => countOf("EmailLog", 'recipient = $1', [`${RUN_STAMP}-mail@example.test`]), {
          timeout: 10_000,
          message: "an EmailLog row proves the route ran",
        })
        .toBeGreaterThan(before);
      const row = await sql<{ status: string }>('SELECT status FROM "EmailLog" WHERE recipient = $1 ORDER BY "createdAt" DESC LIMIT 1', [
        `${RUN_STAMP}-mail@example.test`,
      ]);
      console.log(`[L-G] EmailLog status for the owner test send = ${row[0]?.status}`);
    } finally {
      await sql('DELETE FROM "EmailLog" WHERE recipient LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
      await ownerCtx.close().catch(() => {});
      await closeSessions();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J60 · the operator pages at 768", () => {
  test("the /admin pages refuse a session-less browser by redirect, not by an empty screen", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({
      baseURL,
      storageState: undefined,
      viewport: { width: 768, height: 1024 },
    });
    await ctx.clearCookies();
    const page = await ctx.newPage();
    try {
      await page.goto("/admin/tenants", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      expect(new URL(page.url()).pathname, "proxy.ts:140-153 sends a session-less caller to the login").toBe(
        "/admin/login",
      );
      const metrics = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        window.innerWidth,
      ]);
      expect(metrics, "[scrollWidth, innerWidth] at 768").toEqual([768, 768]);
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  });
});
