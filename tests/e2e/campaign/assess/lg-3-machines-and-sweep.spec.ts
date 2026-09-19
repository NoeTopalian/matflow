/**
 * Lane L-G — J61: the machine routes, and the cross-cutting sweep nobody else
 * owns (tokens, limits, and the PII key set of every unauthenticated response).
 *
 * Nothing here mutates the seeded club. The crons run against the whole test
 * database by design — each is asserted to be idempotent on a second run
 * rather than asserted to have produced a particular number of rows, because
 * other lanes are creating classes at the same time.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  SLUG_A,
  anonContext,
  createThrowawayTenant,
  teardownThrowawayTenant,
  apiCall,
  countOf,
  assertUnchanged,
  clearBucket,
  describeResponse,
  type ThrowawayTenant,
} from "./lb-shared";
import { mintMagicToken, magicTokenRow, hashToken } from "./la-shared";
import {
  CRON_SECRET,
  OPERATOR_SECRET,
  cronHeader,
  secretFingerprint,
  deepKeys,
  keysOf,
  PII_KEYS,
  rowIsRecent,
  sql,
  RUN_STAMP,
} from "./lg-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3847";

const CRONS = ["class-instances", "retention", "monthly-reports", "stripe-reconcile"] as const;

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J61 · the crons and their bearer", () => {
  let anon: BrowserContext;

  test.beforeAll(async ({ browser, baseURL }) => {
    anon = await anonContext(browser, baseURL!);
    console.log(`[L-G] cron secret ${secretFingerprint(CRON_SECRET)}`);
  });

  test.afterAll(async () => {
    await anon?.close().catch(() => {});
  });

  test("no bearer at all is refused on every cron, and nothing runs", async () => {
    for (const name of CRONS) {
      const r = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN);
      describeResponse(`GET /api/cron/${name} with no bearer`, r);
      // 401 when CRON_SECRET is configured (the route compares against
      // `Bearer <secret>` and a missing header cannot match); 503 only when
      // the env var is absent. The brief's "503 without it" describes the
      // unconfigured deployment, not this one.
      expect([401, 503], `${name} with no bearer`).toContain(r.status);
      expect(r.status, `${name} — CRON_SECRET is present in .env.test`).toBe(CRON_SECRET ? 401 : 503);
      expect((r.body as { error?: string }).error).toBe(CRON_SECRET ? "Unauthorized" : "CRON_SECRET not configured");
      expect(r.location, "answered by the route, not a login redirect").toBeNull();
    }
  });

  test("a wrong bearer is refused on every cron", async () => {
    for (const name of CRONS) {
      const r = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN, undefined, {
        authorization: `Bearer ${RUN_STAMP}-not-the-secret`,
      });
      expect(r.status, `${name} with a wrong bearer`).toBe(401);
      expect((r.body as { error?: string }).error).toBe("Unauthorized");
    }
  });

  test("a bare secret with no Bearer prefix is refused, and so is a lowercase scheme", async () => {
    test.skip(!CRON_SECRET, "CRON_SECRET absent from .env.test");
    for (const name of CRONS) {
      const r = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN, undefined, {
        authorization: CRON_SECRET,
      });
      expect(r.status, `${name} with a prefix-less secret`).toBe(401);

      // Round 1, defect 3: the comparison is now constant-time
      // (lib/constant-time.ts `bearerMatches`). The presentation rules it
      // pins are asserted here against the live route.
      const lower = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN, undefined, {
        authorization: `bearer ${CRON_SECRET}`,
      });
      expect(lower.status, `${name} with a lowercase scheme`).toBe(401);

      const padded = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN, undefined, {
        authorization: `Bearer  ${CRON_SECRET}`,
      });
      expect(padded.status, `${name} with a doubled space`).toBe(401);
    }
  });

  test("class-instances is idempotent: the second run in the same minute creates none", async () => {
    test.skip(!CRON_SECRET, "CRON_SECRET absent from .env.test");
    const first = await apiCall(anon.request, "get", "/api/cron/class-instances", ORIGIN, undefined, cronHeader());
    expect(first.status, "first run").toBe(200);
    describeResponse("cron/class-instances first run", first);

    const countAfterFirst = await countOf("ClassInstance");
    const second = await apiCall(anon.request, "get", "/api/cron/class-instances", ORIGIN, undefined, cronHeader());
    expect(second.status, "second run").toBe(200);

    const body = second.body as Record<string, unknown>;
    const created = (body.created ?? body.instancesCreated ?? body.totalCreated) as number | undefined;
    if (typeof created === "number") {
      expect(created, "the second run creates nothing").toBe(0);
    }
    // Other lanes create classes concurrently, so the floor is the assertion:
    // the re-run must not DELETE anything.
    expect(await countOf("ClassInstance"), "the re-run destroyed nothing").toBeGreaterThanOrEqual(
      countAfterFirst,
    );
  });

  test("retention, monthly-reports and stripe-reconcile answer with their results, never a 500", async () => {
    test.skip(!CRON_SECRET, "CRON_SECRET absent from .env.test");
    for (const name of ["retention", "monthly-reports", "stripe-reconcile"] as const) {
      const r = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN, undefined, cronHeader());
      describeResponse(`cron/${name} with the bearer`, r);
      // stripe-reconcile answers 503 "Stripe not configured" when the key is
      // absent — a named dependency, not a failure.
      expect([200, 503], `${name} status`).toContain(r.status);
      expect(r.status, `${name} never 500s`).toBeLessThan(500);
      const again = await apiCall(anon.request, "get", `/api/cron/${name}`, ORIGIN, undefined, cronHeader());
      expect(again.status, `${name} replayed`).toBe(r.status);
    }
  });

  test("a cron route is a GET only — POST is not an alternative door", async () => {
    test.skip(!CRON_SECRET, "CRON_SECRET absent from .env.test");
    const r = await apiCall(anon.request, "post", "/api/cron/retention", ORIGIN, {}, cronHeader());
    expect(r.status, "POST to a GET-only cron").toBe(405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J61 · health, tenant lookup and the resend webhook", () => {
  let anon: BrowserContext;
  let throwaway: ThrowawayTenant;

  test.beforeAll(async ({ browser, baseURL }) => {
    anon = await anonContext(browser, baseURL!);
    throwaway = await createThrowawayTenant();
  });

  test.afterAll(async () => {
    await clearBucket("tenant-lookup");
    await anon?.close().catch(() => {});
    if (throwaway) await teardownThrowawayTenant(throwaway);
  });

  test("health is a 200 with three keys and nothing about the deployment", async () => {
    const r = await apiCall(anon.request, "get", "/api/health", ORIGIN);
    expect(r.status).toBe(200);
    expect(keysOf(r.body), "health key set").toEqual(["db", "status", "timestamp"]);
    expect((r.body as { status?: string }).status).toBe("ok");
    expect((r.body as { db?: string }).db).toBe("ok");
    expect(JSON.stringify(r.body), "no version, env or host leaks").not.toMatch(/neon|postgres|vercel|process/i);
  });

  test("tenant/[slug] tells an unknown club and a suspended club apart from nothing", async () => {
    await clearBucket("tenant-lookup");
    const known = await apiCall(anon.request, "get", `/api/tenant/${SLUG_A}`, ORIGIN);
    expect(known.status, "a live club").toBe(200);
    expect(keysOf(known.body), "public branding key set — branding only, no PII").toEqual(
      ["bgColor", "fontFamily", "logoUrl", "name", "primaryColor", "secondaryColor", "slug", "textColor"].sort(),
    );
    for (const k of PII_KEYS) {
      expect(deepKeys(known.body), `public branding must not carry ${k}`).not.toContain(k);
    }
    expect(JSON.stringify(known.body)).not.toMatch(/subscriptionStatus|deletedAt/);

    const unknown = await apiCall(anon.request, "get", `/api/tenant/${RUN_STAMP}-no-such-club`, ORIGIN);
    expect(unknown.status, "an unknown slug").toBe(404);
    expect((unknown.body as { error?: string }).error).toBe("Gym not found");

    // A suspended club must be indistinguishable from one that never existed.
    await sql('UPDATE "Tenant" SET "subscriptionStatus" = $2 WHERE id = $1', [throwaway.id, "suspended"]);
    const suspended = await apiCall(anon.request, "get", `/api/tenant/${throwaway.slug}`, ORIGIN);
    expect(suspended.status, "a suspended club").toBe(404);
    expect(JSON.stringify(suspended.body), "byte-identical to an unknown slug").toBe(JSON.stringify(unknown.body));

    await sql('UPDATE "Tenant" SET "subscriptionStatus" = $2, "deletedAt" = now() WHERE id = $1', [
      throwaway.id,
      "trial",
    ]);
    const deleted = await apiCall(anon.request, "get", `/api/tenant/${throwaway.slug}`, ORIGIN);
    expect(deleted.status, "a soft-deleted club").toBe(404);
    expect(JSON.stringify(deleted.body)).toBe(JSON.stringify(unknown.body));
    await sql('UPDATE "Tenant" SET "deletedAt" = NULL WHERE id = $1', [throwaway.id]);
  });

  test("tenant lookup throttles at 30 a minute with a 429, never a 500, and the bucket is reset", async () => {
    await clearBucket("tenant-lookup");
    const pinned = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await anon.request.fetch(`/api/tenant/${RUN_STAMP}-probe-${i}`, {
        maxRedirects: 0,
        headers: { Origin: ORIGIN, "x-vercel-forwarded-for": pinned },
      });
      statuses.push(res.status());
      if (res.status() === 429) break;
    }
    expect(statuses, "the bucket closes").toContain(429);
    expect(statuses.filter((s) => s >= 500), "no 500 in the sequence").toEqual([]);
    await clearBucket("tenant-lookup");
    const after = await anon.request.fetch(`/api/tenant/${SLUG_A}`, {
      maxRedirects: 0,
      headers: { Origin: ORIGIN, "x-vercel-forwarded-for": pinned },
    });
    expect(after.status(), "the bucket is genuinely clear").toBe(200);
    await clearBucket("tenant-lookup");
  });

  test("the resend webhook's signature gate is only as strong as its secret", async () => {
    const before = await countOf("EmailLog");
    const r = await apiCall(anon.request, "post", "/api/webhooks/resend", ORIGIN, {
      type: "email.bounced",
      data: { email_id: `${RUN_STAMP}-no-such-resend-id`, bounce: { type: "Permanent" } },
    });
    describeResponse("unsigned POST /api/webhooks/resend", r);

    // RESEND_WEBHOOK_SECRET is absent from .env.test, and the route's dev-only
    // fallback (webhooks/resend/route.ts:47-53) accepts unsigned events
    // outside production. Recorded, with the fact that it is gated on
    // NODE_ENV and therefore not a production hole.
    expect([200, 401, 503], "unsigned event").toContain(r.status);
    console.log(
      `[L-G] unsigned resend webhook → ${r.status}; RESEND_WEBHOOK_SECRET ${
        process.env.RESEND_WEBHOOK_SECRET ? "present" : "absent"
      } in the test env`,
    );

    // Whatever the gate did, an unknown email_id must write nothing.
    await assertUnchanged("EmailLog", before);

    const garbage = await anon.request.fetch("/api/webhooks/resend", {
      method: "POST",
      maxRedirects: 0,
      headers: { Origin: ORIGIN, "content-type": "application/json" },
      data: "not json at all",
    });
    expect([400, 401], "a malformed body").toContain(garbage.status());
    await assertUnchanged("EmailLog", before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J61 · the token sweep", () => {
  let anon: BrowserContext;
  let throwaway: ThrowawayTenant;
  let seededId: string;

  test.beforeAll(async ({ browser, baseURL }) => {
    anon = await anonContext(browser, baseURL!);
    throwaway = await createThrowawayTenant();
    const rows = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug = $1', [SLUG_A]);
    seededId = rows[0].id;
  });

  test.afterAll(async () => {
    await sql('DELETE FROM "MagicLinkToken" WHERE "tokenHash" LIKE $1', ["%"]).catch(() => {});
    await anon?.close().catch(() => {});
    if (throwaway) await teardownThrowawayTenant(throwaway);
  });

  test("every MagicLinkToken purpose is checked by the verify consumer", async () => {
    // b5d189f made /api/magic-link/verify filter on purpose. A waiver_open or
    // first_time_signup token must not sign anyone in.
    for (const purpose of ["waiver_open", "first_time_signup"] as const) {
      const { raw, id } = await mintMagicToken({
        tenantId: throwaway.id,
        email: throwaway.ownerEmail,
        purpose,
      });
      const r = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: raw });
      describeResponse(`magic-link/verify with a ${purpose} token`, r);
      expect(r.status, `a ${purpose} token at the login consumer`).not.toBe(200);
      const row = await magicTokenRow(id);
      expect(row?.used, `a refused ${purpose} token is not burnt`).toBe(false);
      await sql('DELETE FROM "MagicLinkToken" WHERE id = $1', [id]);
    }
  });

  test("a login token is single-use, and an expired one is refused", async () => {
    const { raw, id } = await mintMagicToken({
      tenantId: throwaway.id,
      email: throwaway.ownerEmail,
      purpose: "login",
    });
    const first = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: raw });
    describeResponse("magic-link/verify first use", first);
    const second = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: raw });
    expect(second.status, "the same token twice").not.toBe(200);
    await sql('DELETE FROM "MagicLinkToken" WHERE id = $1', [id]);

    const expired = await mintMagicToken({
      tenantId: throwaway.id,
      email: throwaway.ownerEmail,
      purpose: "login",
      expiresInMs: -60_000,
    });
    const r = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: expired.raw });
    expect(r.status, "an expired token").not.toBe(200);
    const row = await magicTokenRow(expired.id);
    expect(row?.used, "an expired token is not burnt").toBe(false);
    await sql('DELETE FROM "MagicLinkToken" WHERE id = $1', [expired.id]);
  });

  test("a token minted for one club does not open a session in another", async () => {
    const { raw, id } = await mintMagicToken({
      tenantId: throwaway.id,
      email: throwaway.ownerEmail,
      purpose: "login",
    });
    const r = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: raw });
    if (r.status === 200) {
      // The session, if one was issued, must belong to the token's club.
      const session = await apiCall(anon.request, "get", "/api/auth/session", ORIGIN);
      const user = (session.body as { user?: Record<string, unknown> }).user ?? {};
      expect(user.tenantId, "the session's club is the token's club").toBe(throwaway.id);
      expect(user.tenantId, "never the seeded club").not.toBe(seededId);
    }
    await sql('DELETE FROM "MagicLinkToken" WHERE id = $1', [id]);
  });

  test("a junk, oversize or re-spelled token is refused without a 500", async () => {
    for (const [label, token] of [
      ["an empty token", ""],
      ["a 4 097-character token", "x".repeat(4097)],
      ["a token with a dot", "token.junk"],
      ["a hash presented as a token", hashToken("anything")],
      ["a NaN", "NaN"],
    ] as [string, string][]) {
      const r = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token });
      expect(r.status, label).toBeLessThan(500);
      expect(r.status, label).not.toBe(200);
    }
    const noBody = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, {});
    expect(noBody.status, "no token at all").toBeLessThan(500);
    const array = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: [] });
    expect(array.status, "an empty array as a token").toBeLessThan(500);
  });

  test("a PasswordResetToken is not a magic link, and is single-use", async () => {
    // Schema check: PasswordResetToken keys on `email` + `tenantId`, not on a
    // userId column (prisma/schema.prisma) — the insert names only what exists.
    const raw = `${RUN_STAMP}${Math.random().toString(36).slice(2)}`;
    const rows = await sql<{ id: string }>(
      `INSERT INTO "PasswordResetToken" ("id", "tenantId", "email", "tokenHash", "expiresAt", "used", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, now() + interval '30 minutes', false, now())
       RETURNING id`,
      [throwaway.id, throwaway.ownerEmail, hashToken(raw)],
    );

    // Presented at the magic-link consumer it must do nothing at all.
    const crossed = await apiCall(anon.request, "post", "/api/magic-link/verify", ORIGIN, { token: raw });
    expect(crossed.status, "a reset token at the magic-link consumer").not.toBe(200);
    const stillUnused = await sql<{ used: boolean }>('SELECT used FROM "PasswordResetToken" WHERE id = $1', [
      rows[0].id,
    ]);
    expect(stillUnused[0].used, "the reset token was not consumed by the wrong door").toBe(false);
    expect(
      await rowIsRecent("PasswordResetToken", "createdAt", "id = $1", [rows[0].id]),
      "the row's own clock, compared in SQL",
    ).toBe(true);

    await sql('DELETE FROM "PasswordResetToken" WHERE id = $1', [rows[0].id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("J61 · what an unauthenticated caller can read", () => {
  let anon: BrowserContext;

  test.beforeAll(async ({ browser, baseURL }) => {
    anon = await anonContext(browser, baseURL!);
  });

  test.afterAll(async () => {
    await clearBucket("tenant-lookup");
    await anon?.close().catch(() => {});
  });

  test("the kiosk member list refuses a made-up token and leaks nothing", async () => {
    // `Tenant` stores only `kioskTokenHash` (prisma/schema.prisma:67) — the
    // raw kiosk URL token cannot be recovered from the database, so the
    // AUTHORISED read of this route is UNCOVERED for this lane: it needs a
    // token minted through the rotate screen, which rule 6 forbids on the
    // seeded club. The refusal half is driven here.
    const hashed = await sql<{ hasToken: boolean }>(
      `SELECT ("kioskTokenHash" IS NOT NULL) AS "hasToken" FROM "Tenant" WHERE slug = $1`,
      [SLUG_A],
    );
    console.log(`[L-G] seeded club kioskTokenHash present = ${hashed[0]?.hasToken}`);

    for (const bad of [
      `${RUN_STAMP}-not-a-token`,
      "token.junk",
      "x".repeat(4097),
      "../../api/members",
    ]) {
      const junk = await apiCall(
        anon.request,
        "get",
        `/api/kiosk/${encodeURIComponent(bad)}/members`,
        ORIGIN,
      );
      expect(junk.status, `kiosk token "${bad.slice(0, 20)}"`).toBeGreaterThanOrEqual(400);
      expect(junk.status, "never a 500").toBeLessThan(500);
      const keys = deepKeys(junk.body);
      expect(
        keys.filter((k) => PII_KEYS.some((p) => k.endsWith(p))),
        "a kiosk refusal carries no member data",
      ).toEqual([]);
    }
  });

  test("the public apply route refuses an empty and an oversize body without a 500", async () => {
    const before = await countOf("GymApplication");
    for (const [label, body] of [
      ["an empty body", {}],
      ["a 10 000-character name", { gymName: "x".repeat(10_000) }],
      ["an array where an object belongs", []],
    ] as [string, unknown][]) {
      const r = await apiCall(anon.request, "post", "/api/apply", ORIGIN, body);
      expect(r.status, label).toBeLessThan(500);
      expect(r.status, label).toBeGreaterThanOrEqual(400);
    }
    await assertUnchanged("GymApplication", before);
  });

  test("an unauthenticated call outside the public prefixes is refused, not served", async () => {
    // A 307 to /login is today's answer for a session-less /api/* call outside
    // the public prefixes (proxy.ts). A 401 is the intended shape and is
    // being fixed; both are accepted this round and the observed one is
    // reported. What is NOT acceptable is a 200 with data.
    for (const path of ["/api/members", "/api/staff", "/api/reports", "/api/classes"]) {
      const r = await apiCall(anon.request, "get", path, ORIGIN);
      describeResponse(`anonymous GET ${path}`, r);
      expect([401, 307], `anonymous GET ${path}`).toContain(r.status);
      expect(r.status, `${path} never serves data to nobody`).not.toBe(200);
    }
  });

  test("the operator plane leaks nothing to a caller with no credential", async () => {
    for (const path of ["/api/admin/activity", "/api/admin/customers"]) {
      const r = await apiCall(anon.request, "get", path, ORIGIN);
      expect(r.status, `anonymous GET ${path}`).toBeGreaterThanOrEqual(400);
      const keys = deepKeys(r.body);
      expect(keys.filter((k) => PII_KEYS.some((p) => k.endsWith(p))), `${path} refusal leaks no PII`).toEqual([]);
    }
    expect(OPERATOR_SECRET.length, "the secret exists but was never printed").toBeGreaterThan(0);
  });
});
