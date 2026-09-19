/**
 * Lane L-E shared fixtures — money on the pay-at-desk rail (J42–J48).
 *
 * Column one (owner on a fresh club) is Lane A0's. This lane drives every OTHER
 * role of J42–J48 on the seeded club plus every attack, so everything here is
 * about (a) minting run-stamped tiers, packs, payments and orders that the
 * seeded club's ledger cannot contaminate, and (b) signing Stripe events the
 * way Stripe does so the real route verifies a real signature.
 *
 * Session, request and teardown primitives are imported from `ld-shared.ts`
 * rather than copied: the lanes share one IP, one rate-limit table and one
 * seeded club, and two copies of `sessionFor` would be two chances to differ.
 *
 * Nothing here touches a seeded tier, a seeded pack, a seeded payment, the
 * club's kiosk token, or a rate-limit bucket it does not reset.
 */
import { createHmac } from "node:crypto";
import type { APIRequest, APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { RUN_STAMP, sql, seededTenantId } from "../helpers/db";
import { CLUB_SLUG as SLUG, PASSWORD as PW } from "./ld-shared";

export {
  CLUB_SLUG,
  OWNER_EMAIL,
  COACH_EMAIL,
  ADMIN_EMAIL,
  PASSWORD,
  THROWAWAY_PASSWORD,
  SCOPE,
  NO_REDIRECT,
  post,
  patch,
  del,
  get,
  FORBIDDEN_BODY,
  CSRF_BODY,
  mkStaff,
  mkTenant,
  teardownTenant,
  resetBucketsLike,
  countRows,
} from "./ld-shared";

export { sql, RUN_STAMP, seededTenantId };

// ── Who the request actually is ──────────────────────────────────────────────

/**
 * The seeded club's member account.
 *
 * Round 2 opened with seven cells that read as product defects and were not:
 * a "member" recording £1,000 of cash at the desk (201), a "member" downloading
 * the club's payment export (200), an "anonymous" POST creating a Payment row.
 * The `AuditLog` rows those requests left name `owner@totalbjj.com` on every
 * one of them. There is no `member@totalbjj.com` on the seeded club at all —
 * the only members with a password are `jordan@example.com` and its siblings
 * (`tests/e2e/member-auth.setup.ts:18` has always used jordan). A login for an
 * account that does not exist cannot fail loudly on its own, so the context
 * carried the chromium project's OWNER `storageState` and every refusal cell
 * measured the owner refusing nothing.
 *
 * Two changes stop that class of lie for good: the address below is an account
 * that exists, and `sessionFor` asks the server who it is before handing the
 * context back.
 */
export const MEMBER_EMAIL = "jordan@example.com";

/** A context with no cookies at all, whatever the project's storageState says. */
const EMPTY_STATE: { cookies: []; origins: [] } = { cookies: [], origins: [] };

const sessions = new Map<string, BrowserContext>();

/**
 * Ask the server who it thinks this context is, and refuse to continue if it is
 * anyone else. `storageState: undefined` does NOT override a project's
 * storageState — undefined means "unspecified", so the owner state is merged in
 * — which is how a failed login left an owner session behind. This is the guard
 * that would have caught it in round 1.
 */
export async function assertIdentity(rc: APIRequestContext, email: string | null): Promise<void> {
  const res = await rc.get("/api/auth/session", { maxRedirects: 0 });
  const body = res.status() === 200 ? await res.json().catch(() => null) : null;
  const actual: string | null = body?.user?.email ?? null;
  const want = email?.toLowerCase() ?? null;
  if ((actual?.toLowerCase() ?? null) !== want) {
    throw new Error(
      `session identity drift: asked for ${email ?? "nobody"}, the server answered ${actual ?? "no session"}. ` +
        "Every cell measured with this context would be measuring the wrong role.",
    );
  }
}

/**
 * A logged-in context for one account, cached per run. Deliberately NOT
 * `ld-shared`'s copy: this one starts from an explicitly empty storage state
 * and proves the identity before any cell uses it.
 */
export async function sessionFor(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string = PW,
  slug: string = SLUG,
): Promise<BrowserContext> {
  const key = `${slug}:${email}`;
  const cached = sessions.get(key);
  if (cached) return cached;

  const context = await browser.newContext({ baseURL, storageState: EMPTY_STATE });
  await context.clearCookies();
  const page = await context.newPage();
  await page.goto(`/login?club=${slug}`);
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", password);
  await page.click("button[type='submit']");
  // The leading slash matters: a FAILED login can carry `callbackUrl=/member`,
  // and a bare /member/ would then read a refusal as a successful sign-in.
  await page.waitForURL(/\/dashboard|\/member|\/onboarding|\/totp/, { timeout: 45_000 });
  await page.close();

  await assertIdentity(context.request, email);
  sessions.set(key, context);
  return context;
}

export async function closeSessions(): Promise<void> {
  for (const c of sessions.values()) await c.close().catch(() => {});
  sessions.clear();
}

/**
 * A genuinely anonymous request context. `playwright.request.newContext()`
 * inherits the project's `storageState` too — the anonymous cash cell POSTed
 * with the owner's cookie and recorded a real payment — so the empty state is
 * passed explicitly and the absence of a session is asserted, not assumed.
 */
export async function anonRc(pw: { request: APIRequest }, baseURL: string): Promise<APIRequestContext> {
  const rc = await pw.request.newContext({ baseURL, storageState: EMPTY_STATE, maxRedirects: 0 });
  await assertIdentity(rc, null);
  return rc;
}

/**
 * The connected account the seeded club is mapped to. Every event must carry
 * it: `app/api/stripe/webhook/route.ts:136-141` answers 409 "Event missing
 * connected account" to anything that does not, by design — the campaign spec
 * asserts that refusal on purpose. Round 1 signed its events with no account
 * and read six 409s as product defects.
 */
let cachedAccountId: string | null = null;

export async function connectedAccountId(): Promise<string> {
  if (cachedAccountId) return cachedAccountId;
  const rows = await sql<{ stripeAccountId: string | null }>(
    'SELECT "stripeAccountId" FROM "Tenant" WHERE id = $1',
    [await seededTenantId()],
  );
  const id = rows[0]?.stripeAccountId;
  if (!id) {
    throw new Error(
      "the seeded club has no stripeAccountId — every webhook cell here needs one; seed it before reading a 409 as a defect",
    );
  }
  cachedAccountId = id;
  return id;
}

// ── Stripe event signing ─────────────────────────────────────────────────────

export const WEBHOOK_PATH = "/api/stripe/webhook";

/**
 * `.env.test` carries the signing secret. The lane that exists because an empty
 * secret silently rejected every event cannot itself run without one — the
 * throw is the honest blocker, not a skip that reads as a pass.
 */
export function webhookSecret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error("STRIPE_WEBHOOK_SECRET is not set — see .env.test");
  return s;
}

/**
 * Sign exactly the way Stripe does: `t={unix},v1={hex hmac-sha256}` over the
 * bytes `"{unix}.{payload}"`. Written out rather than reusing the route's own
 * verification, so the two halves stay independent (copied from
 * `stripe-webhooks.spec.ts:83-86`, which explains the reasoning in full).
 */
export function signPayload(
  payload: string,
  signingSecret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", signingSecret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Unique per run AND per call, so a replay is something a test chooses. */
export function eventId(): string {
  return `evt_${RUN_STAMP}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface EventInit {
  type: string;
  object: Record<string, unknown>;
  account?: string | null;
  id?: string;
}

export function buildEvent({ type, object, account, id }: EventInit) {
  return {
    id: id ?? eventId(),
    object: "event",
    api_version: "2026-03-25.dahlia",
    created: Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    ...(account === null ? {} : { account }),
    data: { object },
  };
}

/**
 * POST a genuinely-signed event as a raw string body. The route reads
 * `req.text()` and verifies the bytes, so `data: object` (which Playwright
 * re-serialises) would be verifying a different payload than the one signed.
 */
export async function sendSigned(
  rc: APIRequestContext,
  init: EventInit,
  over: Partial<{ secret: string; signature: string; timestamp: number }> = {},
) {
  // An event with no `account` is refused 409 before any handler runs, by
  // design. Omitting the field therefore means "the seeded club's account",
  // which is what every cell here wants; a deliberate platform event says
  // `account: null` and gets the 409 the campaign spec already asserts.
  const account = init.account === undefined ? await connectedAccountId() : init.account;
  const payload = JSON.stringify(buildEvent({ ...init, account }));
  const sig =
    over.signature ??
    signPayload(payload, over.secret ?? webhookSecret(), over.timestamp ?? Math.floor(Date.now() / 1000));
  return rc.post(WEBHOOK_PATH, {
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    data: payload,
    maxRedirects: 0,
  });
}

// ── Run-stamped money fixtures ───────────────────────────────────────────────

export async function mkTier(
  tenantId: string,
  over: Partial<{ name: string; pricePence: number; billingCycle: string; isKids: boolean; currency: string }> = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "MembershipTier" ("id", "tenantId", "name", "pricePence", "currency", "billingCycle", "isKids", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, true, now(), now())
     RETURNING id`,
    [
      tenantId,
      over.name ?? `${RUN_STAMP} Adult monthly`,
      over.pricePence ?? 5000,
      over.currency ?? "GBP",
      over.billingCycle ?? "monthly",
      over.isKids ?? false,
    ],
  );
  return rows[0].id;
}

/**
 * `Member.nextDueAt` is set through SQL so the due-date cases start from a
 * known calendar day. The `timestamptz AT TIME ZONE 'UTC'` cast stores exactly
 * what Prisma would for a `timestamp(3)` column — the pattern
 * `ld-shared.ts:125-137` documents; a bare JS Date through node-pg writes the
 * LOCAL wall clock and reads back an hour out under BST.
 */
export async function setDue(memberId: string, isoDate: string | null): Promise<void> {
  await sql('UPDATE "Member" SET "nextDueAt" = ($2::timestamptz AT TIME ZONE \'UTC\') WHERE id = $1', [
    memberId,
    isoDate,
  ]);
}

export async function setTier(memberId: string, tierId: string | null): Promise<void> {
  await sql('UPDATE "Member" SET "membershipTierId" = $2 WHERE id = $1', [memberId, tierId]);
}

/** The calendar day of a stored due date, read as SQL text — never through a JS Date. */
export async function dueDay(memberId: string): Promise<string | null> {
  const rows = await sql<{ d: string | null }>(
    `SELECT to_char("nextDueAt", 'YYYY-MM-DD') AS d FROM "Member" WHERE id = $1`,
    [memberId],
  );
  return rows[0]?.d ?? null;
}

export async function mkPack(
  tenantId: string,
  over: Partial<{ name: string; totalCredits: number; pricePence: number; validityDays: number; isActive: boolean }> = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "ClassPack" ("id", "tenantId", "name", "totalCredits", "validityDays", "pricePence", "currency", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'GBP', $6, now(), now())
     RETURNING id`,
    [
      tenantId,
      over.name ?? `${RUN_STAMP} Ten class pack`,
      over.totalCredits ?? 10,
      over.validityDays ?? 90,
      over.pricePence ?? 10_000,
      over.isActive ?? true,
    ],
  );
  return rows[0].id;
}

export async function mkMemberPack(
  tenantId: string,
  memberId: string,
  packId: string,
  over: Partial<{ creditsRemaining: number; status: string; stripePaymentIntentId: string | null; expiresAt: string }> = {},
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "MemberClassPack" ("id", "tenantId", "memberId", "packId", "creditsRemaining", "purchasedAt", "expiresAt", "stripePaymentIntentId", "status")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now(), ($5::timestamptz AT TIME ZONE 'UTC'), $6, $7)
     RETURNING id`,
    [
      tenantId,
      memberId,
      packId,
      over.creditsRemaining ?? 10,
      over.expiresAt ?? new Date(Date.now() + 90 * 86_400_000).toISOString(),
      over.stripePaymentIntentId ?? null,
      over.status ?? "active",
    ],
  );
  return rows[0].id;
}

export async function getMemberPack(id: string) {
  const rows = await sql<{ id: string; creditsRemaining: number; status: string }>(
    'SELECT id, "creditsRemaining", status FROM "MemberClassPack" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * A Stripe-backed payment that funds a pack. `Payment` has no `method` column —
 * the method survives only as a description prefix, which is why every
 * assertion below reads `description`, never a method field.
 */
export async function mkStripePayment(
  tenantId: string,
  memberId: string,
  over: Partial<{ amountPence: number; refundedAmountPence: number | null; status: string; piId: string; chargeId: string }> = {},
): Promise<{ id: string; piId: string; chargeId: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const piId = over.piId ?? `pi_${RUN_STAMP}_${suffix}`;
  const chargeId = over.chargeId ?? `ch_${RUN_STAMP}_${suffix}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Payment" ("id", "tenantId", "memberId", "amountPence", "currency", "status",
                            "stripePaymentIntentId", "stripeChargeId", "refundedAmountPence", "description", "paidAt", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'GBP', $4, $5, $6, $7, $8, now(), now())
     RETURNING id`,
    [
      tenantId,
      memberId,
      over.amountPence ?? 10_000,
      over.status ?? "succeeded",
      piId,
      chargeId,
      over.refundedAmountPence ?? null,
      `${RUN_STAMP} pack purchase`,
    ],
  );
  return { id: rows[0].id, piId, chargeId };
}

export async function getPaymentLedger(id: string) {
  const rows = await sql<{ id: string; status: string; amountPence: number; refundedAmountPence: number | null; description: string | null }>(
    'SELECT id, status, "amountPence", "refundedAmountPence", description FROM "Payment" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Children before parents, and every table without a `tenantId` through its
 * parent: ClassPackRedemption → MemberClassPack → ClassPack; Dispute →
 * Payment; Order; StripeEvent by run-stamped event id.
 */
export async function teardownMoney(tenantId: string): Promise<void> {
  const packIds = (
    await sql<{ id: string }>('SELECT id FROM "ClassPack" WHERE "tenantId" = $1 AND name LIKE $2', [
      tenantId,
      `${RUN_STAMP}%`,
    ])
  ).map((r) => r.id);
  if (packIds.length > 0) {
    await sql(
      'DELETE FROM "ClassPackRedemption" WHERE "memberPackId" IN (SELECT id FROM "MemberClassPack" WHERE "packId" = ANY($1))',
      [packIds],
    );
    await sql('DELETE FROM "MemberClassPack" WHERE "packId" = ANY($1)', [packIds]);
    await sql('DELETE FROM "ClassPack" WHERE id = ANY($1)', [packIds]);
  }
  await sql('DELETE FROM "Dispute" WHERE "tenantId" = $1 AND "stripeDisputeId" LIKE $2', [tenantId, `%${RUN_STAMP}%`]);
  await sql('DELETE FROM "Payment" WHERE "tenantId" = $1 AND (description LIKE $2 OR "requestId" LIKE $2 OR "stripePaymentIntentId" LIKE $3)', [
    tenantId,
    `${RUN_STAMP}%`,
    `%${RUN_STAMP}%`,
  ]);
  await sql('DELETE FROM "Order" WHERE "tenantId" = $1 AND "orderRef" LIKE $2', [tenantId, `%${RUN_STAMP.toUpperCase()}%`]);
  await sql('DELETE FROM "StripeEvent" WHERE "eventId" LIKE $1', [`%${RUN_STAMP}%`]);
  await sql('DELETE FROM "MembershipTier" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP}%`]);
}

/** Post-delete SELECT — teardown is verified by a count, never by no error. */
export async function assertSwept(tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const checks: Array<[string, string, unknown[]]> = [
    ["ClassPack", '"tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP}%`]],
    ["Payment", '"tenantId" = $1 AND description LIKE $2', [tenantId, `${RUN_STAMP}%`]],
    ["Order", '"tenantId" = $1 AND "orderRef" LIKE $2', [tenantId, `%${RUN_STAMP.toUpperCase()}%`]],
    ["MembershipTier", '"tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP}%`]],
    ["StripeEvent", '"eventId" LIKE $1', [`%${RUN_STAMP}%`]],
  ];
  for (const [table, where, params] of checks) {
    const rows = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`, params);
    out[table] = Number(rows[0].n);
  }
  return out;
}
