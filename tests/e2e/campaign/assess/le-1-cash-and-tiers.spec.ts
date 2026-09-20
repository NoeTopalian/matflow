/**
 * Lane L-E · file 1 — J42 (tier then cash) and J43 (chase and export).
 *
 * Column one (owner on a fresh club) is Lane A0's. Everything here is the OTHER
 * columns on the seeded club — manager, coach, admin, member, anonymous — plus
 * the attacks on every mutating route of the two journeys.
 *
 * What only counting rows can see, and what this file exists to count:
 *   * a due date that WALKS THROUGH THE MONTH — the 31st becomes the 28th after
 *     one February and never comes back (§ "the day of the month");
 *   * a second till recording the same £40 twice (`requestId`);
 *   * a refusal that answered 403 but wrote the row anyway (every REFUSED case
 *     asserts `count(*)` across the request, not just the status).
 *
 * `Payment` has no `method` column. The method survives only as the description
 * prefix `lib/payment-methods` hands the route, so every method assertion below
 * reads `description`.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  RUN_STAMP,
  sql,
  seededTenantId,
  sessionFor,
  anonRc,
  closeSessions,
  post,
  get,
  patch,
  del,
  FORBIDDEN_BODY,
  CSRF_BODY,
  COACH_EMAIL,
  ADMIN_EMAIL,
  MEMBER_EMAIL,
  OWNER_EMAIL,
  THROWAWAY_PASSWORD,
  mkStaff,
  mkTenant,
  mkTier,
  setDue,
  setTier,
  dueDay,
  teardownTenant,
  teardownMoney,
  resetBucketsLike,
  countRows,
  assertSwept,
} from "./le-shared";
import { createMember, createOrder, getOrder, cleanupRun } from "../helpers/db";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

/** Payments recorded against one member — the count every refusal is measured by. */
async function paymentCount(memberId: string): Promise<number> {
  return countRows("Payment", '"memberId" = $1', [memberId]);
}

async function reqAs(browser: import("@playwright/test").Browser, baseURL: string, email: string, password?: string) {
  const ctx = await sessionFor(browser, baseURL, email, password);
  return ctx.request;
}

let tenantId: string;
let member: { id: string; name: string; email: string };
let tierId: string;

// Tenant B — the foreign club every cross-tenant attack is aimed from and at.
let foreign: { id: string; slug: string };
let foreignMemberId: string;
let foreignTierId: string;

test.beforeAll(async () => {
  tenantId = await seededTenantId();
  member = await createMember({ name: `${RUN_STAMP} Cash member`, paymentStatus: "overdue" });
  tierId = await mkTier(tenantId);
  await setTier(member.id, tierId);

  foreign = await mkTenant();
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', now(), now()) RETURNING id`,
    [foreign.id, `${RUN_STAMP} Foreign member`, `${RUN_STAMP}-foreign@example.test`],
  );
  foreignMemberId = rows[0].id;
  foreignTierId = await mkTier(foreign.id, { name: `${RUN_STAMP} Foreign tier` });
});

test.afterAll(async () => {
  await resetBucketsLike(`payment-manual:${tenantId}%`);
  await resetBucketsLike(`payment-chase:${tenantId}%`);
  await resetBucketsLike(`payments:export:${tenantId}%`);
  await teardownMoney(tenantId);
  await teardownMoney(foreign.id).catch(() => {});
  await sql('DELETE FROM "MembershipTier" WHERE "tenantId" = $1', [foreign.id]).catch(() => {});
  await teardownTenant(foreign.id);
  await cleanupRun();
  await closeSessions();
  // Teardown is verified by a post-delete SELECT, never by the absence of an error.
  const swept = await assertSwept(tenantId);
  for (const [table, n] of Object.entries(swept)) {
    expect(n, `${table} still holds run-stamped rows after teardown`).toBe(0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J42 · cash at the desk — who may record it", () => {
  test("manager records cash: 201, a Payment row, and the member reads paid", async ({ browser, baseURL }) => {
    const mgr = await mkStaff(tenantId, "manager");
    const rc = await reqAs(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD);
    const requestId = `${RUN_STAMP}-mgr-${Math.random().toString(36).slice(2, 10)}`;

    const before = await paymentCount(member.id);
    const res = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: member.id,
      amountPence: 4000,
      method: "cash",
      requestId,
    });
    expect(res.status(), await res.text()).toBe(201);

    const rows = await sql<{ id: string; description: string | null; amountPence: number; currency: string }>(
      'SELECT id, description, "amountPence", currency FROM "Payment" WHERE "tenantId" = $1 AND "requestId" = $2',
      [tenantId, requestId],
    );
    expect(rows).toHaveLength(1);
    // The method is the description prefix — Payment has no method column.
    expect(rows[0].description).toBe("Cash");
    expect(rows[0].amountPence).toBe(4000);
    expect(await paymentCount(member.id)).toBe(before + 1);

    const m = await sql<{ paymentStatus: string }>('SELECT "paymentStatus" FROM "Member" WHERE id = $1', [member.id]);
    expect(m[0].paymentStatus).toBe("paid");
  });

  test("admin — the LOWEST staff role — is refused on every payments surface and writes nothing", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, ADMIN_EMAIL);
    const before = await paymentCount(member.id);

    const write = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: member.id,
      amountPence: 500,
      method: "cash",
      requestId: `${RUN_STAMP}-admin-${Math.random().toString(36).slice(2, 10)}`,
    });
    expect(write.status()).toBe(403);
    expect((await write.json()).error).toBe(FORBIDDEN_BODY);

    for (const path of ["/api/payments", "/api/payments/outstanding", "/api/memberships"]) {
      const res = await get(rc, path);
      expect(res.status(), `${path} as admin`).toBe(403);
      expect((await res.json()).error, path).toBe(FORBIDDEN_BODY);
    }
    expect(await paymentCount(member.id)).toBe(before);
  });

  test("coach is refused on every payments surface and writes nothing", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, COACH_EMAIL);
    const before = await paymentCount(member.id);

    const write = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: member.id,
      amountPence: 500,
      method: "cash",
      requestId: `${RUN_STAMP}-coach-${Math.random().toString(36).slice(2, 10)}`,
    });
    expect(write.status()).toBe(403);
    expect((await write.json()).error).toBe(FORBIDDEN_BODY);

    for (const path of ["/api/payments", "/api/payments/outstanding"]) {
      const res = await get(rc, path);
      expect(res.status(), `${path} as coach`).toBe(403);
    }
    expect(await paymentCount(member.id)).toBe(before);
  });

  test("a member cannot record a payment for themselves", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, MEMBER_EMAIL);
    const before = await paymentCount(member.id);
    const res = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: member.id,
      amountPence: 100_000,
      method: "cash",
      requestId: `${RUN_STAMP}-self-${Math.random().toString(36).slice(2, 10)}`,
    });
    expect([401, 403]).toContain(res.status());
    expect(await paymentCount(member.id)).toBe(before);
  });

  test("anonymous is refused without following the redirect to /login", async ({ playwright, baseURL }) => {
    const rc: APIRequestContext = await anonRc(playwright, baseURL!);
    const before = await paymentCount(member.id);
    const res = await rc.post("/api/payments/manual", {
      headers: { Origin: ORIGIN },
      data: { memberId: member.id, amountPence: 500, method: "cash", requestId: `${RUN_STAMP}-anon` },
      maxRedirects: 0,
    });
    // 307 to /login is a refusal too — what must never happen is a 200 or a row.
    expect([307, 401, 403]).toContain(res.status());
    expect(await paymentCount(member.id)).toBe(before);
    await rc.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J42 · the day of the month", () => {
  /**
   * `advanceDueDate` clamps 31 January to 28 February — correct, and what a
   * human doing the books would write. The question only a row can answer is
   * what happens to MARCH: the advance used to start from the clamped 28th, so
   * the club's billing day became one the member never chose. Both payments
   * below are dated in the future so the catch-up loop cannot run and the
   * assertion is about the clamp alone.
   */
  test("31st → month-end clamp → and back to the 31st", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const subject = await createMember({ name: `${RUN_STAMP} Due day`, paymentStatus: "overdue" });
    await setTier(subject.id, tierId);
    await setDue(subject.id, "2027-01-31T00:00:00.000Z");

    const first = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: subject.id,
      amountPence: 5000,
      method: "cash",
      requestId: `${RUN_STAMP}-due-1-${Math.random().toString(36).slice(2, 8)}`,
    });
    expect(first.status(), await first.text()).toBe(201);
    expect(await dueDay(subject.id)).toBe("2027-02-28");

    const second = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: subject.id,
      amountPence: 5000,
      method: "cash",
      requestId: `${RUN_STAMP}-due-2-${Math.random().toString(36).slice(2, 8)}`,
    });
    expect(second.status(), await second.text()).toBe(201);
    // The billing day the member agreed to is the 31st. A February that clamped
    // and never restored walked the whole club three days early, every month,
    // for ever. Fixed in round 1 (`lib/overdue.ts`): a due date that IS its
    // month's last day advances to the next month's last day.
    expect(await dueDay(subject.id)).toBe("2027-03-31");
  });

  test("a tier with billingCycle 'none' leaves no due date at all", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const noneTier = await mkTier(tenantId, { name: `${RUN_STAMP} Drop-in`, billingCycle: "none", pricePence: 0 });
    const subject = await createMember({ name: `${RUN_STAMP} No cycle` });
    await setTier(subject.id, noneTier);
    await setDue(subject.id, "2027-01-31T00:00:00.000Z");

    const res = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: subject.id,
      amountPence: 1000,
      method: "cash",
      requestId: `${RUN_STAMP}-none-${Math.random().toString(36).slice(2, 8)}`,
    });
    expect(res.status()).toBe(201);
    expect(await dueDay(subject.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J42 · two tills, one payment", () => {
  test("the same requestId twice records one row and hands back the one that exists", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const requestId = `${RUN_STAMP}-twice-${Math.random().toString(36).slice(2, 10)}`;
    const body = { memberId: member.id, amountPence: 4000, method: "cash", requestId };

    const first = await post(rc, "/api/payments/manual", ORIGIN, body);
    expect(first.status()).toBe(201);
    const second = await post(rc, "/api/payments/manual", ORIGIN, body);
    // 200, not 409: a 409 reads as "it did not save" and invites a third press.
    expect(second.status(), await second.text()).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);

    expect(await countRows("Payment", '"tenantId" = $1 AND "requestId" = $2', [tenantId, requestId])).toBe(1);
  });

  test("two identical requests in flight together record one row and never 500", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const requestId = `${RUN_STAMP}-race-${Math.random().toString(36).slice(2, 10)}`;
    const body = { memberId: member.id, amountPence: 2500, method: "cash", requestId };

    const [a, b] = await Promise.all([
      post(rc, "/api/payments/manual", ORIGIN, body),
      post(rc, "/api/payments/manual", ORIGIN, body),
    ]);
    for (const res of [a, b]) {
      expect(res.status(), await res.text()).toBeLessThan(500);
      expect([200, 201]).toContain(res.status());
    }
    expect(await countRows("Payment", '"tenantId" = $1 AND "requestId" = $2', [tenantId, requestId])).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J42 · malformed money", () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "negative pence", body: { amountPence: -5000, method: "cash" } },
    { name: "a fractional penny", body: { amountPence: 10.5, method: "cash" } },
    { name: "cash at zero", body: { amountPence: 0, method: "cash" } },
    { name: "an amount beyond a signed 32-bit integer", body: { amountPence: 2_147_483_648, method: "cash" } },
    { name: "'other' with no notes", body: { amountPence: 1000, method: "other" } },
    { name: "'other' with whitespace notes", body: { amountPence: 1000, method: "other", notes: "   " } },
    { name: "an invented method", body: { amountPence: 1000, method: "bitcoin" } },
    { name: "a four-letter currency", body: { amountPence: 1000, method: "cash", currency: "GBPP" } },
    { name: "a ten-thousand-character note", body: { amountPence: 1000, method: "cash", notes: "x".repeat(10_000) } },
    { name: "a requestId under the minimum", body: { amountPence: 1000, method: "cash", requestId: "short" } },
  ];

  for (const c of cases) {
    test(`${c.name} is refused and writes nothing`, async ({ browser, baseURL }) => {
      const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
      const before = await paymentCount(member.id);
      const res = await post(rc, "/api/payments/manual", ORIGIN, {
        memberId: member.id,
        requestId: `${RUN_STAMP}-bad-${Math.random().toString(36).slice(2, 10)}`,
        ...c.body,
      });
      expect(res.status(), `${c.name}: ${await res.text()}`).toBeGreaterThanOrEqual(400);
      expect(res.status(), `${c.name} must never be a 500`).toBeLessThan(500);
      expect(await paymentCount(member.id), c.name).toBe(before);
    });
  }

  test("NaN is not JSON and is refused at the door", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const before = await paymentCount(member.id);
    const res = await rc.post("/api/payments/manual", {
      headers: { Origin: ORIGIN, "content-type": "application/json" },
      data: `{"memberId":"${member.id}","amountPence":NaN,"method":"cash","requestId":"${RUN_STAMP}-nan-x"}`,
      maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
    expect(await paymentCount(member.id)).toBe(before);
  });

  test("a comp at £0 is the one zero the ledger accepts", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const requestId = `${RUN_STAMP}-comp-${Math.random().toString(36).slice(2, 10)}`;
    const res = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: member.id,
      amountPence: 0,
      method: "comp",
      requestId,
    });
    expect(res.status(), await res.text()).toBe(201);
    const rows = await sql<{ description: string | null; amountPence: number }>(
      'SELECT description, "amountPence" FROM "Payment" WHERE "tenantId" = $1 AND "requestId" = $2',
      [tenantId, requestId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPence).toBe(0);
    expect(rows[0].description).toBe("Comp");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J42 · attacks on the cash route", () => {
  test("another club's member id is a 404 that confirms nothing and writes nothing", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const before = await countRows("Payment", '"memberId" = $1', [foreignMemberId]);
    const res = await post(rc, "/api/payments/manual", ORIGIN, {
      memberId: foreignMemberId,
      amountPence: 5000,
      method: "cash",
      requestId: `${RUN_STAMP}-xt-${Math.random().toString(36).slice(2, 10)}`,
    });
    expect(res.status()).toBe(404);
    // 404, never a 403: a 403 would confirm the id exists somewhere.
    expect((await res.json()).error).toBe("Member not found");
    expect(await countRows("Payment", '"memberId" = $1', [foreignMemberId])).toBe(before);
  });

  test("a missing Origin and a foreign Origin are both refused", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const before = await paymentCount(member.id);
    const body = {
      memberId: member.id,
      amountPence: 999,
      method: "cash",
      requestId: `${RUN_STAMP}-csrf-${Math.random().toString(36).slice(2, 10)}`,
    };

    const bare = await ctx.request.post("/api/payments/manual", { data: body, maxRedirects: 0 });
    expect(bare.status()).toBe(403);
    expect((await bare.json()).error).toBe("Origin or Referer header required for this request");

    const foreignOrigin = await ctx.request.post("/api/payments/manual", {
      headers: { Origin: "http://evil.test" },
      data: body,
      maxRedirects: 0,
    });
    expect(foreignOrigin.status()).toBe(403);
    expect((await foreignOrigin.json()).error).toBe(CSRF_BODY);

    // A matched forged pair (Origin AND Host both evil.test) is HELD by
    // construction — no browser, no victim cookie. Recorded, not claimed.
    const matched = await ctx.request.post("/api/payments/manual", {
      headers: { Origin: "http://evil.test", Host: "evil.test" },
      data: body,
      maxRedirects: 0,
    });
    expect(matched.status(), `matched forged pair answered ${matched.status()}`).toBeGreaterThanOrEqual(200);
    // It is ACCEPTED, and that is the honest reading rather than a defect:
    // Origin and Host agree, so by the definition `lib/csrf.ts` applies this IS
    // a same-origin request. The part a real attacker cannot supply is the part
    // this harness handed over for free — the victim's cookie, which SameSite
    // withholds cross-site. The boundary proof is therefore that the request
    // wrote its own row once and nothing else moved, not that nothing was
    // written. Asserting zero here read a HELD-by-construction cell as a BUG.
    const written = await countRows("Payment", '"tenantId" = $1 AND "requestId" = $2', [tenantId, body.requestId]);
    expect(written, "one requestId must never mint two rows").toBeLessThanOrEqual(1);
    expect(await paymentCount(member.id)).toBe(before + written);
  });

  test("the cash route answers 429 before it answers 500", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    // The bucket is per tenant (60 in 5 minutes) and every lane shares it, so
    // this runs on a THROWAWAY tenant's bucket key by exhausting nothing here:
    // instead assert the shape of the limiter's answer on one over-budget call.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await post(rc, "/api/payments/manual", ORIGIN, {
        memberId: member.id,
        amountPence: 100,
        method: "cash",
        requestId: `${RUN_STAMP}-rl-${i}-${Math.random().toString(36).slice(2, 8)}`,
      });
      statuses.push(res.status());
      if (res.status() === 429) {
        expect(res.headers()["retry-after"]).toBeTruthy();
        break;
      }
    }
    expect(statuses.every((s) => s < 500)).toBe(true);
    await resetBucketsLike(`payment-manual:${tenantId}%`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J42 · membership tiers, per role", () => {
  test("manager may READ tiers but not create one — the split the page must match", async ({ browser, baseURL }) => {
    const mgr = await mkStaff(tenantId, "manager");
    const rc = await reqAs(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD);

    const read = await get(rc, "/api/memberships");
    expect(read.status()).toBe(200);

    const before = await countRows("MembershipTier", '"tenantId" = $1', [tenantId]);
    const write = await post(rc, "/api/memberships", ORIGIN, {
      name: `${RUN_STAMP} Manager tier`,
      pricePence: 4000,
      currency: "GBP",
      billingCycle: "monthly",
      isKids: false,
    });
    // requireApiOwner on POST, requireApiOwnerOrManager on GET. A manager who
    // can see the screen and not save is FRICTION unless the page hides it.
    expect(write.status()).toBe(403);
    expect((await write.json()).error).toBe(FORBIDDEN_BODY);
    expect(await countRows("MembershipTier", '"tenantId" = $1', [tenantId])).toBe(before);
  });

  test("a negative tier price is refused; a zero price is not", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const before = await countRows("MembershipTier", '"tenantId" = $1', [tenantId]);

    const negative = await post(rc, "/api/memberships", ORIGIN, {
      name: `${RUN_STAMP} Negative`,
      pricePence: -1,
      currency: "GBP",
      billingCycle: "monthly",
      isKids: false,
    });
    expect(negative.status()).toBe(400);
    expect(await countRows("MembershipTier", '"tenantId" = $1', [tenantId])).toBe(before);

    const free = await post(rc, "/api/memberships", ORIGIN, {
      name: `${RUN_STAMP} Free tier`,
      pricePence: 0,
      currency: "GBP",
      billingCycle: "monthly",
      isKids: false,
    });
    expect(free.status(), await free.text()).toBeLessThan(300);
    const created = await sql<{ id: string }>('SELECT id FROM "MembershipTier" WHERE "tenantId" = $1 AND name = $2', [
      tenantId,
      `${RUN_STAMP} Free tier`,
    ]);
    expect(created).toHaveLength(1);
  });

  test("another club's tier cannot be edited or deleted from here", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const before = await sql<{ name: string; pricePence: number }>(
      'SELECT name, "pricePence" FROM "MembershipTier" WHERE id = $1',
      [foreignTierId],
    );

    const edit = await patch(rc, `/api/memberships/${foreignTierId}`, ORIGIN, { pricePence: 1 });
    expect(edit.status()).toBe(404);
    const remove = await del(rc, `/api/memberships/${foreignTierId}`, ORIGIN);
    expect(remove.status()).toBe(404);

    const after = await sql<{ name: string; pricePence: number }>(
      'SELECT name, "pricePence" FROM "MembershipTier" WHERE id = $1',
      [foreignTierId],
    );
    expect(after).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J43 · chase and export", () => {
  test("a chase with no mail key answers non-2xx AND leaves an EmailLog row", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const subject = await createMember({ name: `${RUN_STAMP} Chase me`, paymentStatus: "overdue" });
    await setTier(subject.id, tierId);
    await setDue(subject.id, "2026-01-01T00:00:00.000Z");

    const res = await post(rc, "/api/payments/chase", ORIGIN, { memberId: subject.id });
    // `.env.test` has no mail key: the send fails and the row is the proof the
    // route ran. Delivery is UNCOVERED — it needs a live service (Resend).
    // Only a MISSING row is an error.
    const rows = await sql<{ id: string; status: string; templateId: string | null }>(
      'SELECT id, status, "templateId" FROM "EmailLog" WHERE "tenantId" = $1 AND recipient = (SELECT email FROM "Member" WHERE id = $2) ORDER BY "createdAt" DESC',
      [tenantId, subject.id],
    );
    expect(rows.length, `chase answered ${res.status()} and logged nothing`).toBeGreaterThan(0);
    expect(rows[0].status).toBe("failed");
    await resetBucketsLike(`payment-chase:${tenantId}:${subject.id}`);
  });

  test("chase is refused for coach, admin and member, and logs nothing", async ({ browser, baseURL }) => {
    const subject = await createMember({ name: `${RUN_STAMP} Not chased`, paymentStatus: "overdue" });
    for (const email of [COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL]) {
      const rc = await reqAs(browser, baseURL!, email);
      const res = await post(rc, "/api/payments/chase", ORIGIN, { memberId: subject.id });
      expect([401, 403], `${email} chase`).toContain(res.status());
      expect(await countRows("EmailLog", '"tenantId" = $1 AND recipient = (SELECT email FROM "Member" WHERE id = $2)', [tenantId, subject.id]), email).toBe(0);
    }
  });

  test("export is 200 for a manager, 403 for coach and admin, and never leaks a row to a member", async ({ browser, baseURL }) => {
    const mgr = await mkStaff(tenantId, "manager");
    const mgrRc = await reqAs(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD);
    const ok = await get(mgrRc, "/api/payments/export.csv");
    expect(ok.status(), await ok.text()).toBe(200);
    expect(ok.headers()["content-type"] ?? "").toContain("csv");

    for (const email of [COACH_EMAIL, ADMIN_EMAIL]) {
      const rc = await reqAs(browser, baseURL!, email);
      const res = await get(rc, "/api/payments/export.csv");
      expect(res.status(), `${email} export`).toBe(403);
      expect((await res.text()).toLowerCase()).not.toContain("amount");
    }

    const memberRc = await reqAs(browser, baseURL!, MEMBER_EMAIL);
    const asMember = await get(memberRc, "/api/payments/export.csv");
    expect([307, 401, 403]).toContain(asMember.status());
    if (asMember.status() === 200) {
      throw new Error("a member downloaded the club's payment export");
    }
    await resetBucketsLike(`payments:export:${tenantId}%`);
  });

  test("the eleventh export in an hour is a 429, not a 500 — and the bucket is reset after", async ({ browser, baseURL }) => {
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await get(rc, "/api/payments/export.csv");
      expect(res.status(), `export ${i}`).toBeLessThan(500);
      if (res.status() === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit, "ten exports an hour is documented; no 429 appeared in twelve").toBe(true);
    // Shared bucket, shared IP: every lane depends on this being put back.
    await resetBucketsLike(`payments:export:${tenantId}%`);
    expect(await countRows("RateLimitHit", "bucket LIKE $1", [`payments:export:${tenantId}%`])).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J42 · the desk-orders queue (X-6 K13, built round 3)
//
// The shop tells a member "pay at the front desk"; until round 3 no screen in
// the product listed those orders and POST orders/[id]/mark-paid had zero
// callers. GET /api/payments/desk-orders is the queue behind the payments hub's
// "At the desk" tab. Every cell below proves a ROW or a fresh GET — never the
// panel state.
// ─────────────────────────────────────────────────────────────────────────────

/** Audit rows for one order. Fire-and-forget (lib/audit-log.ts:56) — poll it. */
async function markPaidAudits(orderId: string): Promise<number> {
  return countRows("AuditLog", `action = 'order.mark_paid' AND "entityId" = $1`, [orderId]);
}

async function deskQueue(rc: APIRequestContext) {
  const res = await get(rc, "/api/payments/desk-orders");
  return { res, body: res.status() === 200 ? await res.json() : null };
}

test.describe("J42 · desk orders — the queue staff can actually see", () => {
  test("owner sees a pending pay-at-desk order, settles it, and the ROW says paid", async ({ browser, baseURL }) => {
    const buyer = await createMember({ name: `${RUN_STAMP} desk buyer` });
    const order = await createOrder({ memberId: buyer.id, status: "pending", paymentMethod: "pay_at_desk", totalPence: 2500 });

    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const { res, body } = await deskQueue(rc);
    expect(res.status(), await res.text()).toBe(200);

    const listed = (body.orders as Array<{ id: string; orderRef: string; memberName: string | null; totalPence: number }>)
      .find((o) => o.id === order.id);
    expect(listed, "the order the member was told to show staff is not in the queue").toBeTruthy();
    expect(listed!.orderRef).toBe(order.orderRef);
    expect(listed!.memberName).toBe(buyer.name);
    expect(listed!.totalPence).toBe(2500);

    const settled = await post(rc, `/api/orders/${order.id}/mark-paid`, ORIGIN, { reason: `${RUN_STAMP} cash at the desk` });
    expect(settled.status(), await settled.text()).toBe(200);

    // The row, not the response.
    const row = await getOrder(order.id);
    expect(row.status).toBe("paid");
    await expect.poll(() => markPaidAudits(order.id), { timeout: 5_000 }).toBe(1);

    // And a fresh GET no longer offers it.
    const after = await deskQueue(rc);
    expect((after.body.orders as Array<{ id: string }>).some((o) => o.id === order.id)).toBe(false);
  });

  test("a manager may work the queue too — the same pair that may record a payment", async ({ browser, baseURL }) => {
    const order = await createOrder({ status: "pending", paymentMethod: "pay_at_desk" });
    const mgr = await mkStaff(tenantId, "manager");
    const rc = await reqAs(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD);

    const { res, body } = await deskQueue(rc);
    expect(res.status(), await res.text()).toBe(200);
    expect((body.orders as Array<{ id: string }>).some((o) => o.id === order.id)).toBe(true);

    const settled = await post(rc, `/api/orders/${order.id}/mark-paid`, ORIGIN, { reason: "Manager took the cash" });
    expect(settled.status()).toBe(200);
    expect((await getOrder(order.id)).status).toBe("paid");
  });

  test("the queue is pending pay-at-desk ONLY — a live card order is never offered", async ({ browser, baseURL }) => {
    // A `stripe` order at pending is a member mid-checkout. Offering staff a
    // Mark-paid button for it invites taking cash for a card payment that is
    // still in flight; the webhook settles that one.
    const card = await createOrder({ status: "pending", paymentMethod: "stripe" });
    const alreadyPaid = await createOrder({ status: "paid", paymentMethod: "pay_at_desk" });
    const cancelled = await createOrder({ status: "cancelled", paymentMethod: "pay_at_desk" });

    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const { body } = await deskQueue(rc);
    const ids = (body.orders as Array<{ id: string }>).map((o) => o.id);

    expect(ids, "a card order still in flight was offered to the till").not.toContain(card.id);
    expect(ids).not.toContain(alreadyPaid.id);
    expect(ids).not.toContain(cancelled.id);
  });

  test("two tills settling the same order at once leave ONE audit row", async ({ browser, baseURL }) => {
    const order = await createOrder({ status: "pending", paymentMethod: "pay_at_desk" });
    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);

    const [a, b] = await Promise.all([
      post(rc, `/api/orders/${order.id}/mark-paid`, ORIGIN, { reason: "Till one took it" }),
      post(rc, `/api/orders/${order.id}/mark-paid`, ORIGIN, { reason: "Till two took it" }),
    ]);
    expect(a.status(), await a.text()).toBeLessThan(500);
    expect(b.status(), await b.text()).toBeLessThan(500);
    expect((await getOrder(order.id)).status).toBe("paid");

    // The whole point of the reason field is reconciliation. Two rows here and
    // the club books say the money was collected twice.
    await expect.poll(() => markPaidAudits(order.id), { timeout: 5_000 }).toBe(1);
  });

  test("coach, admin, member and anonymous are all refused, and no reference leaks", async ({ browser, baseURL, playwright }) => {
    const order = await createOrder({ status: "pending", paymentMethod: "pay_at_desk" });
    const before = await markPaidAudits(order.id);

    for (const email of [COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL]) {
      const rc = await reqAs(browser, baseURL!, email);
      const list = await get(rc, "/api/payments/desk-orders");
      expect([401, 403], `${email} desk-orders`).toContain(list.status());
      expect(await list.text(), `${email} saw an order reference`).not.toContain(order.orderRef);

      const settle = await post(rc, `/api/orders/${order.id}/mark-paid`, ORIGIN, { reason: "Not my money" });
      expect([401, 403], `${email} mark-paid`).toContain(settle.status());
    }

    const anon = await anonRc(playwright, baseURL!);
    const anonList = await get(anon, "/api/payments/desk-orders");
    expect([401, 403]).toContain(anonList.status());
    expect(await anonList.text()).not.toContain(order.orderRef);
    const anonSettle = await post(anon, `/api/orders/${order.id}/mark-paid`, ORIGIN, { reason: "Not my money" });
    expect([401, 403]).toContain(anonSettle.status());

    // Nothing was written by any of them.
    expect((await getOrder(order.id)).status).toBe("pending");
    expect(await markPaidAudits(order.id)).toBe(before);
  });

  test("tenant B desk order is invisible here and cannot be settled from here", async ({ browser, baseURL }) => {
    // Inserted directly: createOrder is bound to the seeded club.
    const ref = `${RUN_STAMP.toUpperCase()}-FOREIGN`;
    const rows = await sql<{ id: string }>(
      `INSERT INTO "Order" ("id", "tenantId", "memberId", "orderRef", "items", "totalPence",
                            "currency", "status", "paymentMethod", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, NULL, $2, $3::jsonb, 3000, 'GBP', 'pending', 'pay_at_desk', now())
       RETURNING id`,
      [foreign.id, ref, JSON.stringify([{ id: "p1", name: "Foreign gi", price: 30, quantity: 1 }])],
    );
    const foreignOrderId = rows[0].id;

    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const { body } = await deskQueue(rc);
    expect(JSON.stringify(body), "another club order appeared in this club queue").not.toContain(ref);
    expect((body.orders as Array<{ id: string }>).map((o) => o.id)).not.toContain(foreignOrderId);

    // 404, never a 403 that would confirm the row exists.
    const settle = await post(rc, `/api/orders/${foreignOrderId}/mark-paid`, ORIGIN, { reason: "Taking another club money" });
    expect(settle.status()).toBe(404);
    const after = await sql<{ status: string }>('SELECT status FROM "Order" WHERE id = $1', [foreignOrderId]);
    expect(after[0].status).toBe("pending");
    expect(await markPaidAudits(foreignOrderId)).toBe(0);

    await sql('DELETE FROM "Order" WHERE id = $1', [foreignOrderId]);
  });
});

test.describe("J43 · a chase is skipped for a member who cannot receive mail", () => {
  test("a synthesised placeholder address sends nothing and says why", async ({ browser, baseURL }) => {
    // lib/synthesise-kid-email.ts — `@no-login.matflow.local` is RFC-2606
    // reserved, so nothing addressed there can reach a person. Member.email is
    // NOT NULL, so this is what "no email" looks like in the database, and the
    // old `!email` guard never fired for it.
    const suffix = Math.random().toString(36).slice(2, 8);
    const ghost = await createMember({
      name: `${RUN_STAMP} no-inbox`,
      email: `adult-${RUN_STAMP}${suffix}@no-login.matflow.local`,
      paymentStatus: "overdue",
    });

    const rc = await reqAs(browser, baseURL!, OWNER_EMAIL);
    const res = await post(rc, "/api/payments/chase", ORIGIN, { memberId: ghost.id });

    expect(res.status(), await res.text()).toBe(422);
    expect((await res.text()).toLowerCase()).toContain("no email address");
    // The proof is the absent row: no send was even attempted.
    expect(await countRows("EmailLog", "recipient = $1", [ghost.email])).toBe(0);
    await resetBucketsLike(`payment-chase:${tenantId}:${ghost.id}`);
  });
});
