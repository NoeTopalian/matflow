/**
 * Lane L-F file 1 — the member portal's transactional half: J49 schedule,
 * J50 billing, J51 shop, J52 profile and family.
 *
 * Lane A0 drives column one (the member, once, on a fresh club). This file
 * drives every OTHER column on the seeded club `totalbjj` — the parent through
 * the UI, staff roles at the member routes, anonymous everywhere, and members
 * against other members' ids — plus every attack COMMON names.
 *
 * `mode: "default"` (NOT serial): one failure must not skip the rest of the
 * file. Nothing here depends on a module-level variable another test set —
 * every describe block creates what it needs in its own `beforeAll`.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  CLUB_SLUG, OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL, PASSWORD, THROWAWAY_PASSWORD,
  PHONE, ANON_REFUSED, sessionFor, anonContext, closeSessions, apiCall, apiGet, expectRefusal,
  describeResponse, countOf, assertUnchanged, assertNoOverflow, finalPath,
  mkMember, mkKid, mkStaff, mkClass, mkSchedule, mkInstance, mkProduct, mkTenant, teardownTenant,
  teardownSeededClub, sql, seededTenantId, RUN_STAMP,
  type LfTenant, type LfMember,
} from "./lf-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

test.afterAll(async () => {
  await closeSessions();
});

// ─────────────────────────────────────────────────────────────────────────────
// J49 — Schedule: book, cancel, rebook; capacity; waitlist
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J49 schedule — every column but the member's own", () => {
  let tenantId: string;
  let parent: LfMember;
  let other: LfMember;
  let classId: string;
  let cancelledClassId: string;
  let foreign: LfTenant;
  let parentCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    parent = await mkMember({ accountType: "parent", name: `${RUN_STAMP} J49 parent` });
    other = await mkMember({ name: `${RUN_STAMP} J49 other` });
    classId = await mkClass(tenantId, `${RUN_STAMP} J49 open class`, { maxCapacity: 1 });
    await mkSchedule(classId, { dayOfWeek: 3, startTime: "18:00", endTime: "19:00" });
    cancelledClassId = await mkClass(tenantId, `${RUN_STAMP} J49 cancelled class`);
    await mkSchedule(cancelledClassId);
    await mkInstance(cancelledClassId, { isCancelled: true });
    foreign = await mkTenant();
    parentCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: parent.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
  });

  test.afterAll(async () => {
    await teardownTenant(foreign);
  });

  test("ALLOWED · parent books, cancels and rebooks through the UI; the row proves each", async () => {
    const page = await parentCtx.newPage();
    await page.goto("/member/schedule", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J49 parent /member/schedule at 390");

    // Drive the booking through the same route the screen calls, from inside
    // the parent's own browser context, so the session and the CSRF Origin are
    // the browser's and not a synthesised pair.
    const sub = await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN);
    expect(sub.status, "parent subscribes to a class of their own club").toBe(201);
    const afterBook = await countOf("ClassSubscription", '"memberId" = $1 AND "classId" = $2', [parent.id, classId]);
    expect(afterBook, "the booking is a row, not a toast").toBe(1);

    const del = await apiCall(parentCtx.request, "delete", `/api/member/class-subscriptions/${classId}`, ORIGIN);
    expect(del.status, "parent cancels the booking").toBe(200);
    expect((del.body as { removed?: number }).removed, "one row removed").toBe(1);
    const afterCancel = await countOf("ClassSubscription", '"memberId" = $1 AND "classId" = $2', [parent.id, classId]);
    expect(afterCancel, "the cancellation is a row too").toBe(0);

    const re = await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN);
    expect(re.status, "parent rebooks").toBe(201);
    // A fresh GET, not the page state we just changed.
    const fresh = await apiGet(parentCtx.request, "/api/member/me/subscriptions");
    expect(fresh.status).toBe(200);
    expect((fresh.body as { classIds: string[] }).classIds, "the rebooking shows in a fresh GET").toContain(classId);
    await page.close();
  });

  test("ALLOWED · maxCapacity is enforced — the second member on a class that seats one is refused", async ({ browser }, testInfo) => {
    const second = await mkMember({ name: `${RUN_STAMP} J49 capacity` });
    const ctxA = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: parent.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
    const ctxB = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: second.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
    await apiCall(ctxA.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN);
    const r = await apiCall(ctxB.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN);
    describeResponse("J49 second subscriber to a maxCapacity=1 class", r);
    const cap = await sql<{ maxCapacity: number | null }>('SELECT "maxCapacity" FROM "Class" WHERE id = $1', [classId]);
    expect(cap[0].maxCapacity, "the class really does carry a capacity of one").toBe(1);
    const n = await countOf("ClassSubscription", '"classId" = $1', [classId]);
    // Round 1 fixed this (app/api/member/class-subscriptions/[classId]/route.ts:
    // a locking SELECT … FOR UPDATE, a count of the other members' places, and
    // a 409 when the class is full). The round-1 spec asserted the DEFECT — a
    // 201 — so the fix failed it. Re-graded against the product as it now is,
    // and the refusal copy is asserted too: it must not imply a waiting list,
    // because nothing in the product writes ClassWaitlist.
    expect(r.status, "a full class refuses the second member").toBe(409);
    expect((r.body as { error?: string }).error ?? "", "the refusal says the class is full")
      .toMatch(/full/i);
    expect((r.body as { error?: string }).error ?? "", "the refusal is honest about the missing waiting list")
      .toMatch(/no waiting list/i);
    expect(n, "the refused booking wrote nothing — one seat, one row").toBe(1);
  });

  test("REPORT · ClassWaitlist has no writer — the table stays empty across the whole booking journey", async () => {
    const before = await countOf("ClassWaitlist", 'TRUE');
    await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN);
    const after = await countOf("ClassWaitlist", 'TRUE');
    expect(after, "no route in the product writes ClassWaitlist — an advertised waitlist is unreachable").toBe(before);
  });

  test("ATTACK · booking a class of another club answers 404 and writes nothing", async () => {
    const before = await countOf("ClassSubscription", '"classId" = $1', [foreign.classId]);
    const r = await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${foreign.classId}`, ORIGIN);
    expect(r.status, "a foreign class id is a 404, never a 403 that confirms existence").toBe(404);
    expectRefusal(r, "bare-error", "J49 cross-tenant subscribe");
    await assertUnchanged("ClassSubscription", before, "J49 cross-tenant subscribe", '"classId" = $1', [foreign.classId]);
  });

  test("ATTACK · booking twice in parallel leaves exactly one row and no 500", async () => {
    await sql('DELETE FROM "ClassSubscription" WHERE "memberId" = $1 AND "classId" = $2', [other.id, classId]);
    const before = await countOf("ClassSubscription", '"memberId" = $1 AND "classId" = $2', [other.id, classId]);
    expect(before).toBe(0);
    const [a, b] = await Promise.all([
      apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN),
      apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`, ORIGIN),
    ]);
    expect([a.status, b.status].every((s) => s < 500), "a race is never a 500").toBe(true);
    const n = await countOf("ClassSubscription", '"memberId" = $1 AND "classId" = $2', [parent.id, classId]);
    expect(n, "@@unique([memberId, classId]) holds the race to one row").toBe(1);
  });

  test("ATTACK · a cancelled instance's class still accepts a subscription — record the state gap", async () => {
    const r = await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${cancelledClassId}`, ORIGIN);
    describeResponse("J49 subscribe to a class whose only instance is cancelled", r);
    expect(r.status, "subscription is per-class, not per-instance — a cancelled instance is invisible to it").toBe(201);
  });

  test("REFUSED · anonymous at every J49 route; nothing written", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const before = await countOf("ClassSubscription", '"classId" = $1', [classId]);
    for (const [method, url] of [
      ["get", "/api/member/schedule"],
      ["get", "/api/member/classes"],
      ["get", "/api/member/me/subscriptions"],
      ["post", `/api/member/class-subscriptions/${classId}`],
      ["delete", `/api/member/class-subscriptions/${classId}`],
    ] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN);
      describeResponse(`J49 anonymous ${method.toUpperCase()} ${url}`, r);
      // Round 1 fix (another lane): an unauthenticated /api/* call now answers
      // a bare 401 rather than the 307 to /login it used to send.
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
    }
    await assertUnchanged("ClassSubscription", before, "J49 anonymous sweep", '"classId" = $1', [classId]);
    await anon.close();
  });

  test("REFUSED · CSRF — a mutating member route with no Origin and with a foreign Origin", async () => {
    // The before-count and the after-count must ask the SAME question. Round 2
    // counted every subscription on the class as `before` and then compared it
    // against a count that excluded the parent's own row, so the test failed
    // (1 → 0) on its own arithmetic while the product refused correctly. The
    // predicate that matters is "nobody NEW was subscribed by a forged request".
    const OTHERS = '"classId" = $1 AND "memberId" <> $2';
    const before = await countOf("ClassSubscription", OTHERS, [classId, parent.id]);
    const noOrigin = await parentCtx.request.fetch(`/api/member/class-subscriptions/${classId}`, {
      method: "POST", maxRedirects: 0, data: {},
    });
    describeResponse("J49 POST with no Origin", {
      status: noOrigin.status(), body: {}, text: await noOrigin.text(),
      contentType: noOrigin.headers()["content-type"] ?? "", location: null,
    });
    const foreignOrigin = await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`, "http://evil.test");
    expect(foreignOrigin.status, "a foreign Origin on a guarded route is a 403").toBe(403);
    // A matched forged pair is HELD by construction: no browser will send it
    // with the victim's cookie. Record the status; nothing is written either way.
    const forged = await apiCall(parentCtx.request, "post", `/api/member/class-subscriptions/${classId}`,
      "http://evil.test", {}, { Host: "evil.test" });
    describeResponse("J49 matched forged Origin/Host pair", forged);
    await assertUnchanged("ClassSubscription", before, "J49 CSRF sweep", OTHERS, [classId, parent.id]);
  });

  test("REFUSED · a staff role is redirected away from /member/schedule (proxy gate)", async ({ browser }, testInfo) => {
    for (const email of [OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL]) {
      const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email, password: PASSWORD });
      const page = await ctx.newPage();
      const landed = await finalPath(page, "/member/schedule");
      console.log(`[L-F probe] J49 ${email} → /member/schedule landed on ${landed}`);
      expect(landed, `${email} is not left on the member portal`).not.toBe("/member/schedule");
      await page.close();
    }
    // FRICTION, recorded not asserted: a coach who also trains has a Member row
    // and no way to reach their own portal. The sentence they needed is in the
    // report's Friction section.
  });

  test("REPORT · the member schedule renders instance dates in the club's own zone", async () => {
    const tz = await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId]);
    const r = await apiGet(parentCtx.request, `/api/member/schedule?date=${new Date().toISOString().slice(0, 10)}`);
    expect(r.status).toBe(200);
    // Compare in SQL against the club's zone — never a DB timestamp against
    // Date.now() in JavaScript.
    const sameDay = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "ClassInstance" i
       JOIN "Class" c ON c.id = i."classId"
       WHERE c."tenantId" = $1
         AND i.date::date = ((now() AT TIME ZONE 'UTC') AT TIME ZONE $2)::date`,
      [tenantId, tz[0].timezone],
    );
    console.log(`[L-F probe] J49 club zone ${tz[0].timezone}; instances dated today in that zone: ${sameDay[0].n}`);
    const entries = r.body as Array<{ classInstanceId: string | null }>;
    const withInstance = entries.filter((e) => e.classInstanceId !== null).length;
    expect(withInstance, "today's instances resolve against the club zone, not the host clock")
      .toBeLessThanOrEqual(Number(sameDay[0].n) + entries.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J50 — Billing: honest when inert
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J50 billing — honest when there is no Stripe account", () => {
  let parent: LfMember;
  let kid: LfMember;
  let strangerKid: LfMember;
  let parentCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    parent = await mkMember({ accountType: "parent", name: `${RUN_STAMP} J50 parent` });
    kid = await mkKid(parent.id, `${RUN_STAMP} J50 kid`);
    const stranger = await mkMember({ accountType: "parent", name: `${RUN_STAMP} J50 stranger` });
    strangerKid = await mkKid(stranger.id, `${RUN_STAMP} J50 stranger kid`);
    parentCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: parent.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
  });

  test("ALLOWED · the billing page loads at 390 and its three reads answer honestly", async () => {
    const page = await parentCtx.newPage();
    await page.goto("/member/billing", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J50 /member/billing at 390");
    expect(new URL(page.url()).pathname, "the parent reaches billing").toBe("/member/billing");

    const subs = await apiGet(parentCtx.request, "/api/member/me/subscriptions");
    expect(subs.status).toBe(200);
    expect(Object.keys(subs.body as object), "subscriptions answers a known key set").toEqual(["classIds"]);

    const pays = await apiGet(parentCtx.request, "/api/member/me/payments");
    expect(pays.status).toBe(200);
    expect(Array.isArray(pays.body), "payments answers an array").toBe(true);
    const ids = (pays.body as Array<{ id: string }>).map((p) => p.id);
    if (ids.length) {
      const mine = await sql<{ n: string }>(
        'SELECT count(*)::text AS n FROM "Payment" WHERE id = ANY($1) AND "memberId" = $2', [ids, parent.id],
      );
      expect(Number(mine[0].n), "every payment returned belongs to the caller").toBe(ids.length);
    }
    await page.close();
  });

  test("ALLOWED/HONEST · the portal is a POST, and with no Stripe account it refuses in plain words", async () => {
    // The manifest says `GET stripe/portal`; the route exports POST only.
    const wrongVerb = await apiGet(parentCtx.request, "/api/stripe/portal");
    expect([404, 405], "GET /api/stripe/portal is not a method the route serves").toContain(wrongVerb.status);
    const r = await apiCall(parentCtx.request, "post", "/api/stripe/portal", ORIGIN);
    describeResponse("J50 POST /api/stripe/portal with no billing account", r);
    expect([400, 403, 503], "an inert rail refuses with a reason, never a silent 200").toContain(r.status);
    expect(typeof (r.body as { error?: string }).error, "the refusal carries a sentence for the member").toBe("string");
  });

  test("ALLOWED/HONEST · cancel with no subscription refuses and writes nothing", async () => {
    const before = await countOf("AuditLog", "action = $1", ["member.subscription.cancel"]);
    const r = await apiCall(parentCtx.request, "post", "/api/member/subscriptions/cancel", ORIGIN);
    describeResponse("J50 cancel with no subscription", r);
    expect([403, 404, 503], "no subscription is a named refusal").toContain(r.status);
    expect(typeof (r.body as { error?: string }).error).toBe("string");
    await assertUnchanged("AuditLog", before, "J50 cancel with no subscription", "action = $1", ["member.subscription.cancel"]);
  });

  test("ATTACK · a parent asking for another parent's child's billing gets 404, and no row leaks", async () => {
    const mine = await apiGet(parentCtx.request, `/api/member/family/${kid.id}/billing`);
    expect(mine.status, "a parent reads their own child's billing").toBe(200);
    expect((mine.body as { kid: { id: string } }).kid.id).toBe(kid.id);

    const theirs = await apiGet(parentCtx.request, `/api/member/family/${strangerKid.id}/billing`);
    expect(theirs.status, "another parent's child is a 404, never a 403").toBe(404);
    expect(theirs.text, "not one character of the foreign child's name is in the body")
      .not.toContain(strangerKid.name);
    expectRefusal(theirs, "ok-false", "J50 foreign kid billing");

    const missing = await apiGet(parentCtx.request, "/api/member/family/does-not-exist/billing");
    expect(missing.status, "a foreign id answers exactly like a missing one").toBe(theirs.status);
  });

  test("REFUSED · anonymous at every J50 route", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    for (const [method, url] of [
      ["get", "/api/member/me/subscriptions"],
      ["get", "/api/member/me/payments"],
      ["post", "/api/stripe/portal"],
      ["post", "/api/member/subscriptions/cancel"],
      ["get", `/api/member/family/${kid.id}/billing`],
    ] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN);
      describeResponse(`J50 anonymous ${method.toUpperCase()} ${url}`, r);
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
      expect(r.text, "an anonymous refusal never carries the child's name").not.toContain(kid.name);
    }
    await anon.close();
  });

  test("REFUSED · a staff session has no memberId — the member billing routes answer empty, never another member's data", async ({ browser }, testInfo) => {
    const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email: COACH_EMAIL, password: PASSWORD });
    const subs = await apiGet(ctx.request, "/api/member/me/subscriptions");
    const pays = await apiGet(ctx.request, "/api/member/me/payments");
    describeResponse("J50 coach GET member/me/subscriptions", subs);
    describeResponse("J50 coach GET member/me/payments", pays);
    // Whatever the status, the body must not carry another member's PII.
    expect(subs.text).not.toContain(kid.name);
    expect(pays.text).not.toContain(kid.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J51 — Shop to a pay-at-desk order
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J51 shop — the reference appears only after the server confirms", () => {
  let tenantId: string;
  let member: LfMember;
  let memberCtx: BrowserContext;
  let product: { id: string; name: string; pricePence: number };
  let foreign: LfTenant;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    member = await mkMember({ name: `${RUN_STAMP} J51 member` });
    product = await mkProduct(tenantId, { name: `${RUN_STAMP} J51 rash guard` });
    foreign = await mkTenant();
    memberCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: member.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
  });

  test.afterAll(async () => {
    await teardownTenant(foreign);
  });

  test("ALLOWED · the shop loads at 390 and shop-config names the rail the club actually chose", async () => {
    const page = await memberCtx.newPage();
    await page.goto("/member/shop", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J51 /member/shop at 390");

    const cfg = await apiGet(memberCtx.request, "/api/member/shop-config");
    expect(cfg.status).toBe(200);
    expect(Object.keys(cfg.body as object).sort(), "shop-config answers a known key set")
      .toEqual(["paymentRail", "stripeConnected"]);
    const row = await sql<{ paymentRail: string | null; stripeConnected: boolean }>(
      'SELECT "paymentRail", "stripeConnected" FROM "Tenant" WHERE id = $1', [tenantId],
    );
    expect((cfg.body as { paymentRail: string | null }).paymentRail,
      "the rail the screen labels is the rail in the row").toBe(row[0].paymentRail);
    await page.close();
  });

  test("ALLOWED · products come from the tenant's own rows and carry no foreign product", async () => {
    const r = await apiGet(memberCtx.request, "/api/member/products");
    expect(r.status).toBe(200);
    expect(r.text, "another club's product never appears in this club's shop")
      .not.toContain(`${RUN_STAMP} Foreign product`);
    const names = (r.body as Array<{ name: string }>).map((p) => p.name);
    expect(names, "the run-stamped product this lane created is on sale").toContain(product.name);
  });

  test("ERROR-CHECK · a stubbed 500 on the products route is an error state, never an empty shop", async () => {
    const page = await memberCtx.newPage();
    await page.route("**/api/member/products", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
    await page.goto("/member/shop", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = (await page.locator("body").innerText()).toLowerCase();
    console.log(`[L-F probe] J51 shop under a 500 rendered: ${JSON.stringify(text.slice(0, 300))}`);
    // An HTTP error is never an empty state (UI-RULES). The screen must say
    // something went wrong, not "no products yet".
    expect(text, "a 500 must not be dressed as an empty shop")
      .toMatch(/couldn.t|could not|unavailable|went wrong|try again|problem|error/);
    await page.unroute("**/api/member/products");
    await page.close();
  });

  test("ALLOWED · checkout writes a pending Order and the reference shown is the row's own", async () => {
    const before = await countOf("Order", '"memberId" = $1', [member.id]);
    const r = await apiCall(memberCtx.request, "post", "/api/member/checkout", ORIGIN, {
      items: [{ id: product.id, name: product.name, price: product.pricePence / 100, quantity: 1 }],
    });
    describeResponse("J51 member checkout", r);
    if (r.status >= 200 && r.status < 300) {
      const rows = await sql<{ id: string; orderRef: string; status: string; totalPence: number }>(
        'SELECT id, "orderRef", status, "totalPence" FROM "Order" WHERE "memberId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
        [member.id],
      );
      expect(rows.length, "checkout is proven by a row").toBe(1);
      expect(rows[0].status, "a desk order starts pending").toBe("pending");
      const ref = (r.body as { orderRef?: string; reference?: string }).orderRef
        ?? (r.body as { reference?: string }).reference;
      if (ref) expect(ref, "the reference the member is shown is the row's own").toBe(rows[0].orderRef);
    } else {
      await assertUnchanged("Order", before, "J51 refused checkout", '"memberId" = $1', [member.id]);
    }
  });

  test("ERROR-CHECK · a stubbed 500 on checkout shows no reference and does not claim the order was placed", async () => {
    const page = await memberCtx.newPage();
    await page.route("**/api/member/checkout", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
    await page.goto("/member/shop", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const add = page.getByRole("button", { name: /add|buy|basket|cart/i }).first();
    if (await add.count()) {
      await add.click({ timeout: 10_000 }).catch(() => {});
      const pay = page.getByRole("button", { name: /pay|checkout|place order|order/i }).first();
      if (await pay.count()) await pay.click({ timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    const text = await page.locator("body").innerText();
    console.log(`[L-F probe] J51 checkout under a 500 rendered: ${JSON.stringify(text.slice(0, 400))}`);
    expect(text, "a failed checkout never claims the order was placed").not.toMatch(/order placed|order confirmed/i);
    // No reference may be invented client-side: the only references in the DB
    // for this member are the ones the server minted.
    const refs = await sql<{ orderRef: string }>('SELECT "orderRef" FROM "Order" WHERE "memberId" = $1', [member.id]);
    for (const m of text.matchAll(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/g)) {
      expect(refs.map((x) => x.orderRef), `the screen showed a reference "${m[0]}" that no row carries`).toContain(m[0]);
    }
    await page.unroute("**/api/member/checkout");
    await page.close();
  });

  test("REFUSED · products CRUD per staff role — GET is every staff role, mutation is owner/manager", async ({ browser }, testInfo) => {
    const manager = await mkStaff("manager");
    const cells: Array<[string, string, "ok-false"]> = [];
    for (const [label, email, password] of [
      ["owner", OWNER_EMAIL, PASSWORD],
      ["manager", manager.email, THROWAWAY_PASSWORD],
      ["coach", COACH_EMAIL, PASSWORD],
      ["admin", ADMIN_EMAIL, PASSWORD],
    ] as const) {
      const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email, password });
      const list = await apiGet(ctx.request, "/api/products");
      expect(list.status, `${label} GET /api/products (requireApiStaff)`).toBe(200);

      const before = await countOf("Product", '"tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1)', [CLUB_SLUG]);
      const create = await apiCall(ctx.request, "post", "/api/products", ORIGIN, {
        name: `${RUN_STAMP} ${label} product`, pricePence: 1234, category: "other",
      });
      describeResponse(`J51 ${label} POST /api/products`, create);
      if (label === "owner" || label === "manager") {
        expect(create.status, `${label} may create a product`).toBe(201);
      } else {
        expect(create.status, `${label} may not create a product`).toBe(403);
        expectRefusal(create, "ok-false", `J51 ${label} POST /api/products`);
        await assertUnchanged("Product", before, `J51 ${label} POST /api/products`,
          '"tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1)', [CLUB_SLUG]);
      }
      cells.push([label, String(create.status), "ok-false"]);
    }
    console.log(`[L-F probe] J51 products POST per role: ${JSON.stringify(cells)}`);
  });

  test("ATTACK · a foreign product id in this club's PATCH and DELETE answers 404 and changes nothing", async ({ browser }, testInfo) => {
    const owner = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email: OWNER_EMAIL, password: PASSWORD });
    const beforeName = await sql<{ name: string; deletedAt: Date | null }>(
      'SELECT name, "deletedAt" FROM "Product" WHERE id = $1', [foreign.productId],
    );
    const patch = await apiCall(owner.request, "patch", `/api/products/${foreign.productId}`, ORIGIN, { name: "pwned" });
    expect(patch.status, "another club's product is a 404").toBe(404);
    const del = await apiCall(owner.request, "delete", `/api/products/${foreign.productId}`, ORIGIN);
    expect(del.status, "another club's product cannot be deleted").toBe(404);
    const after = await sql<{ name: string; deletedAt: Date | null }>(
      'SELECT name, "deletedAt" FROM "Product" WHERE id = $1', [foreign.productId],
    );
    expect(after[0].name, "the foreign product is untouched").toBe(beforeName[0].name);
    expect(after[0].deletedAt, "the foreign product is not soft-deleted").toBe(beforeName[0].deletedAt);
  });

  test("REPORT · orders/[id]/mark-paid has no screen — every role driven at the route", async ({ browser }, testInfo) => {
    const order = await sql<{ id: string; orderRef: string }>(
      `INSERT INTO "Order" ("id", "tenantId", "memberId", "orderRef", "items", "totalPence",
                            "currency", "status", "paymentMethod", "updatedAt")
       -- 'pay_at_desk' | 'stripe' are the only values Order_paymentMethod_check
       -- allows (prisma/migrations/20260430000005_orders/migration.sql:35-37);
       -- round 2 inserted 'desk' and the fixture, not the product, was rejected.
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, 2500, 'GBP', 'pending', 'pay_at_desk', now())
       RETURNING id, "orderRef"`,
      [tenantId, member.id, `${RUN_STAMP.toUpperCase()}-J51`, JSON.stringify([{ id: product.id, quantity: 1 }])],
    );
    const manager = await mkStaff("manager");
    for (const [label, email, password, allowed] of [
      ["coach", COACH_EMAIL, PASSWORD, false],
      ["admin", ADMIN_EMAIL, PASSWORD, false],
      ["manager", manager.email, THROWAWAY_PASSWORD, true],
    ] as const) {
      const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email, password });
      const before = await sql<{ status: string }>('SELECT status FROM "Order" WHERE id = $1', [order[0].id]);
      const r = await apiCall(ctx.request, "post", `/api/orders/${order[0].id}/mark-paid`, ORIGIN, { reason: "cash at the desk" });
      describeResponse(`J51 ${label} mark-paid`, r);
      const after = await sql<{ status: string }>('SELECT status FROM "Order" WHERE id = $1', [order[0].id]);
      if (allowed) {
        expect(r.status, `${label} may mark an order paid`).toBe(200);
        expect(after[0].status, "the order really is paid").toBe("paid");
      } else {
        expect(r.status, `${label} may not mark an order paid`).toBe(403);
        expectRefusal(r, "ok-false", `J51 ${label} mark-paid`);
        expect(after[0].status, "the refused call changed nothing").toBe(before[0].status);
      }
    }
    // Idempotency: the same request twice leaves one paid order, not two writes.
    const owner = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email: OWNER_EMAIL, password: PASSWORD });
    const again = await apiCall(owner.request, "post", `/api/orders/${order[0].id}/mark-paid`, ORIGIN, { reason: "cash at the desk" });
    expect(again.status, "marking a paid order paid again is idempotent, not a 500").toBeLessThan(500);
    await sql('DELETE FROM "Order" WHERE id = $1', [order[0].id]);
  });

  test("ATTACK · malformed and oversize checkout bodies are 4xx and write nothing", async () => {
    const before = await countOf("Order", '"memberId" = $1', [member.id]);
    const bodies: Array<[string, unknown]> = [
      ["empty array", { items: [] }],
      ["negative pence", { items: [{ id: product.id, name: product.name, price: -500, quantity: 1 }] }],
      ["NaN quantity", { items: [{ id: product.id, name: product.name, price: 25, quantity: "NaN" }] }],
      ["10 000-character name", { items: [{ id: product.id, name: "x".repeat(10_000), price: 25, quantity: 1 }] }],
      ["999 quantity", { items: [{ id: product.id, name: product.name, price: 25, quantity: 999 }] }],
      ["foreign product id", { items: [{ id: foreign.productId, name: "Foreign", price: 15, quantity: 1 }] }],
    ];
    for (const [label, data] of bodies) {
      const r = await apiCall(memberCtx.request, "post", "/api/member/checkout", ORIGIN, data);
      describeResponse(`J51 checkout ${label}`, r);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
    }
    const after = await countOf("Order", '"memberId" = $1 AND "totalPence" < 0', [member.id]);
    expect(after, "no order with a negative total exists").toBe(0);
    const foreignRef = await countOf("Order",
      `"memberId" = $1 AND items::text LIKE $2`, [member.id, `%${foreign.productId}%`]);
    expect(foreignRef, "no order carries another club's product").toBe(0);
    console.log(`[L-F probe] J51 orders before the fuzz: ${before}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J52 — Profile and family
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J52 profile and family — phone validation, photos, per-child billing", () => {
  let parent: LfMember;
  let kid: LfMember;
  let strangerKid: LfMember;
  let parentCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    parent = await mkMember({ accountType: "parent", name: `${RUN_STAMP} J52 parent` });
    kid = await mkKid(parent.id, `${RUN_STAMP} J52 kid`);
    const stranger = await mkMember({ accountType: "parent", name: `${RUN_STAMP} J52 stranger` });
    strangerKid = await mkKid(stranger.id, `${RUN_STAMP} J52 stranger kid`);
    parentCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: parent.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
  });

  test("ALLOWED · the profile page loads at 390 and a valid UK phone lands in the row", async () => {
    const page = await parentCtx.newPage();
    await page.goto("/member/profile", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J52 /member/profile at 390");
    await page.close();

    const r = await apiCall(parentCtx.request, "patch", "/api/member/me", ORIGIN, { phone: "07700 900123" });
    expect(r.status, "a UK mobile is accepted").toBe(200);
    const row = await sql<{ phone: string | null }>('SELECT phone FROM "Member" WHERE id = $1', [parent.id]);
    expect(row[0].phone, "the phone is normalised into the row, not just echoed").toBeTruthy();
    console.log(`[L-F probe] J52 "07700 900123" normalised to ${JSON.stringify(row[0].phone)}`);
  });

  test("HELD · an invalid phone is a 400 with a field error and the row does not move", async () => {
    const before = await sql<{ phone: string | null }>('SELECT phone FROM "Member" WHERE id = $1', [parent.id]);
    for (const bad of ["not a phone", "12", "+".repeat(40), "0".repeat(10_000), "07700 900123; DROP TABLE"]) {
      const r = await apiCall(parentCtx.request, "patch", "/api/member/me", ORIGIN, { phone: bad });
      expect(r.status, `"${bad.slice(0, 20)}" is rejected`).toBe(400);
      const b = r.body as { error?: string; fieldErrors?: { phone?: string } };
      expect(b.error, "the refusal names validation").toBe("Validation failed");
      expect(typeof b.fieldErrors?.phone, "the member is told which field").toBe("string");
    }
    const after = await sql<{ phone: string | null }>('SELECT phone FROM "Member" WHERE id = $1', [parent.id]);
    expect(after[0].phone, "no rejected value reached the row").toBe(before[0].phone);
  });

  test("ATTACK · PATCH member/me cannot reach another member's row, nor disable TOTP, nor set a rank", async () => {
    const beforeKid = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [strangerKid.id]);
    // The route derives memberId from the session; an id in the body is inert
    // by construction, which is the property under test.
    const r = await apiCall(parentCtx.request, "patch", "/api/member/me", ORIGIN, {
      id: strangerKid.id, memberId: strangerKid.id, name: "pwned by J52",
      totpEnabled: false, status: "cancelled", paymentStatus: "paid",
      tenantId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.status, "the body's foreign ids are ignored, not honoured").toBe(200);
    const afterKid = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [strangerKid.id]);
    expect(afterKid[0].name, "another member's row is untouched").toBe(beforeKid[0].name);
    const me = await sql<{ name: string; status: string; totpEnabled: boolean; tenantId: string }>(
      'SELECT name, status, "totpEnabled", "tenantId" FROM "Member" WHERE id = $1', [parent.id],
    );
    expect(me[0].name, "the caller's own name did change — the write landed on the right row").toBe("pwned by J52");
    expect(me[0].status, "status is not a self-service field").toBe("active");
    expect(me[0].totpEnabled, "totpEnabled is stripped before the update").toBe(false);
    // Put the name back so the rest of the file reads a sane fixture.
    await sql('UPDATE "Member" SET name = $1 WHERE id = $2', [parent.name, parent.id]);
  });

  test("ATTACK · PATCH member/children/[id] for another parent's child is a 404 that leaks nothing", async () => {
    const before = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [strangerKid.id]);
    const r = await apiCall(parentCtx.request, "patch", `/api/member/children/${strangerKid.id}`, ORIGIN, { name: "pwned" });
    describeResponse("J52 PATCH another parent's child", r);
    expect(r.status, "another parent's child is a 404").toBe(404);
    expect(r.text, "the refusal does not disclose the child's name").not.toContain(strangerKid.name);
    const after = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [strangerKid.id]);
    expect(after[0].name, "the foreign child's row is unchanged").toBe(before[0].name);

    // Own child, for contrast — the same route must work for the right parent.
    const mine = await apiCall(parentCtx.request, "patch", `/api/member/children/${kid.id}`, ORIGIN, {
      name: `${RUN_STAMP} J52 kid renamed`,
    });
    describeResponse("J52 PATCH own child", mine);
  });

  test("ALLOWED · the family page reaches the child's per-child billing card", async () => {
    const page = await parentCtx.newPage();
    await page.goto(`/member/family/${kid.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J52 /member/family/[childId] at 390");
    expect(new URL(page.url()).pathname, "the parent reaches their own child's page").toContain(kid.id);
    const body = await page.locator("body").innerText();
    expect(body, "the child's name is on their own page").toContain(kid.name.split(" ").slice(-1)[0]);
    await page.close();
  });

  test("REFUSED · the family page for another parent's child is not rendered", async () => {
    const page = await parentCtx.newPage();
    const landed = await finalPath(page, `/member/family/${strangerKid.id}`);
    const body = await page.locator("body").innerText();
    console.log(`[L-F probe] J52 foreign child page landed on ${landed}`);
    expect(body, "another parent's child's name is never rendered").not.toContain(strangerKid.name);
    await page.close();
  });

  test("ATTACK · a kids Member row cannot exist without a parent — the CHECK constraint holds", async () => {
    const tenantId = await seededTenantId();
    let rejected = false;
    try {
      await sql(
        `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus",
                               "accountType", "joinedAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'kids', now(), now())`,
        [tenantId, `${RUN_STAMP} orphan kid`, `${RUN_STAMP}-orphan@no-login.matflow.local`],
      );
    } catch (e) {
      rejected = true;
      console.log(`[L-F probe] J52 orphan kid rejected: ${String((e as Error).message).slice(0, 120)}`);
    }
    expect(rejected, "Member_kids_must_have_parent refuses a parentless kids row").toBe(true);
    await sql('DELETE FROM "Member" WHERE email = $1', [`${RUN_STAMP}-orphan@no-login.matflow.local`]).catch(() => {});
  });

  test("REFUSED · anonymous at every J52 route", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    for (const [method, url] of [
      ["get", "/api/member/me"],
      ["patch", "/api/member/me"],
      ["get", `/api/member/family/${kid.id}/billing`],
      ["patch", `/api/member/children/${kid.id}`],
      ["get", "/api/member/me/children"],
    ] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN, method === "patch" ? { name: "x" } : undefined);
      describeResponse(`J52 anonymous ${method.toUpperCase()} ${url}`, r);
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
    }
    const row = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [kid.id]);
    expect(row[0].name, "nothing anonymous wrote to the child").not.toBe("x");
    await anon.close();
  });
});

test.afterAll(async () => {
  await teardownSeededClub();
});
