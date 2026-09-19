/**
 * Lane L-G — J60: impersonation and its attribution.
 *
 * The question this file exists to answer: when an operator acts AS a gym
 * owner, does the gym's own audit log say so?
 *
 * `lib/audit-log.ts:28-34` writes `metadata.actingAs` only when the CALLER
 * passes `actAsUserId`, and only the `app/api/admin/**` call sites do. Every
 * ordinary tenant route calls `logAudit` without it, so a mutation made during
 * an impersonated session is recorded as the owner's own work. That is the
 * inherited finding; this file measures it rather than assuming it.
 *
 * The target is always a throwaway club this file creates. The seeded club is
 * used only as the source of a real NextAuth session, and nothing in it is
 * mutated.
 */
import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import {
  SLUG_A,
  COACH_A,
  sessionFor,
  closeSessions,
  createThrowawayTenant,
  teardownThrowawayTenant,
  apiCall,
  clearBucket,
  describeResponse,
  type ThrowawayTenant,
} from "./lb-shared";
import {
  OPERATOR_SECRET,
  ADMIN_COOKIE,
  IMPERSONATION_COOKIE,
  SENTINEL_OPERATOR_ID,
  assertAnonymous,
  actingAsCount,
  auditCount,
  sql,
  RUN_STAMP,
} from "./lg-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3847";

test.describe("J60 · impersonation attribution", () => {
  let victim: ThrowawayTenant;
  let ctx: BrowserContext;

  /**
   * A tenant session plus the operator cookie, for the cases that END an
   * impersonation: the stop now discards the session token, so a case that
   * stops must not be sharing its context with the ones that follow.
   *
   * The session is the seeded COACH (coach@totalbjj.com) — a seeded address,
   * never TEST_EMAIL, which names a User row as well as a Member row and would
   * quietly hand back staff. Nothing in the seeded club is written.
   */
  async function freshOperatorSession(browser: Browser, baseURL: string): Promise<BrowserContext> {
    const context = await sessionFor(browser, baseURL, { slug: SLUG_A, email: COACH_A, fresh: true });
    await context.addCookies([
      {
        name: ADMIN_COOKIE,
        value: OPERATOR_SECRET,
        domain: new URL(baseURL).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    return context;
  }

  test.beforeAll(async ({ browser, baseURL }) => {
    test.skip(!OPERATOR_SECRET, "MATFLOW_ADMIN_SECRET absent from .env.test");
    victim = await createThrowawayTenant();

    // A real NextAuth session is required: the impersonation override lives in
    // the jwt() callback (auth.ts:712-762), so it can only swap an identity
    // that already exists. The seeded coach supplies one; nothing in the
    // seeded club is written by this file.
    ctx = await sessionFor(browser, baseURL!, { slug: SLUG_A, email: COACH_A, fresh: true });
    const host = new URL(baseURL!).hostname;
    await ctx.addCookies([
      { name: ADMIN_COOKIE, value: OPERATOR_SECRET, domain: host, path: "/", httpOnly: true, sameSite: "Strict" },
    ]);
    await clearBucket("admin:impersonate");
  });

  test.afterAll(async () => {
    await clearBucket("admin:impersonate");
    await ctx?.close().catch(() => {});
    await closeSessions();
    if (victim) await teardownThrowawayTenant(victim);
  });

  test("starting an impersonation is audited against the target, attributed to the operator", async () => {
    const r = await apiCall(ctx.request, "post", "/api/admin/impersonate", ORIGIN, {
      targetUserId: victim.ownerId,
      reason: "campaign impersonation probe",
    });
    expect(r.status, "start impersonation").toBe(200);
    expect((r.body as { redirectTo?: string }).redirectTo).toBe("/dashboard");

    await expect
      .poll(
        async () =>
          (
            await sql<{ id: string }>(
              `SELECT id FROM "AuditLog" WHERE action = 'admin.impersonate.start' AND "entityId" = $1`,
              [victim.ownerId],
            )
          ).length,
        { timeout: 5000, message: "admin.impersonate.start audit row" },
      )
      .toBeGreaterThan(0);

    const row = await sql<{ userId: string | null; tenantId: string | null; actingAs: string | null }>(
      `SELECT "userId", "tenantId", metadata->>'actingAs' AS "actingAs"
         FROM "AuditLog" WHERE action = 'admin.impersonate.start' AND "entityId" = $1
        ORDER BY "createdAt" DESC LIMIT 1`,
      [victim.ownerId],
    );
    expect(row[0].tenantId, "audited into the TARGET's tenant").toBe(victim.id);
    expect(row[0].userId, "the apparent actor is the target").toBe(victim.ownerId);
    expect(row[0].actingAs, "the real actor is recorded").toBe(SENTINEL_OPERATOR_ID);
  });

  test("a mutation made while impersonating carries no operator attribution — the finding, measured", async ({
    browser,
    baseURL,
  }) => {
    // ARRANGE. Not wrapped in a catch: if impersonation does not start, the
    // measurement below would be meaningless rather than merely absent.
    const start = await apiCall(ctx.request, "post", "/api/admin/impersonate", ORIGIN, {
      targetUserId: victim.ownerId,
      reason: "campaign attribution probe",
    });
    expect(start.status, "impersonation started for the measurement").toBe(200);

    const cookies = await ctx.cookies();
    const impersonating = cookies.find((c) => c.name === IMPERSONATION_COOKIE);
    expect(impersonating, "the impersonation cookie was minted").toBeTruthy();

    // The jwt() callback runs on the next session read. If it does not swap
    // the identity, the dependency is unmet and this is a skip with a reason,
    // never a failure.
    const session = await apiCall(ctx.request, "get", "/api/auth/session", ORIGIN);
    describeResponse("session under impersonation", session);
    const user = (session.body as { user?: Record<string, unknown> }).user ?? {};
    test.skip(
      user.impersonatedBy === undefined,
      "the JWT did not adopt the impersonation claim in this context — attribution cannot be measured without it",
    );
    expect(user.impersonatedBy, "the session names the real actor").toBe(SENTINEL_OPERATOR_ID);
    expect(user.tenantId, "the session moved to the target's club").toBe(victim.id);

    // ACT — three ordinary tenant mutations as the impersonated owner.
    const before = await auditCount(victim.id);
    const beforeAttributed = await actingAsCount(victim.id);

    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      // `name`, one field — lib/schemas/member.ts:34. Round 2 sent
      // firstName/lastName, every call was a 400 and the measurement skipped
      // itself: three refusals write no audit rows, so there was nothing to
      // attribute and the finding went unmeasured rather than proven.
      const res = await apiCall(ctx.request, "post", "/api/members", ORIGIN, {
        name: `Campaign Impersonated ${i} ${RUN_STAMP}`,
        email: `${RUN_STAMP}-imp-${i}@example.test`,
        membershipType: "adult",
      });
      if (res.status === 200 || res.status === 201) {
        const id = (res.body as { id?: string; member?: { id?: string } }).id ??
          (res.body as { member?: { id?: string } }).member?.id;
        if (id) created.push(id);
      } else {
        describeResponse(`impersonated POST /api/members #${i}`, res);
      }
    }
    test.skip(created.length === 0, "no ordinary tenant mutation succeeded under impersonation — nothing to attribute");

    await expect
      .poll(async () => auditCount(victim.id), {
        timeout: 8000,
        message: "audit rows for the impersonated mutations",
      })
      .toBeGreaterThan(before);

    const afterAttributed = await actingAsCount(victim.id);
    const newRows = (await auditCount(victim.id)) - before;
    const newlyAttributed = afterAttributed - beforeAttributed;
    console.log(
      `[L-G finding] ${newRows} audit rows written under impersonation; ${newlyAttributed} carry metadata.actingAs`,
    );

    // The assertion states the product's contract, not today's behaviour: a
    // gym owner reading their own log must be able to see that the platform
    // acted on their behalf. Expected to fail until logAudit reads the
    // impersonation claim itself (lib/audit-log.ts:28).
    expect(
      newlyAttributed,
      "every audit row written during an impersonated session names the real actor",
    ).toBe(newRows);

    // Teardown of the rows this case created.
    for (const id of created) {
      await sql('DELETE FROM "AuditLog" WHERE "entityId" = $1', [id]).catch(() => {});
      await sql('DELETE FROM "Member" WHERE id = $1', [id]).catch(() => {});
    }
    void browser;
    void baseURL;
  });

  test("stopping impersonation returns the context and is audited", async ({ browser, baseURL }) => {
    // A context of this case's own: stopping now discards the session cookie
    // (impersonate/route.ts DELETE), because the identity swap is written into
    // the JWT in place and nothing can restore the operator's own claims from
    // it. Sharing `ctx` would leave the later cases session-less.
    const own = await freshOperatorSession(browser, baseURL!);
    try {
      const start = await apiCall(own.request, "post", "/api/admin/impersonate", ORIGIN, {
        targetUserId: victim.ownerId,
        reason: "campaign stop probe",
      });
      expect(start.status).toBe(200);

      const stop = await apiCall(own.request, "delete", "/api/admin/impersonate", ORIGIN);
      expect(stop.status, "stop impersonation").toBe(200);
      expect((stop.body as { redirectTo?: string }).redirectTo).toBe("/admin/tenants");

      const cookies = await own.cookies();
      expect(
        cookies.find((c) => c.name === IMPERSONATION_COOKIE && c.value !== "")?.value,
        "the impersonation cookie is gone",
      ).toBeUndefined();

      await expect
        .poll(
          async () =>
            (
              await sql<{ id: string }>(
                `SELECT id FROM "AuditLog" WHERE action = 'admin.impersonate.end' AND "entityId" = $1`,
                [victim.ownerId],
              )
            ).length,
          { timeout: 5000, message: "admin.impersonate.end audit row" },
        )
        .toBeGreaterThan(0);

      // The context really is returned — no impersonation claim, and no
      // borrowed identity either. Round 2 measured the opposite: the claim and
      // the target's tenant both survived a successful stop, because the jwt()
      // callback overwrites the token in place (auth.ts:744-764) and nothing
      // puts it back. The stop now discards the token instead.
      const session = await apiCall(own.request, "get", "/api/auth/session", ORIGIN);
      const user = (session.body as { user?: Record<string, unknown> }).user ?? {};
      expect(user.impersonatedBy, "the claim is gone from the session").toBeUndefined();
      expect(user.tenantId, "and the target's club is gone with it").not.toBe(victim.id);
    } finally {
      await own.close().catch(() => {});
    }
  });

  test("a sessionVersion bump evicts an impersonated JWT", async ({ browser, baseURL }) => {
    const own = await freshOperatorSession(browser, baseURL!);
    try {
      const start = await apiCall(own.request, "post", "/api/admin/impersonate", ORIGIN, {
        targetUserId: victim.ownerId,
        reason: "campaign eviction probe",
      });
      expect(start.status).toBe(200);

      const before = await apiCall(own.request, "get", "/api/auth/session", ORIGIN);
      const beforeUser = (before.body as { user?: Record<string, unknown> }).user ?? {};
      test.skip(
        beforeUser.impersonatedBy === undefined,
        "the JWT did not adopt the impersonation claim — eviction cannot be measured",
      );

      // ARRANGE: bump the TARGET's sessionVersion — a throwaway owner, never a
      // seeded user (rule 6).
      await sql('UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE id = $1', [victim.ownerId]);

      const after = await apiCall(own.request, "get", "/api/auth/session", ORIGIN);
      describeResponse("session after a sessionVersion bump on the impersonated user", after);
      const afterUser = (after.body as { user?: Record<string, unknown> }).user ?? {};
      // FOR THE CONTROLLER — expected to fail, and left failing on purpose.
      // auth.ts:753 re-reads the target's sessionVersion from the database on
      // every request and writes it onto the token, immediately before the
      // revocation check compares the two. They can never differ, so the one
      // mechanism that can take access away from a live session does not work
      // while that session is impersonated — against the stated intent of the
      // block's own comment (auth.ts:719-723, "if the target gets disowned
      // mid-session, the impersonation dies"). auth.ts is not this lane's file.
      expect(
        afterUser.tenantId,
        "a sessionVersion bump on the impersonated user ends the impersonation",
      ).not.toBe(victim.id);

      await apiCall(own.request, "delete", "/api/admin/impersonate", ORIGIN).catch(() => {});
    } finally {
      await own.close().catch(() => {});
    }
  });

  test("impersonation refuses an unknown target and writes nothing", async () => {
    const before = await auditCount(victim.id);
    const r = await apiCall(ctx.request, "post", "/api/admin/impersonate", ORIGIN, {
      targetUserId: `${RUN_STAMP}-no-such-user`,
      reason: "campaign unknown-target probe",
    });
    expect(r.status, "an unknown target").toBe(404);
    expect((r.body as { error?: string }).error).toBe("Target user not found");
    expect(await auditCount(victim.id), "nothing audited for a refused impersonation").toBe(before);

    const short = await apiCall(ctx.request, "post", "/api/admin/impersonate", ORIGIN, {
      targetUserId: victim.ownerId,
      reason: "no",
    });
    expect(short.status, "a four-character reason").toBe(400);
    expect((short.body as { error?: string }).error).toBe("Invalid data");
  });

  test("DELETE /api/admin/impersonate refuses a caller with no credential at all", async ({ browser, baseURL }) => {
    // Round 2, from lane L-B: this door answered 200 { ok: true } to a tenant
    // owner — and to anyone else, since it checked nothing. Nothing was ever
    // written for them, but a route on the operator plane that says yes to a
    // stranger is a map of the plane handed out for free. The gate is now the
    // wider of the two credentials that could legitimately end an
    // impersonation: the impersonation cookie itself, or the operator
    // credential. Neither → 403.
    const bare = await browser.newContext({ baseURL, storageState: undefined });
    await bare.clearCookies();
    try {
      await assertAnonymous(bare, "the credential-less stop");
      const r = await apiCall(bare.request, "delete", "/api/admin/impersonate", ORIGIN);
      expect(r.status, "ending an impersonation nobody has").toBe(403);
      expect((r.body as { error?: string }).error).toBe("Forbidden");
    } finally {
      await bare.close().catch(() => {});
    }

    // The fail-safe half survives: an operator with nothing in flight may
    // still call it and get a clean answer.
    const op = await browser.newContext({ baseURL, storageState: undefined });
    try {
      await op.addCookies([
        {
          name: ADMIN_COOKIE,
          value: OPERATOR_SECRET,
          domain: new URL(baseURL!).hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Strict",
        },
      ]);
      const r = await apiCall(op.request, "delete", "/api/admin/impersonate", ORIGIN);
      expect(r.status, "an operator stopping nothing").toBe(200);
      expect((r.body as { ok?: boolean }).ok).toBe(true);
    } finally {
      await op.close().catch(() => {});
    }
  });
});
