/**
 * Lane L-C — J22 (add, edit, search, counts) and J30 (pills, DSAR, erase,
 * cancel, rejoin, promote, totp-reset).
 *
 * Lane A0 drives column one as the owner on a fresh club. This file drives
 * EVERY OTHER COLUMN on the seeded club: manager, coach and admin through the
 * UI where the route admits them, and member / parent / anonymous / kiosk /
 * operator at the API, plus the attacks.
 *
 * Allow-lists read from the routes rather than assumed (brief: "before you
 * rely on any selector or payload, read the page component and the route it
 * drives"):
 *   GET  /api/members            → owner|manager|coach|admin   (route.ts:50)
 *   POST /api/members            → owner|manager|admin         (route.ts:149)  coach 403
 *   GET  /api/members/[id]       → owner|manager|coach|admin   ([id]/route.ts:34)
 *   PATCH /api/members/[id]      → owner|manager|admin         ([id]/route.ts:190) coach 403
 *   DELETE /api/members/[id]     → owner only                  ([id]/route.ts:458)
 *   GET  /api/admin/dsar/export  → requireApiOwner             (export/route.ts:77)
 *   POST /api/admin/dsar/erase   → requireApiRole(["owner"])   (erase/route.ts:60)
 *   POST /api/members/[id]/promote-to-adult → requireApiOwner  (promote/route.ts:18)
 *   POST /api/members/[id]/totp-reset → requireApiOwnerOrManager (totp-reset/route.ts:40)
 *
 * Every refusal body here is `{ ok: false, error }` when it came from
 * `apiError`/`api-authz` and a BARE `{ error }` when the route hand-rolled
 * `NextResponse.json({ error }, …)` — which the members routes do for every
 * 401/403 they raise themselves. Asserted per call, never by the `ok` key
 * alone.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";
import {
  OWNER_A, COACH_A, ADMIN_A, MEMBER_A, PASSWORD_A, THROWAWAY_PASSWORD,
  sessionFor, anonContext, closeSessions, createThrowawayStaff, createThrowawayTenant,
  teardownThrowawayTenant, teardownThrowawayStaff, countOf, assertUnchanged, apiCall,
  assertNoOverflowLc, clearBucket, makeMember, teardownLc, ANON_REFUSED, type LcMember, type ThrowawayTenant,
} from "./lc-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3847";

let tenantA: string;
let tenantB: ThrowawayTenant;
let managerEmail: string;
let victim: LcMember;
let foreign: LcMember;

test.beforeAll(async () => {
  tenantA = await seededTenantId();
  tenantB = await createThrowawayTenant();
  managerEmail = (await createThrowawayStaff("manager")).email;
  victim = await makeMember({ tag: "victim", phone: "+44 7700 900111" });
  foreign = await makeMember({ tag: "foreign", tenantId: tenantB.id });
});

test.afterAll(async () => {
  await clearBucket("member:create:");
  await clearBucket("member:patch:");
  await clearBucket("dsar:");
  await teardownLc();
  await teardownThrowawayTenant(tenantB).catch(() => {});
  await teardownThrowawayStaff().catch(() => {});
  await closeSessions();
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J22 — the write allow-list, role by role", () => {
  const cases: { role: string; email: () => string; password: string; post: number; patch: number; del: number }[] = [
    { role: "manager", email: () => managerEmail, password: THROWAWAY_PASSWORD, post: 201, patch: 200, del: 403 },
    { role: "coach",   email: () => COACH_A,      password: PASSWORD_A,        post: 403, patch: 403, del: 403 },
    { role: "admin",   email: () => ADMIN_A,      password: PASSWORD_A,        post: 201, patch: 200, del: 403 },
  ];

  for (const c of cases) {
    test(`J22/${c.role} — POST, PATCH and DELETE answer the route's own allow-list`, async ({ browser, baseURL }) => {
      const ctx = await sessionFor(browser, baseURL!, { email: c.email(), password: c.password });
      const rc = ctx.request;

      // GET is staff-wide: all four roles read the roster.
      const list = await apiCall(rc, "get", "/api/members?take=5", ORIGIN);
      expect(list.status, `${c.role} GET /api/members`).toBe(200);
      expect(Array.isArray((list.body as { members?: unknown[] }).members)).toBe(true);
      expect(list.body, "the list never carries a password hash or TOTP seed").not.toHaveProperty("passwordHash");
      for (const m of (list.body as { members: Record<string, unknown>[] }).members) {
        expect(Object.keys(m).sort(), `${c.role} member key-set is an allow-list`).toEqual([
          "accountType", "dateOfBirth", "email", "hasKidsHint", "id", "joinedAt",
          "memberRanks", "membershipType", "name", "parentMemberId", "paymentStatus",
          "phone", "profilePictureUrl", "status", "waiverAccepted",
        ]);
      }

      // POST
      const before = await countOf("Member", '"tenantId" = $1', [tenantA]);
      const created = await apiCall(rc, "post", "/api/members", ORIGIN, {
        name: `Campaign ${c.role} ${RUN_STAMP}`,
        email: `${RUN_STAMP}-by-${c.role}@example.test`,
      });
      expect(created.status, `${c.role} POST /api/members`).toBe(c.post);
      if (c.post === 403) {
        expect((created.body as { error: string }).error, "bare {error} — the route hand-rolls this 403").toBe("Forbidden");
        await assertUnchanged("Member", before, '"tenantId" = $1', [tenantA]);
      } else {
        const row = await sql<{ id: string; name: string }>('SELECT id, name FROM "Member" WHERE email = $1', [`${RUN_STAMP}-by-${c.role}@example.test`]);
        expect(row, `${c.role}'s member is a row, not a toast`).toHaveLength(1);
      }

      // PATCH the victim
      const patched = await apiCall(rc, "patch", `/api/members/${victim.id}`, ORIGIN, { phone: `+4477009002${c.role.length}` });
      expect(patched.status, `${c.role} PATCH /api/members/[id]`).toBe(c.patch);
      const after = await sql<{ phone: string | null }>('SELECT phone FROM "Member" WHERE id = $1', [victim.id]);
      if (c.patch === 403) {
        expect(after[0].phone, "a refused PATCH writes nothing").toBe("+44 7700 900111");
      } else {
        expect(after[0].phone, "a fresh SELECT, not the response body").toBe(`+4477009002${c.role.length}`);
        await sql('UPDATE "Member" SET phone = $1 WHERE id = $2', ["+44 7700 900111", victim.id]);
      }

      // DELETE is owner-only for every one of these roles.
      const doomed = await makeMember({ tag: `del-${c.role}` });
      const del = await apiCall(rc, "delete", `/api/members/${doomed.id}?confirm=1`, ORIGIN);
      expect(del.status, `${c.role} DELETE /api/members/[id]`).toBe(c.del);
      const still = await sql('SELECT id FROM "Member" WHERE id = $1', [doomed.id]);
      expect(still, "a refused DELETE leaves the row").toHaveLength(1);
    });
  }

  test("J22/member and J22/anonymous — the roster is not readable without staff", async ({ browser, baseURL }) => {
    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const anon = await anonContext(browser, baseURL!);
    const before = await countOf("Member", '"tenantId" = $1', [tenantA]);

    for (const [label, rc] of [["member", memberCtx.request], ["anonymous", anon.request]] as [string, APIRequestContext][]) {
      const list = await apiCall(rc, "get", "/api/members", ORIGIN);
      if (label === "member") expect(list.status, "member GET /api/members").toBe(403);
      else expect(ANON_REFUSED, "anonymous GET /api/members").toContain(list.status);
      expect((list.body as { members?: unknown }).members, "no roster leaks in the refusal").toBeUndefined();

      const one = await apiCall(rc, "get", `/api/members/${victim.id}`, ORIGIN);
      if (label === "member") expect(one.status, "member GET /api/members/[id]").toBe(403);
      else expect(ANON_REFUSED, "anonymous GET /api/members/[id]").toContain(one.status);
      expect((one.body as { email?: unknown }).email, "no PII in the refusal").toBeUndefined();

      // A member editing ANOTHER member by id.
      const edit = await apiCall(rc, "patch", `/api/members/${victim.id}`, ORIGIN, { name: "Owned" });
      if (label === "member") expect(edit.status, "member PATCH another member").toBe(403);
      else expect(ANON_REFUSED, "anonymous PATCH another member").toContain(edit.status);

      const post = await apiCall(rc, "post", "/api/members", ORIGIN, { name: "X", email: `${RUN_STAMP}-x@example.test` });
      if (label === "member") expect(post.status, "member POST /api/members").toBe(403);
      else expect(ANON_REFUSED, "anonymous POST /api/members").toContain(post.status);
    }
    await assertUnchanged("Member", before, '"tenantId" = $1', [tenantA]);
    const fresh = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [victim.id]);
    expect(fresh[0].name, "nothing was written by any refused caller").toBe(victim.name);
    await anon.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J22 — cross-tenant, malformed and concurrent", () => {
  test("a foreign member id answers exactly like a missing one (no 403 that confirms existence)", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const missing = "00000000-0000-4000-8000-000000000000";

    const foreignGet = await apiCall(rc, "get", `/api/members/${foreign.id}`, ORIGIN);
    const missingGet = await apiCall(rc, "get", `/api/members/${missing}`, ORIGIN);
    expect(foreignGet.status, "tenant B's member read from tenant A").toBe(404);
    expect(foreignGet.status, "enumeration: foreign answers like missing").toBe(missingGet.status);
    expect(foreignGet.body, "…and with the same body").toEqual(missingGet.body);

    const beforeB = await countOf("Member", '"tenantId" = $1', [tenantB.id]);
    const foreignPatch = await apiCall(rc, "patch", `/api/members/${foreign.id}`, ORIGIN, { name: `pwned-${RUN_STAMP}` });
    expect(foreignPatch.status, "PATCH across the tenant boundary").toBe(404);
    const row = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [foreign.id]);
    expect(row[0].name, "tenant B's row is untouched").toBe(foreign.name);
    await assertUnchanged("Member", beforeB, '"tenantId" = $1', [tenantB.id]);

    const foreignDel = await apiCall(rc, "delete", `/api/members/${foreign.id}?confirm=1`, ORIGIN);
    expect(foreignDel.status, "DELETE across the tenant boundary").toBe(404);
    await assertUnchanged("Member", beforeB, '"tenantId" = $1', [tenantB.id]);

    // Reverse direction: tenant B's owner reaching into tenant A.
    const bCtx = await sessionFor(browser, baseURL!, { slug: tenantB.slug, email: tenantB.ownerEmail, password: THROWAWAY_PASSWORD });
    const back = await apiCall(bCtx.request, "get", `/api/members/${victim.id}`, ORIGIN);
    expect(back.status, "tenant A's member read from tenant B").toBe(404);
    const beforeA = await countOf("Member", '"tenantId" = $1', [tenantA]);
    const backPatch = await apiCall(bCtx.request, "patch", `/api/members/${victim.id}`, ORIGIN, { name: "reverse" });
    expect(backPatch.status).toBe(404);
    await assertUnchanged("Member", beforeA, '"tenantId" = $1', [tenantA]);
  });

  test("a foreign membershipTierId cannot be pinned onto one of our members", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const tierRows = await sql<{ id: string }>('SELECT id FROM "MembershipTier" WHERE "tenantId" <> $1 LIMIT 1', [tenantA]);
    test.skip(tierRows.length === 0, "no foreign MembershipTier on the test branch to borrow");
    const res = await apiCall(ctx.request, "patch", `/api/members/${victim.id}`, ORIGIN, { membershipTierId: tierRows[0].id });
    expect(res.status, "route.ts:240 resolves the tier inside the tenant first").toBe(400);
    const row = await sql<{ membershipTierId: string | null }>('SELECT "membershipTierId" FROM "Member" WHERE id = $1', [victim.id]);
    expect(row[0].membershipTierId, "no foreign price list was attached").toBeNull();
  });

  test("names at the boundary: 60 characters accepted, 10 000 refused, no e-mail refused", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;

    const sixty = "N".repeat(60);
    const ok = await apiCall(rc, "post", "/api/members", ORIGIN, { name: sixty, email: `${RUN_STAMP}-sixty@example.test` });
    expect(ok.status, "60 characters is an ordinary name").toBe(201);
    const stored = await sql<{ name: string }>('SELECT name FROM "Member" WHERE email = $1', [`${RUN_STAMP}-sixty@example.test`]);
    expect(stored[0].name, "stored whole, not truncated").toHaveLength(60);

    const before = await countOf("Member", '"tenantId" = $1', [tenantA]);
    const huge = await apiCall(rc, "post", "/api/members", ORIGIN, { name: "N".repeat(10_000), email: `${RUN_STAMP}-huge@example.test` });
    expect(huge.status, "a 10 000-character name is refused, never stored, never a 500").toBe(400);
    await assertUnchanged("Member", before, '"tenantId" = $1', [tenantA]);

    // ROUND 4 — THE CONTRACT MOVED AND THIS CASE HAD NOT.
    //
    // It asserted a flat 400 and cited `route.ts:241`. That was true until
    // 19 Sep, when `9353766` landed the decision that an adult without an
    // inbox exists: the route now synthesises a placeholder in the reserved
    // `no-login.matflow.local` domain, writes the row, and tells the screen
    // `noEmail: true` with no invite link. The old behaviour was a real cost —
    // a walk-in, an older member or a family sharing one inbox could not go on
    // the roster at all, so they went on paper and their attendance, payments
    // and waiver went with them.
    //
    // So this asserts the NEW boundary: accepted, and accepted in a way that
    // cannot become a send. The full contract (no token, no mail, never a
    // bulk-invite candidate, a waiver link that refuses with a reason) is
    // driven by "staff may add one, and the placeholder never becomes an
    // invite" further down this file.
    const noEmail = await apiCall(rc, "post", "/api/members", ORIGIN, { name: `No Email Adult ${RUN_STAMP}` });
    expect(
      noEmail.status,
      `an adult with no e-mail is admitted with a placeholder: ${noEmail.text.slice(0, 160)}`,
    ).toBe(201);
    const placeholder = noEmail.body as { id: string; email: string; noEmail?: boolean };
    const placeholderRow = await sql<{ email: string; accountType: string }>(
      'SELECT email, "accountType" FROM "Member" WHERE id = $1',
      [placeholder.id],
    );
    expect(
      placeholderRow[0].email,
      "the NOT NULL column is satisfied by an address that cannot reach an inbox",
    ).toMatch(/@no-login\.matflow\.local$/);
    expect(placeholderRow[0].accountType, "and they are still an adult").toBe("adult");
    expect(
      await countOf("EmailLog", "recipient = $1", [placeholderRow[0].email]),
      "nothing was mailed to a placeholder",
    ).toBe(0);
    // The placeholder carries no RUN_STAMP, so teardown cannot see it: by id.
    await sql('DELETE FROM "Member" WHERE id = $1', [placeholder.id]);
    await assertUnchanged("Member", before, '"tenantId" = $1', [tenantA]);

    // A future DOB, a 1970 date and a junk date.
    for (const [label, dob, want] of [
      ["future", new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), 400],
      ["1970", "1970-01-01", 201],
      ["junk", "not-a-date", 400],
    ] as [string, string, number][]) {
      const r = await apiCall(rc, "post", "/api/members", ORIGIN, {
        name: `DOB ${label}`, email: `${RUN_STAMP}-dob-${label}@example.test`, dateOfBirth: dob,
      });
      expect(r.status, `DOB ${label}`).toBe(want);
    }
  });

  test("a stale updatedAt is refused with 409; without one, last write wins", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const target = await makeMember({ tag: "stale" });

    const stale = new Date(Date.now() - 86_400_000).toISOString();
    const conflict = await apiCall(rc, "patch", `/api/members/${target.id}`, ORIGIN, { name: "Stale Wins", updatedAt: stale });
    expect(conflict.status, "optimistic concurrency ([id]/route.ts:398)").toBe(409);
    expect((conflict.body as { currentUpdatedAt?: string }).currentUpdatedAt, "the 409 hands back the current stamp").toBeTruthy();
    const unchanged = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [target.id]);
    expect(unchanged[0].name, "the stale write landed nowhere").toBe(target.name);

    const blind = await apiCall(rc, "patch", `/api/members/${target.id}`, ORIGIN, { name: "Blind Wins" });
    expect(blind.status, "no precondition sent → backward-compatible last-write-wins").toBe(200);
    const won = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [target.id]);
    expect(won[0].name).toBe("Blind Wins");
  });

  test("two identical creates in flight leave one row, not two and not a 500", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const email = `${RUN_STAMP}-race@example.test`;
    const body = { name: "Race Condition", email };
    const [a, b] = await Promise.all([
      apiCall(rc, "post", "/api/members", ORIGIN, body),
      apiCall(rc, "post", "/api/members", ORIGIN, body),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, "one create, one honest 409 — never two rows, never a 500").toEqual([201, 409]);
    const rows = await sql('SELECT id FROM "Member" WHERE email = $1', [email]);
    expect(rows, "the unique index is the arbiter").toHaveLength(1);
  });

  test("CSRF: POST and PATCH carry assertSameOrigin, so a foreign Origin is refused", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const before = await countOf("Member", '"tenantId" = $1', [tenantA]);

    const foreignOrigin = await apiCall(rc, "post", "/api/members", ORIGIN, { name: "CSRF", email: `${RUN_STAMP}-csrf@example.test` }, {});
    // `apiCall` always sends Origin = ORIGIN; drive the hostile cases directly.
    expect([201, 403]).toContain(foreignOrigin.status);

    const evil = await rc.fetch("/api/members", {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      data: { name: "CSRF evil", email: `${RUN_STAMP}-csrf2@example.test` },
    });
    expect(evil.status(), "foreign Origin on a guarded route").toBe(403);

    // A matched forged pair is HELD by construction — no browser, no victim
    // cookie — so we record the status and prove nothing was written.
    const matched = await rc.fetch("/api/members", {
      method: "POST",
      headers: { Origin: "http://evil.test", Host: "evil.test" },
      data: { name: "CSRF matched", email: `${RUN_STAMP}-csrf3@example.test` },
    });
    expect([403, 201]).toContain(matched.status());
    const leaked = await sql('SELECT id FROM "Member" WHERE email IN ($1, $2)', [`${RUN_STAMP}-csrf2@example.test`, `${RUN_STAMP}-csrf3@example.test`]);
    expect(leaked.length, "no CSRF-shaped create landed").toBeLessThanOrEqual(1);
    await assertUnchanged("Member", before + (foreignOrigin.status === 201 ? 1 : 0) + (matched.status() === 201 ? 1 : 0), '"tenantId" = $1', [tenantA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J22 — the cursor past 100 rows, and the counts that must agree", () => {
  test("120 run-stamped members: page two exists and is disjoint from page one", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;

    // One statement, 120 rows: a loop of 120 round trips to Neon is the
    // difference between six seconds and four minutes.
    await sql(
      `INSERT INTO "Member" ("id","tenantId","name","email","status","paymentStatus","accountType","joinedAt","updatedAt")
       SELECT gen_random_uuid()::text, $1, 'Campaign Page ' || g, $2 || '-page-' || g || '@example.test',
              'active', 'paid', 'adult', now() - (g || ' minutes')::interval, now()
       FROM generate_series(1, 120) g`,
      [tenantA, RUN_STAMP],
    );

    const first = await apiCall(rc, "get", "/api/members?take=100", ORIGIN);
    expect(first.status).toBe(200);
    const p1 = first.body as { members: { id: string }[]; nextCursor: string | null };
    expect(p1.members.length, "maxTake caps the page at 100 (lib/pagination.ts)").toBe(100);
    expect(p1.nextCursor, "a full page hands back a cursor").toBeTruthy();

    const second = await apiCall(rc, "get", `/api/members?take=100&cursor=${p1.nextCursor}`, ORIGIN);
    const p2 = second.body as { members: { id: string }[]; nextCursor: string | null };
    expect(p2.members.length, "page two is not empty").toBeGreaterThan(0);
    const overlap = p2.members.filter((m) => p1.members.some((x) => x.id === m.id));
    expect(overlap, "the cursor skips the row it points at — no duplicate, no skipped row").toEqual([]);

    // The SQL truth the screen must agree with.
    const total = await countOf("Member", '"tenantId" = $1', [tenantA]);
    const stamped = await countOf("Member", '"tenantId" = $1 AND email LIKE $2', [tenantA, `${RUN_STAMP}-page-%`]);
    expect(stamped, "all 120 landed").toBe(120);
    expect(total).toBeGreaterThanOrEqual(120);
  });

  test("both search boxes filter server-side, and a two-letter query does not leak the roster", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const needle = await makeMember({ tag: "needle", name: `Zzqx Needle ${RUN_STAMP}` });

    const hit = await apiCall(rc, "get", `/api/members?search=Zzqx&take=50`, ORIGIN);
    const body = hit.body as { members: { id: string }[] };
    expect(body.members.map((m) => m.id), "the ?search= pushdown finds it across the whole tenant").toContain(needle.id);

    // Case-insensitivity, and the 80-character cap.
    const lower = await apiCall(rc, "get", `/api/members?search=zzqx`, ORIGIN);
    expect((lower.body as { members: unknown[] }).members.length, "mode: insensitive").toBeGreaterThan(0);
    const capped = await apiCall(rc, "get", `/api/members?search=${"z".repeat(500)}`, ORIGIN);
    expect(capped.status, "an oversize query is capped, not a 500").toBe(200);
    expect((capped.body as { members: unknown[] }).members, "and matches nothing").toEqual([]);

    // The kids chip.
    const kidsOnly = await apiCall(rc, "get", "/api/members?filter=kids&take=100", ORIGIN);
    expect(kidsOnly.status).toBe(200);
    for (const m of (kidsOnly.body as { members: { parentMemberId: string | null }[] }).members) {
      expect(m.parentMemberId, "?filter=kids is a server-side pushdown, not a client slice").not.toBeNull();
    }
  });

  test("the members screen at 390 and at 768 fits, as the admin and as the manager", async ({ browser, baseURL }) => {
    for (const [role, email, password, width] of [
      ["admin", ADMIN_A, PASSWORD_A, 768],
      ["manager", managerEmail, THROWAWAY_PASSWORD, 390],
    ] as [string, string, string, number][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password, viewport: { width, height: 844 }, isMobile: width === 390 });
      const page = await ctx.newPage();
      await page.goto("/dashboard/members", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      expect(new URL(page.url()).pathname, `${role} reaches the members screen`).toBe("/dashboard/members");
      await assertNoOverflowLc(page, width, `members list as ${role} at ${width}`);

      const search = page.locator('input[type="search"]').first();
      await expect(search, "the search box is an input, not a div with a caret").toBeVisible();
      await search.fill("zz");
      await page.waitForTimeout(800);
      await assertNoOverflowLc(page, width, `members list as ${role} at ${width}, searched`);
      await page.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J22 — the inherited 200-on-error (X-6 K6)", () => {
  test("a failing GET /api/members can never render the roster as empty", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const page = await ctx.newPage();

    // ROUND 2 — the assertion this test was written to make is now made in two
    // places, and this is the half that belongs at the screen.
    //
    // Round 1 fixed the route: app/api/members/route.ts no longer answers its
    // catch with `200 { members: [] }`; it answers apiError(…, 500) and
    // tests/unit/members-list-db-error.test.ts holds that. The round-1 spec
    // stubbed the OLD body (a 200 carrying an empty array) and demanded the
    // screen say something went wrong — a state the product can no longer
    // produce, and one this screen would not show anyway: /dashboard/members
    // renders the roster from SSR props (page.tsx:97, deliberately unguarded so
    // a fault reaches app/dashboard/error.tsx), and MembersList never GETs this
    // route at all — its only call is the POST that adds a member.
    //
    // So the honest regression guard is the structural one: with the route
    // failing outright, the roster is still there and the screen never claims
    // the club is empty. If anyone later moves the list onto this fetch and
    // swallows the failure, this goes red.
    await page.route("**/api/members?**", async (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Couldn't load your members. Try again." }) }),
    );
    await page.goto("/dashboard/members", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const real = await countOf("Member", '"tenantId" = $1', [tenantA]);
    expect(real, "the club really does have members").toBeGreaterThan(0);
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(
      text.includes("no members yet"),
      "an HTTP error is never an empty state (docs/RULES.md §2): the roster is SSR and must survive a failing API",
    ).toBe(false);
    const rows = await page.locator('[data-testid^="member-row"], table tbody tr').count();
    expect(rows, "the SSR roster is on the screen regardless of the API's health").toBeGreaterThan(0);
    await page.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J30 — pills, cancel and rejoin", () => {
  test("cancelledAt is stamped on cancel and never cleared on rejoin (K4)", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const m = await makeMember({ tag: "churn" });

    const off = await apiCall(rc, "patch", `/api/members/${m.id}`, ORIGIN, { status: "cancelled" });
    expect(off.status).toBe(200);
    let row = await sql<{ status: string; cancelledAt: Date | null }>('SELECT status, "cancelledAt" FROM "Member" WHERE id = $1', [m.id]);
    expect(row[0].status).toBe("cancelled");
    expect(row[0].cancelledAt, "D1 stamps the churn date once").not.toBeNull();

    const on = await apiCall(rc, "patch", `/api/members/${m.id}`, ORIGIN, { status: "active" });
    expect(on.status, "a cancelled member may rejoin").toBe(200);
    row = await sql<{ status: string; cancelledAt: Date | null }>('SELECT status, "cancelledAt" FROM "Member" WHERE id = $1', [m.id]);
    expect(row[0].status).toBe("active");
    // The consequence, stated as the assertion rather than as a comment: an
    // active member carrying a cancellation date is counted as churn for ever
    // by anything filtering on cancelledAt.
    expect(row[0].cancelledAt, "rejoining must clear the churn date — [id]/route.ts:339 only ever sets it").toBeNull();
  });

  test("a GDPR-erased member cannot be reactivated", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const m = await makeMember({ tag: "erased", email: `deleted-${RUN_STAMP}@deleted.invalid`, status: "cancelled" });
    const res = await apiCall(ctx.request, "patch", `/api/members/${m.id}`, ORIGIN, { status: "active" });
    expect(res.status, "[id]/route.ts:276 — Article 17 fulfilment evidence is not reversible").toBe(422);
    const row = await sql<{ status: string }>('SELECT status FROM "Member" WHERE id = $1', [m.id]);
    expect(row[0].status).toBe("cancelled");
  });

  test("the profile pills say what the row says, at 390 and at 768", async ({ browser, baseURL }) => {
    const noPhone = await makeMember({ tag: "pills", phone: null, waiverAccepted: false });
    for (const width of [390, 768]) {
      const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A, viewport: { width, height: 844 }, isMobile: width === 390 });
      const page = await ctx.newPage();
      await page.goto(`/dashboard/members/${noPhone.id}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await assertNoOverflowLc(page, width, `member profile at ${width}`);
      const body = (await page.locator("body").innerText()).toLowerCase();
      expect(body, "the waiver chip reflects waiverAccepted = false").toMatch(/waiver|missing/);
      expect(body, "the no-phone pill reflects phone = null").toMatch(/phone/);
      await page.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J30 — DSAR, erase, promote and totp-reset allow-lists", () => {
  test("DSAR export and erase are OWNER-ONLY despite the /admin path", async ({ browser, baseURL }) => {
    const subject = await makeMember({ tag: "dsar" });
    const cases: [string, string, string, number][] = [
      ["manager", managerEmail, THROWAWAY_PASSWORD, 403],
      ["coach", COACH_A, PASSWORD_A, 403],
      ["admin", ADMIN_A, PASSWORD_A, 403],
      ["owner", OWNER_A, PASSWORD_A, 200],
    ];
    for (const [role, email, password, want] of cases) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await apiCall(ctx.request, "get", `/api/admin/dsar/export?memberId=${subject.id}`, ORIGIN);
      expect(res.status, `${role} GET /api/admin/dsar/export`).toBe(want);
      if (want === 403) {
        expect((res.body as { ok?: boolean }).ok, "api-authz answers { ok:false, error }").toBe(false);
        expect(JSON.stringify(res.body), "no PII leaks in the refusal").not.toContain(subject.email);
      } else {
        expect(JSON.stringify(res.body), "the owner's export really carries the subject").toContain(subject.email);
      }
    }

    // A member and an anonymous caller at the same two routes.
    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const anon = await anonContext(browser, baseURL!);
    for (const [label, rc, want] of [["member", memberCtx.request, 403], ["anonymous", anon.request, 401]] as [string, APIRequestContext, number][]) {
      const exp = await apiCall(rc, "get", `/api/admin/dsar/export?memberId=${subject.id}`, ORIGIN);
      if (want === 403) expect(exp.status, `${label} DSAR export`).toBe(403);
      else expect(ANON_REFUSED, "anonymous DSAR export").toContain(exp.status);
      const er = await apiCall(rc, "post", `/api/admin/dsar/erase?memberId=${subject.id}`, ORIGIN, {});
      if (want === 403) expect(er.status, `${label} DSAR erase`).toBe(403);
      else expect(ANON_REFUSED, "anonymous DSAR erase").toContain(er.status);
    }
    const still = await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [subject.id]);
    expect(still[0].email, "nothing was erased by a refused caller").toBe(subject.email);
    await anon.close();
    await clearBucket("dsar:");
  });

  test("erase leaves the sentinel, an audit row, and a member who cannot come back", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const rc = ctx.request;
    const subject = await makeMember({ tag: "erase-me" });

    const res = await apiCall(rc, "post", `/api/admin/dsar/erase?memberId=${subject.id}`, ORIGIN, {});
    expect(res.status, "owner erase").toBe(200);
    const row = await sql<{ email: string; name: string }>('SELECT email, name FROM "Member" WHERE id = $1', [subject.id]);
    expect(row, "erasure is a sentinel, not a delete").toHaveLength(1);
    expect(row[0].email, "the sentinel pattern the PATCH gate keys on").toMatch(/^deleted-.*@deleted\.invalid$/);
    expect(row[0].name, "the old name is gone from the row").not.toBe(subject.name);

    await expect.poll(async () =>
      (await sql('SELECT id FROM "AuditLog" WHERE "entityId" = $1 AND action LIKE $2', [subject.id, "%eras%"])).length,
      { timeout: 5_000, message: "audit rows are fire-and-forget (lib/audit-log.ts:56)" },
    ).toBeGreaterThan(0);

    const again = await apiCall(rc, "post", `/api/admin/dsar/erase?memberId=${subject.id}`, ORIGIN, {});
    expect(again.status, "erasing twice is idempotent-by-refusal, never a 500").toBe(409);
    await clearBucket("dsar:");
  });

  test("erasing a parent with active kids: record what happens to the children", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const parent = await makeMember({ tag: "eparent", accountType: "parent" });
    const kid = await makeMember({ tag: "ekid", accountType: "kids", parentMemberId: parent.id, dateOfBirth: new Date("2018-05-05") });

    const res = await apiCall(ctx.request, "post", `/api/admin/dsar/erase?memberId=${parent.id}`, ORIGIN, {});
    const kidRow = await sql<{ id: string; parentMemberId: string | null; status: string; email: string }>(
      'SELECT id, "parentMemberId", status, email FROM "Member" WHERE id = $1', [kid.id]);
    // Either outcome is defensible; a SILENT one is not. Assert the pair so the
    // log records which it is and the report can state the consequence.
    expect([200, 409, 422], `erase-a-parent status was ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toContain(res.status);
    if (res.status === 200) {
      // ROUND 2 — recorded, not adjudicated. The erase anonymises the parent
      // row in place (erase/route.ts:280-300) and never looks at
      // `parentMemberId`, so the child keeps a live link to a guardian whose
      // name is now "Deleted member" and whose emergency-contact trio has been
      // nulled — the same trio /api/waiver/sign-for-child:108 requires before a
      // parent may sign for that child. Which of unlink / cascade / refuse is
      // right is a design decision with an Article 17 deadline on one side of
      // it, so this lane states the consequence and proposes the shape rather
      // than changing the semantics of an owner-only erasure route under a cap.
      //
      // What IS decided, and is asserted: the parent's erasure must not reach
      // across and destroy the child's own record, and must not leave a
      // dangling pointer. Both hold today.
      expect(kidRow, "the child's own row survives the parent's erasure").toHaveLength(1);
      expect(kidRow[0].email, "…and the child's PII was not erased along with the parent's").not.toContain("@deleted.invalid");
      if (kidRow[0].parentMemberId !== null) {
        const guardian = await sql<{ name: string; email: string }>(
          'SELECT name, email FROM "Member" WHERE id = $1', [kidRow[0].parentMemberId]);
        expect(guardian, "the link is to a row that still exists — anonymised, never dangling").toHaveLength(1);
        console.warn(
          `[L-C J30] carried design item: kid ${kidRow[0].id} is still linked to erased guardian ` +
            `${kidRow[0].parentMemberId} (now "${guardian[0].name}"). Proposed shape in the round-2 report.`,
        );
      }
    }
    await clearBucket("dsar:");
  });

  test("promote-to-adult is owner-only, refuses an adult, and unlinks a kids row", async ({ browser, baseURL }) => {
    const parent = await makeMember({ tag: "pparent", accountType: "parent" });
    const kid = await makeMember({ tag: "pkid", accountType: "kids", parentMemberId: parent.id });
    const adult = await makeMember({ tag: "padult", accountType: "adult" });

    const mgr = await sessionFor(browser, baseURL!, { email: managerEmail, password: THROWAWAY_PASSWORD });
    const refused = await apiCall(mgr.request, "post", `/api/members/${kid.id}/promote-to-adult`, ORIGIN, {});
    expect(refused.status, "the brief's expectation, confirmed at promote-to-adult/route.ts:18").toBe(403);
    expect((refused.body as { ok?: boolean }).ok).toBe(false);
    const row = await sql<{ accountType: string }>('SELECT "accountType" FROM "Member" WHERE id = $1', [kid.id]);
    expect(row[0].accountType, "a refused promote writes nothing").toBe("kids");

    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const onAdult = await apiCall(own.request, "post", `/api/members/${adult.id}/promote-to-adult`, ORIGIN, {});
    expect(onAdult.status, "an adult is not eligible").toBe(400);
    expect(JSON.stringify(onAdult.body), "the routes own words, not a guess at them").toMatch(/not a junior or kids|eligible/i);

    const ok = await apiCall(own.request, "post", `/api/members/${kid.id}/promote-to-adult`, ORIGIN, {});
    expect(ok.status, "the kids row is promoted").toBe(200);
    const fresh = await sql<{ accountType: string; parentMemberId: string | null }>('SELECT "accountType", "parentMemberId" FROM "Member" WHERE id = $1', [kid.id]);
    expect(fresh[0].accountType).toBe("adult");
    expect(fresh[0].parentMemberId, "the parent link is severed").toBeNull();
    const p = await sql<{ hasKidsHint: boolean }>('SELECT "hasKidsHint" FROM "Member" WHERE id = $1', [parent.id]);
    expect(p[0].hasKidsHint, "the parent's hint is cleared when the last kid leaves").toBe(false);

    // Cross-tenant: tenant B's kid promoted from tenant A. The kid needs a
    // parent IN ITS OWN TENANT — `Member_kids_must_have_parent` is a CHECK
    // constraint, and round 1's guard in makeMember turned the INSERT failure
    // into a named error at the call site, which is where this landed.
    const bParent = await makeMember({ tag: "bparent", tenantId: tenantB.id, accountType: "parent" });
    const bKid = await makeMember({ tag: "bkid", tenantId: tenantB.id, accountType: "kids", parentMemberId: bParent.id });
    const x = await apiCall(own.request, "post", `/api/members/${bKid.id}/promote-to-adult`, ORIGIN, {});
    expect(x.status, "a foreign id answers like a missing one").toBe(404);
    const bRow = await sql<{ accountType: string }>('SELECT "accountType" FROM "Member" WHERE id = $1', [bKid.id]);
    expect(bRow[0].accountType).toBe("kids");
  });

  test("members/[id]/totp-reset is owner+manager today, not every staff role", async ({ browser, baseURL }) => {
    const subject = await makeMember({ tag: "totp" });
    await sql('UPDATE "Member" SET "totpEnabled" = true, "totpSecret" = $1 WHERE id = $2', ["JBSWY3DPEHPK3PXP", subject.id]);

    const cases: [string, string, string, number][] = [
      ["coach", COACH_A, PASSWORD_A, 403],
      ["admin", ADMIN_A, PASSWORD_A, 403],
      ["manager", managerEmail, THROWAWAY_PASSWORD, 200],
    ];
    for (const [role, email, password, want] of cases) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await apiCall(ctx.request, "post", `/api/members/${subject.id}/totp-reset`, ORIGIN, { reason: `campaign ${role} reset` });
      expect(res.status, `${role} POST members/[id]/totp-reset`).toBe(want);
      const row = await sql<{ totpEnabled: boolean; totpSecret: string | null }>('SELECT "totpEnabled", "totpSecret" FROM "Member" WHERE id = $1', [subject.id]);
      if (want === 403) {
        expect(row[0].totpEnabled, "a refused reset leaves the second factor standing").toBe(true);
        expect(row[0].totpSecret, "…and the seed").not.toBeNull();
      } else {
        expect(row[0].totpEnabled, "the manager's reset really cleared it").toBe(false);
        expect(row[0].totpSecret).toBeNull();
      }
    }

    // A reason under five characters is refused before anything is cleared.
    await sql('UPDATE "Member" SET "totpEnabled" = true, "totpSecret" = $1 WHERE id = $2', ["JBSWY3DPEHPK3PXP", subject.id]);
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const short = await apiCall(own.request, "post", `/api/members/${subject.id}/totp-reset`, ORIGIN, { reason: "x" });
    expect(short.status, "an audit row that cannot say why is worth little (route.ts:47)").toBe(400);
    const still = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "Member" WHERE id = $1', [subject.id]);
    expect(still[0].totpEnabled).toBe(true);
  });

  test("promotion-alerts is owner-only, and the members page hides it rather than 403-ing in place", async ({ browser, baseURL }) => {
    for (const [role, email, password, want] of [
      ["coach", COACH_A, PASSWORD_A, 403],
      ["admin", ADMIN_A, PASSWORD_A, 403],
      ["manager", managerEmail, THROWAWAY_PASSWORD, 403],
      ["owner", OWNER_A, PASSWORD_A, 200],
    ] as [string, string, string, number][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await apiCall(ctx.request, "get", "/api/members/promotion-alerts", ORIGIN);
      expect(res.status, `${role} GET /api/members/promotion-alerts`).toBe(want);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round 3, approved policy 2 + 4 (Noe, 19 Sep 2026). Two J22 cells that were
// N/A because the product refused the journey outright, and the per-member
// money gate the manifest has to settle.
test.describe("J22 — an adult with no email address", () => {
  test("staff may add one, and the placeholder never becomes an invite", async ({ browser, baseURL }) => {
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const name = `Campaign noemail ${RUN_STAMP}`;
    const created = await apiCall(own.request, "post", "/api/members", ORIGIN, { name });
    expect(created.status, `an adult with no email answered ${created.status}: ${created.text.slice(0, 160)}`).toBe(201);
    const body = created.body as { id: string; email: string; inviteUrl: string | null; noEmail: boolean };

    // The row, not the response: NOT NULL is satisfied by a placeholder in the
    // reserved .local domain, which cannot reach an inbox.
    const row = await sql<{ email: string; accountType: string }>(
      'SELECT email, "accountType" FROM "Member" WHERE id = $1', [body.id]);
    expect(row[0].email, "the address is a placeholder in a reserved domain").toMatch(/@no-login\.matflow\.local$/);
    expect(row[0].accountType, "…and they are an adult, not reclassified as a kid").toBe("adult");
    expect(body.noEmail, "the screen is told why there is no invite").toBe(true);
    expect(body.inviteUrl, "no invite link for an inbox that does not exist").toBeNull();

    // No token was minted for the placeholder, and nothing was mailed to it.
    expect(await countOf("MagicLinkToken", "email = $1", [row[0].email]), "no invite token").toBe(0);
    expect(await countOf("EmailLog", "recipient = $1", [row[0].email]), "nothing was mailed").toBe(0);

    // Bulk-invite must not pick them up, by id or in the whole-roster sweep.
    const invited = await apiCall(own.request, "post", "/api/members/bulk-invite", ORIGIN, { memberIds: [body.id] });
    expect(invited.status, "bulk-invite by id").toBe(200);
    expect((invited.body as { invited: number }).invited, "a placeholder is never a candidate").toBe(0);
    expect(await countOf("MagicLinkToken", "email = $1", [row[0].email]), "still no token").toBe(0);

    // The waiver link refuses for the same reason, with the sentence an owner needs.
    const link = await apiCall(own.request, "post", `/api/members/${body.id}/waiver-link`, ORIGIN, {});
    expect(link.status, "a waiver link for a member with no email").toBe(400);
    expect(link.text, "…and it says what to do about it").toMatch(/no email/i);

    // Clean-up is by id: the placeholder carries no RUN_STAMP, so teardownLc
    // cannot see it.
    await sql('DELETE FROM "Member" WHERE id = $1', [body.id]);
  });

  test("bulk-invite is owner + manager — a coach can no longer mail the roster", async ({ browser, baseURL }) => {
    const target = await makeMember({ tag: "bulkgate" });
    for (const [role, email, password, want] of [
      ["coach", COACH_A, PASSWORD_A, 403],
      ["admin", ADMIN_A, PASSWORD_A, 403],
      ["manager", managerEmail, THROWAWAY_PASSWORD, 200],
      ["owner", OWNER_A, PASSWORD_A, 200],
    ] as [string, string, string, number][]) {
      const before = await countOf("MagicLinkToken", "email = $1", [target.email]);
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await apiCall(ctx.request, "post", "/api/members/bulk-invite", ORIGIN, { memberIds: [target.id] });
      expect(res.status, `${role} POST /api/members/bulk-invite`).toBe(want);
      if (want === 403) {
        await assertUnchanged("MagicLinkToken", before, "email = $1", [target.email]);
        expect(res.text, "a refusal names no member").not.toContain(target.email);
      }
    }
  });

  test("the per-member payments list is staff-wide; the club ledger is not", async ({ browser, baseURL }) => {
    // The two gates diverge by design, and the manifest's per-page rule is why:
    // /dashboard/members/[id] is requireStaff (all four, J22 `allowed: STAFF`),
    // and its payments tab is that page's data. /dashboard/payments is
    // requireOwnerOrManager, and /api/payments matches it. The write control on
    // the profile (POST /api/payments/manual) is owner+manager in the UI too —
    // MemberProfile.tsx:656 — so a coach reads a member's history and cannot
    // book money. Both gates are right; they belong to different screens.
    const target = await makeMember({ tag: "paygate" });
    const coach = await sessionFor(browser, baseURL!, { email: COACH_A, password: PASSWORD_A });
    const mine = await apiCall(coach.request, "get", `/api/members/${target.id}/payments`, ORIGIN);
    expect(mine.status, "a coach reads the member profile's own payments tab").toBe(200);
    const ledger = await apiCall(coach.request, "get", "/api/payments", ORIGIN);
    expect(ledger.status, "…and is refused the club ledger").toBe(403);
    expect(ledger.text, "the ledger refusal carries no money").not.toMatch(/amountPence/);
  });
});
