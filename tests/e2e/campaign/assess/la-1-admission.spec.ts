/**
 * Lane L-A, file 1 — admission: J01 apply, J02 approve/reject, J03 activation,
 * J10 tenant states across every door.
 *
 * Lane A0 drives column one (each journey once, as its primary role, on a fresh
 * club). This file drives EVERY OTHER COLUMN on the seeded club `totalbjj`:
 * the ALLOWED roles through the UI, the REFUSED roles at the API with their
 * real session or none, and every attack class in COMMON against every
 * mutating route touched.
 *
 * J10 never touches `totalbjj`. It builds its own club in `beforeAll` and tears
 * it down in `afterAll`, because suspending the shared club would fail every
 * other lane with a symptom nowhere near the cause.
 *
 * Several describe blocks: serial mode means one timeout ends the block it is
 * in, and a single block holding the teardown would orphan a whole tenant.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { RUN_STAMP, sql } from "../helpers/db";
import { operatorContext, sessionFor } from "./a0-shared";
import {
  TENANT_A_OWNER,
  TENANT_A_COACH,
  TENANT_A_PASSWORD,
  TENANT_A_SLUG,
  THROWAWAY_PASSWORD,
  apiRefused,
  assertUnchanged,
  clearBucket,
  countOf,
  createThrowawayMember,
  createThrowawayTenant,
  createThrowawayUser,
  magicTokenRow,
  mintMagicToken,
  seededTenantId,
  teardownThrowawayTenant,
  type ThrowawayTenant,
} from "./la-shared";

test.use({ channel: "chromium" });
test.describe.configure({ mode: "default", timeout: 180_000 });

function origin(baseURL: string | undefined): string {
  return baseURL ?? "http://localhost:3847";
}

const APPLY_BODY = {
  gymName: `${RUN_STAMP} Ashgrove Academy`,
  ownerName: `${RUN_STAMP} Ines Duarte`,
  email: `${RUN_STAMP}-apply@example.test`,
  phone: "+44 7700 900456",
  sport: "Brazilian Jiu-Jitsu",
  memberCount: "40-80",
  message: "We train five nights a week and want to stop using a spreadsheet.",
};

/** Every GymApplication this file writes carries the stamp, so teardown finds them all. */
async function deleteStampedApplications(): Promise<void> {
  await sql('DELETE FROM "GymApplication" WHERE "gymName" LIKE $1 OR email LIKE $2', [
    `${RUN_STAMP}%`,
    `${RUN_STAMP}%`,
  ]);
}

// ════════════════════════════════════════════════════════════════════════════
// J01 — Apply as a new club. Manifest: ALLOWED anonymous only; every account
// role and every non-tenant role is N/A *by the manifest* — but /apply is a
// PUBLIC route with no session check at all, so "N/A" is a claim about screens,
// not about reachability. This block drives the route as each of those roles to
// record what actually happens, which is what the brief asks for by name.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J01 — apply", () => {
  // ROUND 2: this block shares ONE bucket — `apply:<ip>`, 5 per hour, keyed on
  // an IP that is the same for every test in the file. The first three tests
  // between them spend it, so the fourth ("replay and race") read 429/429 and
  // counted zero new rows, and the fifth read 429 where it asserted 400. That
  // is the limiter working; the harness was asserting route behaviour from
  // behind a closed door. Clearing before each test is the only honest fix —
  // raising nothing, weakening nothing — and the limiter still gets driven, on
  // purpose, by the test that exists for it.
  test.beforeEach(async () => {
    await clearBucket("apply:");
  });

  test.afterAll(async () => {
    await deleteStampedApplications();
    await clearBucket("apply:");
  });

  test("J01/anonymous — the public form writes a GymApplication row", async ({ request, baseURL }) => {
    const before = await countOf("GymApplication");
    const res = await request.post("/api/apply", {
      headers: { Origin: origin(baseURL) },
      data: APPLY_BODY,
    });

    // `.env.test` carries no mail key, so `sendEmail` cannot reach a human and
    // the route answers 502 BY DESIGN (app/api/apply/route.ts:132-165) — the
    // row is still committed and `saved` is derived from that, not asserted.
    // Delivery itself is UNCOVERED: it needs a live Resend key.
    expect([200, 502], "POST /api/apply").toContain(res.status());
    const body = (await res.json()) as { ok: boolean; id: string | null; saved: boolean; error?: string };
    expect(body.saved, "the route reports whether the row was written").toBe(true);
    expect(body.id, "an application id comes back").toBeTruthy();

    // THE PROOF IS THE ROW, not the response that claims it.
    const rows = await sql<{ id: string; gymName: string; email: string; status: string; notes: string | null }>(
      'SELECT id, "gymName", email, status, notes FROM "GymApplication" WHERE id = $1',
      [body.id],
    );
    expect(rows, "GymApplication row for the id the route returned").toHaveLength(1);
    expect(rows[0].gymName).toBe(APPLY_BODY.gymName);
    expect(rows[0].email).toBe(APPLY_BODY.email);
    expect(await countOf("GymApplication")).toBe(before + 1);

    if (res.status() === 502) {
      // The applicant is told to email hello@matflow.studio. British English,
      // and it must name the fallback — otherwise a lead is silently lost.
      expect(body.error, "502 copy names a mailbox the applicant can reach").toContain("matflow.studio");
    }
  });

  test("J01/owner, coach, member — a signed-in role posting /apply is not refused", async ({ browser, baseURL }) => {
    // The manifest files these as N/A. They are N/A as SCREENS — nothing in the
    // dashboard or the portal links to /apply — but the route itself has no
    // session check, so a signed-in owner applies exactly as a stranger does.
    // Recording it rather than asserting a refusal the code does not make.
    const contexts: { role: string; ctx: BrowserContext }[] = [];
    for (const [role, email, pw] of [
      ["owner", TENANT_A_OWNER, TENANT_A_PASSWORD],
      ["coach", TENANT_A_COACH, TENANT_A_PASSWORD],
    ] as const) {
      contexts.push({
        role,
        ctx: await sessionFor(browser, origin(baseURL), { slug: TENANT_A_SLUG, email, password: pw }),
      });
    }

    for (const { role, ctx } of contexts) {
      const before = await countOf("GymApplication");
      const res = await ctx.request.post("/api/apply", {
        headers: { Origin: origin(baseURL) },
        data: { ...APPLY_BODY, email: `${RUN_STAMP}-${role}-apply@example.test` },
      });
      expect([200, 502], `POST /api/apply as ${role}`).toContain(res.status());
      const body = (await res.json()) as { id: string | null };
      // A row IS written for a signed-in staff member — the funnel does not
      // know or care who is signed in. Proven, not assumed.
      expect(await countOf("GymApplication"), `${role} wrote an application`).toBe(before + 1);
      expect(body.id).toBeTruthy();
    }
  });

  test("J01 — a duplicate submission is accepted and writes a SECOND row", async ({ request, baseURL }) => {
    const email = `${RUN_STAMP}-dupe@example.test`;
    const payload = { ...APPLY_BODY, email };
    const before = await countOf("GymApplication", "email = $1", [email]);
    await request.post("/api/apply", { headers: { Origin: origin(baseURL) }, data: payload });
    await request.post("/api/apply", { headers: { Origin: origin(baseURL) }, data: payload });
    // No idempotency key and no unique index on email: two rows. Recorded as
    // the product's actual contract so the operator queue is known to contain
    // duplicates, not assumed clean.
    expect(await countOf("GymApplication", "email = $1", [email])).toBe(before + 2);
  });

  test("J01 — replay and race: two identical requests in parallel", async ({ request, baseURL }) => {
    const email = `${RUN_STAMP}-race@example.test`;
    const before = await countOf("GymApplication", "email = $1", [email]);
    const [a, b] = await Promise.all([
      request.post("/api/apply", { headers: { Origin: origin(baseURL) }, data: { ...APPLY_BODY, email } }),
      request.post("/api/apply", { headers: { Origin: origin(baseURL) }, data: { ...APPLY_BODY, email } }),
    ]);
    // Neither may be a 500 — a race that crashes is a defect even where the
    // route intends to write twice.
    expect([a.status(), b.status()].every((s) => s < 500 || s === 502), "no 5xx other than the mail 502").toBe(true);
    expect(await countOf("GymApplication", "email = $1", [email])).toBe(before + 2);
  });

  test("J01 — malformed and oversize bodies are refused with nothing written", async ({ request, baseURL }) => {
    const before = await countOf("GymApplication");
    const cases: [string, unknown][] = [
      ["empty object", {}],
      ["missing email", { ...APPLY_BODY, email: undefined }],
      ["not an email", { ...APPLY_BODY, email: "not-an-email" }],
      ["10 000-character gym name", { ...APPLY_BODY, gymName: "A".repeat(10_000) }],
      ["empty array as the body", []],
      ["NaN memberCount", { ...APPLY_BODY, memberCount: Number.NaN }],
      ["null message", { ...APPLY_BODY, gymName: null }],
      ["phone too short", { ...APPLY_BODY, phone: "x" }],
    ];
    for (const [label, data] of cases) {
      // ROUND 3: the `beforeEach` clear was not enough — `apply:<ip>` allows 5
      // an hour and there are nine cases here, so the SIXTH ("NaN memberCount")
      // read 429 where it asserted 400. The limiter runs before the body is
      // parsed, so every malformed body spends a hit. Clearing per case keeps
      // this test about the malformed-body contract; the limiter is still
      // driven on purpose, at full strength, by the test that exists for it.
      await clearBucket("apply:");
      const res = await request.post("/api/apply", { headers: { Origin: origin(baseURL) }, data: data as object });
      expect(res.status(), `malformed: ${label}`).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error, `malformed: ${label} carries an error`).toBeTruthy();
    }
    // Invalid JSON entirely — a text/plain body, which is also the only content
    // type a browser can POST cross-origin without a preflight.
    const raw = await request.post("/api/apply", {
      headers: { Origin: "http://evil.test", "Content-Type": "text/plain" },
      data: "{not json",
    });
    expect(raw.status(), "invalid JSON body").toBe(400);
    await assertUnchanged("GymApplication", before);
  });

  test("J01 — prototype pollution: an inherited field satisfies nothing and sticks to nothing", async ({
    request,
    baseURL,
  }) => {
    // ROUND 4. This case used to live in the loop above as
    // `{ ...APPLY_BODY, __proto__: { admin: true } }` and expected a 400. It
    // could never have tested anything: `__proto__:` in an OBJECT LITERAL sets
    // the object's prototype, it does not create an own property, so
    // `JSON.stringify` emitted a plain, entirely valid APPLY_BODY and the
    // route did the right thing by answering 200. The attack has to be spelled
    // on the wire, as a raw string, because only `JSON.parse` turns
    // `"__proto__"` into an own key.
    //
    // And the contract is not "400". Zod strips unknown keys, so an extra
    // `__proto__` alongside a valid body is simply ignored — a 2xx is correct.
    // The two things that must be true are asserted instead: an INHERITED
    // field never satisfies validation, and nothing sticks to the server's
    // `Object.prototype` afterwards.
    const before = await countOf("GymApplication");
    const o = origin(baseURL);
    const send = (body: string) =>
      request.post("/api/apply", {
        headers: { Origin: o, "Content-Type": "application/json" },
        data: body,
      });

    // 1. The required fields present ONLY under `__proto__`. Built as a raw
    //    STRING, never via `JSON.stringify({ __proto__: … })` — that is the
    //    very trap this test exists because of: the literal would set the
    //    prototype and stringify to `{}`, and the case would pass for entirely
    //    the wrong reason. On the wire it is a real key, and Zod, which reads
    //    own properties, must refuse it exactly like an empty body.
    await clearBucket("apply:");
    const inherited = await send(`{"__proto__":${JSON.stringify(APPLY_BODY)}}`);
    expect(inherited.status(), "an inherited field satisfies no schema").toBe(400);
    expect(((await inherited.json()) as { error?: string }).error).toBeTruthy();

    // 2. And nothing stuck: an empty body is still a 400 afterwards. If the
    //    payload above had reached `Object.prototype`, `{}` would suddenly
    //    carry a gymName and validate — this is the observable proof, from
    //    outside the process, that it did not.
    await clearBucket("apply:");
    const stillEmpty = await send("{}");
    expect(stillEmpty.status(), "Object.prototype was not polluted by the previous request").toBe(400);

    await assertUnchanged("GymApplication", before);
  });

  test("J01 — CSRF: /apply is deliberately unguarded; record, do not fail", async ({ request, baseURL }) => {
    // `lib/csrf.ts:22-23` names /apply as an explicit exclusion so marketing
    // pages can post to it. A foreign Origin therefore succeeds. That is the
    // documented contract; the finding would be a `formData()` route WITHOUT
    // the guard, and this route reads JSON only (`req.json()`, line 37).
    const before = await countOf("GymApplication");
    const res = await request.post("/api/apply", {
      headers: { Origin: "http://evil.test", Referer: "http://evil.test/" },
      data: { ...APPLY_BODY, email: `${RUN_STAMP}-csrf@example.test` },
    });
    expect([200, 502], "foreign Origin on the public funnel").toContain(res.status());
    expect(await countOf("GymApplication"), "the row is written — by design").toBe(before + 1);
    void origin(baseURL);
  });

  test("J01 — the rate limit answers 429, never 500, and is reset afterwards", async ({ request, baseURL }) => {
    await clearBucket("apply:");
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await request.post("/api/apply", {
          headers: { Origin: origin(baseURL) },
          data: { ...APPLY_BODY, email: `${RUN_STAMP}-rl${i}@example.test` },
        });
        statuses.push(res.status());
        if (res.status() === 429) {
          expect(res.headers()["retry-after"], "429 carries Retry-After").toBeTruthy();
          const body = (await res.json()) as { error?: string };
          expect(body.error).toContain("Too many");
          break;
        }
      }
      expect(statuses, "the bucket closes at 5/hour (lib/rate-limit.ts)").toContain(429);
      expect(statuses.filter((s) => s >= 500 && s !== 502), "no 500 from the limiter").toEqual([]);
    } finally {
      // Rule 6: every lane shares this IP. Leave nothing exhausted.
      await clearBucket("apply:");
    }
  });

  test("J01 — the IP trust order is x-vercel-forwarded-for, then x-real-ip, then the last x-forwarded-for hop", async ({
    request,
    baseURL,
  }) => {
    await clearBucket("apply:");
    try {
      const pinned = "203.0.113.77";
      // A bare x-forwarded-for keys a FRESH bucket locally by design
      // (lib/rate-limit.ts:116-128) — the inherited finding. So send it WITH a
      // x-vercel-forwarded-for present and assert the spoofed hop does not move
      // the bucket the trusted header names.
      for (let i = 0; i < 3; i++) {
        await request.post("/api/apply", {
          headers: {
            Origin: origin(baseURL),
            "x-vercel-forwarded-for": pinned,
            "x-forwarded-for": "198.51.100.9",
          },
          data: { ...APPLY_BODY, email: `${RUN_STAMP}-ip${i}@example.test` },
        });
      }
      const pinnedHits = await countOf("RateLimitHit", "bucket = $1", [`apply:${pinned}`]);
      expect(pinnedHits, "the trusted header keyed the bucket").toBeGreaterThan(0);
      const spoofHits = await countOf("RateLimitHit", "bucket = $1", ["apply:198.51.100.9"]);
      expect(spoofHits, "the spoofed x-forwarded-for did NOT key its own bucket").toBe(0);
    } finally {
      await clearBucket("apply:");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J02 — Approve or reject. ALLOWED: operator only. Every tenant role and
// anonymous is REFUSED at the API with its real session, and the proof is the
// status, the body, and that no Tenant and no GymApplication moved.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J02 — approve or reject, every non-operator refused", () => {
  let applicationId = "";

  test.beforeAll(async () => {
    const rows = await sql<{ id: string }>(
      // ROUND 2, two faults in one line. `updatedAt` is `@updatedAt` with no
      // database default (prisma/schema.prisma:1047), so a raw INSERT must
      // supply it — Prisma fills it in application code, not in Postgres. And
      // the status CHECK added by 20260430000004 allows
      // `new | contacted | approved | rejected`, never 'pending'.
      `INSERT INTO "GymApplication" ("id", "gymName", "contactName", "email", "phone", "discipline", "memberCount", "status", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'Brazilian Jiu-Jitsu', '40-80', 'new', now(), now())
       RETURNING id`,
      [
        `${RUN_STAMP} Refusal Target`,
        `${RUN_STAMP} Target Owner`,
        `${RUN_STAMP}-target@example.test`,
        "+44 7700 900999",
      ],
    );
    applicationId = rows[0].id;
  });

  test.afterAll(async () => {
    await deleteStampedApplications();
    await clearBucket("admin-approve:");
    await clearBucket("admin-reject:");
  });

  test("J02 — anonymous is refused at all four routes with nothing written", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    const tenants = await countOf("Tenant");
    const before = await sql<{ status: string }>('SELECT status FROM "GymApplication" WHERE id = $1', [
      applicationId,
    ]);

    const list = await apiRefused(request, "get", "/api/admin/applications", o, 401);
    expect(list.body, "the operator list body").toHaveProperty("error");

    await apiRefused(request, "post", `/api/admin/applications/${applicationId}/approve`, o, [401, 403], {
      slug: `${RUN_STAMP}-hijack`,
    });
    await apiRefused(request, "post", `/api/admin/applications/${applicationId}/reject`, o, [401, 403], {
      reason: "no",
    });
    await apiRefused(request, "post", "/api/admin/create-tenant", o, [401, 403], {
      name: `${RUN_STAMP} Hijack`,
      slug: `${RUN_STAMP}-hijack2`,
    });

    await assertUnchanged("Tenant", tenants);
    const after = await sql<{ status: string }>('SELECT status FROM "GymApplication" WHERE id = $1', [
      applicationId,
    ]);
    expect(after[0].status, "the application did not move").toBe(before[0].status);
  });

  test("J02 — every tenant role, with its real session, is refused", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const tenantId = await seededTenantId();
    const manager = await createThrowawayUser("manager");
    const admin = await createThrowawayUser("admin");
    const member = await createThrowawayMember();

    const subjects: { role: string; email: string; password: string }[] = [
      { role: "owner", email: TENANT_A_OWNER, password: TENANT_A_PASSWORD },
      { role: "coach", email: TENANT_A_COACH, password: TENANT_A_PASSWORD },
      { role: "manager", email: manager.email, password: THROWAWAY_PASSWORD },
      { role: "admin", email: admin.email, password: THROWAWAY_PASSWORD },
      { role: "member", email: member.email, password: THROWAWAY_PASSWORD },
    ];

    // ROUND 4. Two counts, each taken with the WHERE its own assertion uses.
    // This was one `countOf("Tenant")` over the whole table (26) compared at
    // the end against a count filtered to a single id (1), so the test failed
    // with "Tenant count(*) across a refused request: Expected 26, Received 1"
    // and said nothing whatever about whether anything had been written. A
    // before/after pair must be taken through the same lens.
    const tenants = await countOf("Tenant");
    const seededStillHere = await countOf("Tenant", '"deletedAt" IS NULL AND id = $1', [tenantId]);
    for (const s of subjects) {
      const ctx = await sessionFor(browser, o, {
        slug: TENANT_A_SLUG,
        email: s.email,
        password: s.password,
      });
      // A tenant session is not an operator session. `isAdminAuthed` reads the
      // `matflow_admin` cookie or a bearer header — neither of which a gym
      // login can produce — so this must refuse whatever the gym role is.
      await apiRefused(ctx.request, "get", "/api/admin/applications", o, [401, 403]);
      await apiRefused(
        ctx.request,
        "post",
        `/api/admin/applications/${applicationId}/approve`,
        o,
        [401, 403],
        { slug: `${RUN_STAMP}-${s.role}` },
      );
      await apiRefused(ctx.request, "post", `/api/admin/applications/${applicationId}/reject`, o, [401, 403], {
        reason: "declined by a gym role",
      });
    }
    await assertUnchanged("Tenant", tenants);
    await assertUnchanged("Tenant", seededStillHere, '"deletedAt" IS NULL AND id = $1', [tenantId]);
  });

  test("J02 — a bare x-admin-secret header with no operator session is a second door: record it", async ({
    request,
    baseURL,
  }) => {
    // `lib/admin-auth.ts:78` — isAdminAuthed accepts EITHER the cookie or the
    // header. The header carries no identity at all, so every operator
    // mutation made through it is unattributed. Asserted as a fact about the
    // product; the grade lives in the report, and the secret is never printed.
    const o = origin(baseURL);
    const res = await request.post("/api/admin/applications/does-not-exist/reject", {
      headers: { Origin: o, "x-admin-secret": "obviously-wrong-value" },
      data: { reason: "probe" },
    });
    expect([401, 403], "a WRONG header value must not authenticate").toContain(res.status());
  });

  test("J02 — an operator approving twice, and rejecting an approved one", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const ctx = await operatorContext(browser, o);
    test.skip(
      ctx === null,
      "UNCOVERED — MATFLOW_ADMIN_SECRET is absent from the runner env; /api/admin/auth/login answers 503",
    );
    if (!ctx) return;
    try {
      const rows = await sql<{ id: string }>(
        // See the note at the sibling INSERT above: `updatedAt` has no DB
        // default and 'pending' is not one of the four allowed statuses.
        `INSERT INTO "GymApplication" ("id", "gymName", "contactName", "email", "phone", "discipline", "memberCount", "status", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, '+44 7700 900111', 'BJJ', '10', 'new', now(), now())
         RETURNING id`,
        [`${RUN_STAMP} Twice`, `${RUN_STAMP} Twice Owner`, `${RUN_STAMP}-twice@example.test`],
      );
      const appId = rows[0].id;
      const slug = `${RUN_STAMP}-twice`.toLowerCase();

      const first = await ctx.request.post(`/api/admin/applications/${appId}/approve`, {
        headers: { Origin: o },
        data: { slug },
      });
      expect([201, 200], "the first approve").toContain(first.status());

      const tenantsAfterFirst = await countOf("Tenant");
      const second = await ctx.request.post(`/api/admin/applications/${appId}/approve`, {
        headers: { Origin: o },
        data: { slug: `${slug}-2` },
      });
      expect(second.status(), "approving an already-approved application").toBe(409);
      await assertUnchanged("Tenant", tenantsAfterFirst);

      const reject = await ctx.request.post(`/api/admin/applications/${appId}/reject`, {
        headers: { Origin: o },
        data: { reason: "changed our mind after approving" },
      });
      // Whatever it answers, the tenant that was already created must not be
      // torn down by a reject — record the status and prove the row survived.
      expect(reject.status(), "rejecting an approved application").toBeLessThan(500);
      await assertUnchanged("Tenant", tenantsAfterFirst);

      // CSRF as the code applies it: approve/reject ARE guarded
      // (assertSameOrigin, approve/route.ts:49). Missing and foreign Origin.
      const noOrigin = await ctx.request.post(`/api/admin/applications/${appId}/reject`, {
        data: { reason: "no origin header" },
      });
      expect([403], "missing Origin on a guarded operator route").toContain(noOrigin.status());
      const foreign = await ctx.request.post(`/api/admin/applications/${appId}/reject`, {
        headers: { Origin: "http://evil.test" },
        data: { reason: "foreign origin" },
      });
      expect([403], "foreign Origin on a guarded operator route").toContain(foreign.status());

      // Teardown: the approve minted a whole tenant.
      const created = await sql<{ id: string }>('SELECT id FROM "Tenant" WHERE slug LIKE $1', [`${RUN_STAMP}%`]);
      for (const t of created) await teardownThrowawayTenant(t.id);
    } finally {
      await ctx.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J03 — Activation: a `first_time_signup` token at each of its consumers.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J03 — activation token", () => {
  let user: Awaited<ReturnType<typeof createThrowawayUser>>;

  test.beforeAll(async () => {
    user = await createThrowawayUser("coach");
  });

  test.afterAll(async () => {
    await sql('DELETE FROM "MagicLinkToken" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
    await sql('DELETE FROM "PasswordHistory" WHERE "userId" = $1', [user.id]).catch(() => {});
    await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("J03 — a first_time_signup token signs in once and is consumed", async ({ browser, baseURL }) => {
    const tenantId = await seededTenantId();
    const { raw, id } = await mintMagicToken({
      tenantId,
      email: user.email,
      purpose: "first_time_signup",
    });

    const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
    try {
      await ctx.clearCookies();
      const page = await ctx.newPage();
      await page.goto(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`);
      await page.waitForURL(/dashboard|onboarding|totp/, { timeout: 60_000 });
      // The ROW is the proof the token was consumed, not the landing page.
      const row = await magicTokenRow(id);
      expect(row?.used, "the token row is marked used").toBe(true);

      // A fresh GET through the new session proves a real session exists —
      // never the page state the redirect just produced.
      const me = await ctx.request.get("/api/me/gym");
      expect(me.status(), "a fresh GET with the minted session").toBeLessThan(400);
      await page.close();
    } finally {
      await ctx.close();
    }
  });

  test("J03 — the same token a second time is refused", async ({ browser, baseURL }) => {
    const tenantId = await seededTenantId();
    const { raw, id } = await mintMagicToken({ tenantId, email: user.email, purpose: "first_time_signup" });
    const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
    try {
      await ctx.clearCookies();
      await ctx.request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`);
      expect((await magicTokenRow(id))?.used).toBe(true);

      const replay = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
      await replay.clearCookies();
      const res = await replay.request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`, {
        maxRedirects: 0,
      });
      expect([302, 307], "a reused token redirects").toContain(res.status());
      expect(res.headers()["location"], "reuse lands on the invalid-link error").toContain("error=invalid_link");
      // Nothing was minted: the replay context carries no session cookie.
      //
      // Exactly 401 since the round-1 proxy fix. Before it, an unauthenticated
      // `/api/*` request was 307-redirected to /login and this request context
      // followed the redirect to a 200 HTML page — so this assertion would have
      // read a REFUSED probe as a successful one, which is the whole reason the
      // redirect was wrong.
      const probe = await replay.request.get("/api/me/gym");
      expect(probe.status(), "the replay context has no session").toBe(401);
      expect(await probe.json(), "the proxy refusal body shape").toEqual({
        ok: false,
        error: "Unauthorized",
      });
      await replay.close();
    } finally {
      await ctx.close();
    }
  });

  test("J03 — an expired token is refused and is NOT consumed", async ({ browser, baseURL }) => {
    const tenantId = await seededTenantId();
    const { raw, id } = await mintMagicToken({
      tenantId,
      email: user.email,
      purpose: "first_time_signup",
      expiresInMs: -60_000,
    });
    const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
    try {
      await ctx.clearCookies();
      const res = await ctx.request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`, {
        maxRedirects: 0,
      });
      expect(res.headers()["location"], "an expired token").toContain("error=invalid_link");
      expect((await magicTokenRow(id))?.used, "an expired token is left unconsumed").toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test("J03 — malformed tokens: absent, junk, 4 097 characters, a re-spelling", async ({ request }) => {
    const cases: [string, string | null][] = [
      ["absent", null],
      ["junk", "token.junk"],
      ["4097 characters", "a".repeat(4097)],
      ["empty string", ""],
      ["sql-ish", "' OR 1=1 --"],
    ];
    for (const [label, token] of cases) {
      const url =
        token === null
          ? "/api/magic-link/verify"
          : `/api/magic-link/verify?token=${encodeURIComponent(token)}`;
      const res = await request.get(url, { maxRedirects: 0 });
      expect([302, 307], `malformed token: ${label}`).toContain(res.status());
      expect(res.headers()["location"], `malformed token: ${label}`).toContain("error=invalid_link");
    }
  });

  test("J03 — an activation token is host-independent: it signs into ITS OWN tenant", async ({
    browser,
    baseURL,
  }) => {
    // A magic-link token carries its tenantId on the row. Presenting it against
    // any host must mint a session for the TOKEN ROW's tenant, never the host's.
    const throwaway = await createThrowawayTenant();
    try {
      const { raw } = await mintMagicToken({
        tenantId: throwaway.id,
        email: throwaway.ownerEmail,
        purpose: "first_time_signup",
      });
      const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
      try {
        await ctx.clearCookies();
        // Presented on tenant A's host with a tenant-A club query string.
        await ctx.request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}&club=${TENANT_A_SLUG}`);
        const gym = await ctx.request.get("/api/me/gym");
        if (gym.ok()) {
          const body = (await gym.json()) as Record<string, unknown>;
          const slug = (body.slug ?? (body.gym as Record<string, unknown> | undefined)?.slug) as
            | string
            | undefined;
          // EXPLOIT if it is tenant A's slug: the token would have crossed clubs.
          expect(slug, "the session belongs to the TOKEN's tenant, not the host's").not.toBe(TENANT_A_SLUG);
        }
      } finally {
        await ctx.close();
      }
    } finally {
      await teardownThrowawayTenant(throwaway.id);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J10 — Tenant states across every door. A throwaway club only.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J10 — tenant states", () => {
  let club: ThrowawayTenant;

  test.beforeAll(async () => {
    club = await createThrowawayTenant();
  });

  test.afterAll(async () => {
    if (club) await teardownThrowawayTenant(club.id);
    await clearBucket("login:");
    await clearBucket("magic-link:");
  });

  async function setState(status: string | null, deleted: boolean): Promise<void> {
    await sql('UPDATE "Tenant" SET "subscriptionStatus" = $1, "deletedAt" = $2 WHERE id = $3', [
      status,
      deleted ? new Date() : null,
      club.id,
    ]);
  }

  test("J10 — the password door: suspended, cancelled, soft-deleted refuse; past_due admits", async ({
    browser,
    baseURL,
  }) => {
    const cases: [string, string | null, boolean, "refuse" | "admit"][] = [
      ["trial", "trial", false, "admit"],
      ["past_due", "past_due", false, "admit"],
      ["suspended", "suspended", false, "refuse"],
      ["cancelled", "cancelled", false, "refuse"],
      ["soft-deleted", "trial", true, "refuse"],
    ];

    for (const [label, status, deleted, verdict] of cases) {
      await setState(status, deleted);
      const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
      try {
        await ctx.clearCookies();
        const page = await ctx.newPage();
        await page.goto(`/login?club=${club.slug}`);
        await page.waitForSelector("input[type='email']", { timeout: 60_000 });
        await page.fill("input[type='email']", club.ownerEmail);
        await page.fill("input[type='password']", THROWAWAY_PASSWORD);
        await page.click("button[type='submit']");

        if (verdict === "admit") {
          await page.waitForURL(/dashboard|onboarding|totp/, { timeout: 60_000 });
        } else {
          // ROUND 4. `waitForURL(/login/)` is a NO-OP here — a refusal never
          // navigates, so the page is already at /login and the matcher
          // resolves on the same tick as the click. The body was therefore
          // read mid-submit, before the POST to
          // /api/auth/callback/credentials had come back, and both J10 cases
          // failed on an error message that had not been rendered yet. The
          // tell was the second assertion PASSING: the screen carried neither
          // the club-state copy nor "Incorrect email or password", i.e. no
          // error at all.
          //
          // The product is right and was proven right on the wire, off
          // Playwright, against this same door: suspended and cancelled answer
          // `/login?error=CredentialsSignin&code=tenant_paused`, soft-deleted
          // answers `code=tenant_closed`, and a `trial` club signs in. So wait
          // for the refusal the product actually renders — the alert inside
          // the FORM, never a bare `[role=alert]`, which also matches Next's
          // own `#__next-route-announcer__` on every page of this app.
          await expect(
            page.locator("form").locator("[role='alert']").first(),
          ).toBeVisible({ timeout: 60_000 });
          await page.waitForURL(/login/, { timeout: 60_000 });
          // `app/login/page.tsx:64-67` — the strings the product promises.
          // auth.ts throws TenantRefusedError with code tenant_paused (suspended
          // or cancelled) or tenant_closed (deleted).
          const copy = await page.locator("body").innerText();
          expect(
            /account is paused|account has been closed/i.test(copy),
            `${label}: the login page must name the club's state, not "Incorrect email or password."`,
          ).toBe(true);
          expect(
            /Incorrect email or password/i.test(copy),
            `${label}: never the generic credentials copy — it sends the owner to reset a password that was never the problem`,
          ).toBe(false);
        }
        await page.close();
      } finally {
        await ctx.close();
      }
    }
    await setState("trial", false);
  });

  test("J10 — the magic-link door honours the same states AND says so in words the login page knows", async ({
    browser,
    baseURL,
  }) => {
    for (const [label, status, deleted] of [
      ["suspended", "suspended", false],
      ["cancelled", "cancelled", false],
      ["soft-deleted", "trial", true],
    ] as [string, string, boolean][]) {
      await setState(status, deleted);
      const { raw, id } = await mintMagicToken({
        tenantId: club.id,
        email: club.ownerEmail,
        purpose: "login",
      });
      const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
      try {
        await ctx.clearCookies();
        const res = await ctx.request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`, {
          maxRedirects: 0,
        });
        const location = res.headers()["location"] ?? "";
        expect(location, `${label}: the magic-link door refuses`).toContain("/login?error=");
        expect(location, `${label}: it must NOT mint a session`).not.toContain("/dashboard");
        // No session was minted. Exactly 401 since the round-1 proxy fix.
        const probe = await ctx.request.get("/api/me/gym");
        expect(probe.status(), `${label}: no session exists`).toBe(401);

        // The token SURVIVES the refusal, since the round-1 fix moved the
        // admission decision ahead of the consume (verify/route.ts:22-60). It
        // used to be burned: the member of a club that had fallen behind on
        // MatFlow's own invoice lost their only link and had to wait out the
        // 15-minute request bucket to be refused a second time.
        expect(
          (await magicTokenRow(id))?.used,
          `${label}: a refused club must not cost the member their token`,
        ).toBe(false);

        // THE COPY. `app/login/page.tsx:58-72` renders four codes and falls
        // through to "Incorrect email or password." for anything else. The
        // route used to build its code by interpolation (`tenant_${reason}`),
        // emitting three codes the page had never heard of. It now calls
        // `admissionErrorCode` — the same translation the password door uses.
        const code = new URL(location, origin(baseURL)).searchParams.get("error");
        expect(
          ["tenant_paused", "tenant_closed"],
          `${label}: the error code the login page can render (observed: ${code})`,
        ).toContain(code);
      } finally {
        await ctx.close();
      }
    }
    await setState("trial", false);
  });

  test("J10 — a suspended club's member is refused at the password door too", async ({ browser, baseURL }) => {
    await setState("suspended", false);
    const ctx = await browser.newContext({ baseURL: origin(baseURL), storageState: undefined });
    try {
      await ctx.clearCookies();
      const page = await ctx.newPage();
      await page.goto(`/login?club=${club.slug}`);
      await page.waitForSelector("input[type='email']", { timeout: 60_000 });
      await page.fill("input[type='email']", club.memberEmail);
      await page.fill("input[type='password']", THROWAWAY_PASSWORD);
      await page.click("button[type='submit']");
      // ROUND 4: wait for the refusal to be RENDERED, not for a URL that never
      // changes — see the note in the password-door case above. Scoped to the
      // form so Next's route announcer (a permanently "visible" 1×1
      // `[role=alert]` in a shadow root on every page) cannot satisfy it.
      await expect(
        page.locator("form").locator("[role='alert']").first(),
      ).toBeVisible({ timeout: 60_000 });
      await page.waitForURL(/login/, { timeout: 60_000 });
      const copy = await page.locator("body").innerText();
      // `lib/tenant-admission.ts:58-68` — a member gets the vague version, by
      // design, so a stranger learns nothing about the club's commercial state.
      expect(/paused/i.test(copy), "the member is told the club is paused").toBe(true);
      expect(/MatFlow/i.test(copy), "a member must NOT be told to contact MatFlow").toBe(false);
      await page.close();
    } finally {
      await ctx.close();
      await setState("trial", false);
    }
  });

  test("J10 — the Google callback route with a suspended club", async ({ request, baseURL }) => {
    await setState("suspended", false);
    try {
      // `/api/account/pending-tenant` fails closed when ENABLE_GOOGLE_OAUTH is
      // not "true" — record 503 as the observed contract rather than skipping.
      const res = await request.post("/api/account/pending-tenant", {
        headers: { Origin: origin(baseURL) },
        data: { tenantSlug: club.slug },
      });
      expect([503, 200, 404], "pending-tenant with Google disabled").toContain(res.status());
      if (res.status() === 503) {
        const body = (await res.json()) as { error?: string };
        expect(body.error).toContain("Google sign-in not enabled");
      }
    } finally {
      await setState("trial", false);
    }
  });

  test("J10 — the kiosk is NOT admission-gated: a suspended club's kiosk still answers", async ({
    request,
    baseURL,
  }) => {
    // The kiosk files belong to Lane L-D. This lane only PROVES the gap and
    // reports it; it changes nothing under app/kiosk or app/api/kiosk.
    const token = `${RUN_STAMP}kiosktok${Math.random().toString(36).slice(2, 8)}`;
    const { createHmac } = await import("node:crypto");
    const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
    const tokenHash = createHmac("sha256", secret).update(token).digest("hex");
    await sql('UPDATE "Tenant" SET "kioskTokenHash" = $1 WHERE id = $2', [
      tokenHash,
      club.id,
    ]).catch(() => {});
    await setState("suspended", false);
    try {
      const res = await request.get(`/api/kiosk/${token}/members?q=ca`, {
        headers: { Origin: origin(baseURL) },
      });
      // If this answers 200 while the club is suspended, the kiosk admits a
      // club the front door refuses. Recorded either way; the grade is in the
      // report and the fix belongs to L-D.
      expect(res.status(), `kiosk members on a suspended club (observed ${res.status()})`).toBeGreaterThanOrEqual(
        400,
      );
    } finally {
      await setState("trial", false);
      await sql('UPDATE "Tenant" SET "kioskTokenHash" = NULL WHERE id = $1', [
        club.id,
      ]).catch(() => {});
    }
  });

  test("J10 — GET /api/tenant/[slug] for a soft-deleted club", async ({ request, baseURL }) => {
    await setState("trial", true);
    try {
      const res = await request.get(`/api/tenant/${club.slug}`, { headers: { Origin: origin(baseURL) } });
      // A soft-deleted club must not be resolvable by a stranger — a 200 here
      // leaks the club's name and branding after it has been closed.
      expect(res.status(), "a soft-deleted club's public tenant lookup").toBeGreaterThanOrEqual(400);
    } finally {
      await setState("trial", false);
    }
  });

  test("J10 — an unknown slug answers exactly like a soft-deleted one (no enumeration)", async ({
    request,
    baseURL,
  }) => {
    const o = origin(baseURL);
    await setState("trial", true);
    const deleted = await request.get(`/api/tenant/${club.slug}`, { headers: { Origin: o } });
    await setState("trial", false);
    const missing = await request.get(`/api/tenant/${RUN_STAMP}-does-not-exist`, { headers: { Origin: o } });
    expect(
      [deleted.status(), missing.status()],
      "a closed club and a club that never existed must answer identically",
    ).toEqual([missing.status(), missing.status()]);
  });
});
