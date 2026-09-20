/**
 * Lane L-C — shared machinery for the members spec files (J22–J30).
 *
 * NOT a `.spec.ts`: Playwright must not collect it.
 *
 * Sessions, refusal helpers and the layout contract are reused from
 * `./lb-shared` rather than copied — a second copy of `sessionFor` would drift
 * and the drift would read as a product defect. Everything below is what the
 * members lane needs on top: run-stamped members with the columns this lane's
 * journeys touch, photo rows, invite tokens, and teardown in dependency order.
 *
 * Nothing here touches product code.
 */
import { expect } from "@playwright/test";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { hashToken } from "@/lib/token-hash";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";

/**
 * Round 1 harness repair. These three were `await import(...)` inside the
 * helpers below and every call site died with
 *
 *     SyntaxError: Cannot use import statement outside a module
 *
 * — five failures across lc-2 alone. Playwright's loader transforms STATIC
 * imports in a spec's module graph; a dynamic `import()` of a `@/`-aliased TS
 * source is resolved at runtime by Node, which never sees the transform. The
 * fix is to import at the top, exactly as `lb-shared.ts` already does with
 * bcryptjs. `hashToken` is still the product's own hasher, so a change to the
 * HMAC recipe breaks these helpers rather than silently minting tokens no
 * route will match.
 */
export const HARNESS_BCRYPT_ROUNDS = 10;

export {
  SLUG_A,
  OWNER_A,
  COACH_A,
  ADMIN_A,
  MEMBER_A,
  PASSWORD_A,
  THROWAWAY_PASSWORD,
  sessionFor,
  anonContext,
  closeSessions,
  createThrowawayStaff,
  createThrowawayTenant,
  teardownThrowawayTenant,
  teardownThrowawayStaff,
  countOf,
  assertUnchanged,
  apiCall,
  expectRefusalShape,
  assertNoOverflow,
  finalUrlAfterGoto,
  clearBucket,
} from "./lb-shared";
export type { StaffRole, ThrowawayStaff, ThrowawayTenant } from "./lb-shared";

/** Every member this lane mints carries the stamp in its email (rule 5). */
export function stampedEmail(tag: string): string {
  return `${RUN_STAMP}-${tag}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

export interface LcMember {
  id: string;
  name: string;
  email: string;
  tenantId: string;
}

/**
 * A member row this run owns, in any tenant.
 *
 * Column-named INSERT with every NOT-NULL column that has no database default
 * named explicitly: `updatedAt` is `@updatedAt` (a Prisma-side default, not a
 * Postgres one) and `id` is `@default(cuid())`, which likewise never reached
 * the DDL. Omitting either is the "INSERT missing a required column" failure
 * two other lanes lost their first run to.
 */
export async function makeMember(over: Partial<{
  tenantId: string;
  name: string;
  tag: string;
  email: string;
  status: string;
  paymentStatus: string;
  accountType: string;
  parentMemberId: string | null;
  dateOfBirth: Date | null;
  phone: string | null;
  waiverAccepted: boolean;
  cancelledAt: Date | null;
  passwordHash: string | null;
}> = {}): Promise<LcMember> {
  // Round 1 harness repair. `Member_kids_must_have_parent` is a CHECK
  // constraint, so a kids row with no `parentMemberId` fails the INSERT and
  // the failure reads as a product defect three assertions later. Caught here,
  // where the message names the call site's mistake.
  //
  // Round 2: narrowed to `kids`. The constraint is
  // `CHECK ("accountType" <> 'kids' OR "parentMemberId" IS NOT NULL)`
  // (migration 20260515000001), so a `junior` with no parent is legal and the
  // round-1 guard was refusing a row the database accepts.
  if (over.accountType === "kids" && !over.parentMemberId) {
    throw new Error(
      `makeMember({ accountType: "${over.accountType}" }) needs a parentMemberId — ` +
        "the database CHECK Member_kids_must_have_parent refuses an orphan kid row.",
    );
  }

  const tenantId = over.tenantId ?? (await seededTenantId());
  const tag = over.tag ?? "m";
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = over.name ?? `Campaign ${tag} ${suffix}`;
  const email = over.email ?? `${RUN_STAMP}-${tag}-${suffix}@example.test`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member"
       ("id", "tenantId", "name", "email", "status", "paymentStatus", "accountType",
        "parentMemberId", "dateOfBirth", "phone", "waiverAccepted", "cancelledAt",
        "passwordHash", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
     RETURNING id`,
    [
      tenantId,
      name,
      email,
      over.status ?? "active",
      over.paymentStatus ?? "paid",
      over.accountType ?? "adult",
      over.parentMemberId ?? null,
      // Same zone hazard as makeToken: a DOB written as a local Date lands an
      // hour out, which on a midnight date is the previous DAY — and this lane
      // asserts an age boundary to the day.
      over.dateOfBirth ? tsParam(over.dateOfBirth) : null,
      over.phone ?? null,
      over.waiverAccepted ?? false,
      over.cancelledAt ? tsParam(over.cancelledAt) : null,
      over.passwordHash ?? null,
    ],
  );
  return { id: rows[0].id, name, email, tenantId };
}

/** A MemberPhoto row pointing at a tenant-namespaced blob URL. */
export async function makePhoto(
  member: LcMember,
  kind: "evidence" | "profile" = "evidence",
  url?: string,
): Promise<{ id: string; url: string }> {
  const blobUrl =
    url ??
    `https://fake${Math.random().toString(36).slice(2, 8)}.public.blob.vercel-storage.com/tenants/${member.tenantId}/members/${member.id}/${RUN_STAMP}-photo.png`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "MemberPhoto" ("id", "tenantId", "memberId", "url", "kind", "uploadedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())
     RETURNING id`,
    [member.tenantId, member.id, blobUrl, kind],
  );
  return { id: rows[0].id, url: blobUrl };
}

/**
 * A MagicLinkToken this lane controls, so invite and waiver-link consumption
 * can be driven without scraping a token out of an email that never sends.
 *
 * The raw token is returned; the row stores only the HMAC, exactly as the
 * product does (`lib/token-hash.ts`). We import the product's own hasher so a
 * change to the HMAC recipe fails this helper rather than silently minting
 * tokens no route will ever match.
 */
/**
 * Whether a token this harness mints can be consumed by the server at all.
 *
 * ROUND 2, and it is an ENVIRONMENT fault rather than a product one. Both sides
 * HMAC the raw token with `lib/auth-secret.ts`, which reads
 * `NEXTAUTH_SECRET ?? AUTH_SECRET ?? ""`. `.env.test` carries neither, so the
 * Playwright process hashes with the empty key; `next dev` additionally loads
 * `.env`, which DOES carry `AUTH_SECRET`, so the server hashes with the real
 * one. `findUnique({ tokenHash })` therefore misses every token this file
 * inserts and the route answers 404 — which reads exactly like "the product
 * refuses a valid invite". Three cells in lc-2 and four in la-2 failed that
 * way this round.
 *
 * The fix is one line of environment (`AUTH_SECRET` in `.env.test`, with the
 * dev server started from it) and is the controller's, not this lane's: the
 * only alternative available here is reading the production secret out of
 * `.env`, which COMMON rules 1 and 7 both forbid. Until then the cells that
 * need a consumable token skip with this named blocker rather than reporting a
 * product defect that is not there.
 */
export const TOKEN_MINTING_WORKS = Boolean(
  process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
);

export const TOKEN_MINTING_BLOCKER =
  "AUTH_SECRET is absent from .env.test but present in .env, so this process " +
  "hashes tokens with a different key than the dev server — every minted token " +
  "is a 404 at its own door. Environment, not product; see lc-shared.ts.";

/**
 * A `timestamp(3)` parameter, in UTC, as a naive string.
 *
 * ROUND 3, and it cost a whole case. node-postgres serialises a JS `Date` as
 * local time with the local offset (`2026-09-19T22:35:43.030+01:00`), and every
 * DateTime column in this schema is `TIMESTAMP(3)` — WITHOUT time zone — so
 * Postgres takes the wall-clock fields and discards the offset. Prisma then
 * reads the value back as if it were UTC. On this machine (UK, BST) that moves
 * every Date this harness writes one hour into the FUTURE: a token minted to
 * expire a second ago arrived at `accept-invite` with 59 minutes left on it and
 * answered 200 where the case expected 410. The route was right the whole time.
 *
 * `toISOString()` gives the UTC fields; dropping the `Z` hands Postgres exactly
 * those fields for a column that has no zone. Verified against pg's own
 * `prepareValue`, which is what produced the offset.
 */
export function tsParam(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export async function makeToken(opts: {
  tenantId: string;
  email: string;
  purpose: "login" | "first_time_signup" | "waiver_open";
  expiresAt?: Date;
  used?: boolean;
}): Promise<{ raw: string; id: string }> {
  const raw = randomBytes(24).toString("hex");
  const rows = await sql<{ id: string }>(
    `INSERT INTO "MagicLinkToken" ("id", "tenantId", "email", "tokenHash", "purpose", "expiresAt", "used", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now())
     RETURNING id`,
    [
      opts.tenantId,
      opts.email,
      hashToken(raw),
      opts.purpose,
      tsParam(opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000)),
      opts.used ?? false,
    ],
  );
  return { raw, id: rows[0].id };
}

/** bcrypt hash at the harness cost — static import, see HARNESS_BCRYPT_ROUNDS. */
export function hashed(password: string): string {
  return bcrypt.hashSync(password, HARNESS_BCRYPT_ROUNDS);
}

/**
 * Anonymous API cells accept EITHER status this round.
 *
 * L-A is changing the proxy so an unauthenticated /api/* call answers 401 JSON
 * instead of the 307 to /login it answers today. Both are correct refusals; a
 * spec that pinned one would go red on the other lane's landing rather than on
 * a defect. Every anonymous cell in this lane asserts the pair.
 */
export const ANON_REFUSED = [401, 307];

/**
 * The layout contract, minus the sr-only false positive.
 *
 * `assertNoOverflow` from lb-shared reported 50 "strays" on the members screen
 * at 768. Every one was a visually-hidden node: the sr-only recipe is a 1x1
 * clipped box parked outside the viewport, which is exactly what a real
 * offscreen element looks like to a bounding-box test. A 1px-or-smaller box
 * cannot be the thing a person sees hanging off the side of the page, so it is
 * excluded here and the real contract — scrollWidth equals innerWidth, and no
 * VISIBLE fixed or sticky element outside 0..width — still holds.
 */
export async function assertNoOverflowLc(
  page: import("@playwright/test").Page,
  width: number,
  label: string,
): Promise<void> {
  const metrics = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(metrics, `${label}: [scrollWidth, innerWidth] at ${width}px`).toEqual([width, width]);

  const strays = await page.evaluate(() => {
    const out: { tag: string; cls: string; x: number; w: number; h: number }[] = [];
    // Round 2 harness repair. A `position: sticky` cell inside a horizontally
    // scrollable container — every `<th class="sticky top-…">` of the dashboard
    // data table — has a bounding box that runs off the side of the VIEWPORT
    // while the page itself does not scroll: the table's own scroller absorbs
    // it, which is why the scrollWidth assertion above passes. Fifty-eight of
    // them were reported as overflow on the members screen at 768.
    //
    // The contract this helper exists to hold is the one COMMON states: an
    // element that is positioned against the viewport, and therefore
    // contributes nothing to scrollWidth, must still lie inside it. A sticky
    // element whose overflow is contained by a scroll ancestor IS accounted
    // for — by that ancestor — so it is not in scope. `fixed` always is.
    const containedBySomeScroller = (el: HTMLElement): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        const scrolls = /auto|scroll|hidden/.test(ps.overflowX) && p.scrollWidth > p.clientWidth + 1;
        if (scrolls) return true;
      }
      return false;
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
      const b = el.getBoundingClientRect();
      // sr-only and other clipped helpers are 1x1 or smaller. Not something a
      // person can see hanging off the side of the page.
      if (b.width <= 1 || b.height <= 1) continue;
      if (cs.position === "sticky" && containedBySomeScroller(el)) continue;
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), x: b.x, w: b.width, h: b.height });
    }
    return out;
  });
  const offscreen = strays.filter((s) => s.x < -0.5 || s.x + s.w > width + 0.5);
  expect(offscreen, `${label}: visible fixed/sticky elements outside 0..${width}`).toEqual([]);
}

/** Age in whole years at `on`, computed from local date components. */
export function dobForAgeToday(age: number, offsetDays = 0): string {
  const now = new Date();
  const d = new Date(now.getFullYear() - age, now.getMonth(), now.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Everything this lane created, children before parents.
 *
 * `cleanupRun()` sweeps only run-stamped members of the SEEDED club and knows
 * nothing about SignedWaiver, MemberPhoto, MagicLinkToken, ClassSubscription or
 * MemberClassPack — all of which this lane writes. It is called last, not
 * relied on. Kids are deleted before their parents because `parentMemberId` is
 * ON DELETE SET NULL, which would silently orphan rather than fail.
 */
export async function teardownLc(): Promise<void> {
  const like = `${RUN_STAMP}-%@example.test`;
  const mine = await sql<{ id: string }>('SELECT id FROM "Member" WHERE email LIKE $1', [like]);
  // Kids created THROUGH the product carry a synthesised email
  // (`…@no-login.matflow.local`), so they are unreachable by the stamp and
  // must be found through their run-stamped parent instead.
  const ids = mine.map((m) => m.id);
  const kids = ids.length
    ? await sql<{ id: string }>('SELECT id FROM "Member" WHERE "parentMemberId" = ANY($1)', [ids])
    : [];
  const all = [...new Set([...kids.map((k) => k.id), ...ids])];
  if (all.length === 0) {
    await sql('DELETE FROM "MagicLinkToken" WHERE email LIKE $1', [like]).catch(() => {});
    return;
  }

  await sql('DELETE FROM "RankHistory" WHERE "memberRankId" IN (SELECT id FROM "MemberRank" WHERE "memberId" = ANY($1))', [all]).catch(() => {});
  await sql('DELETE FROM "MemberRank" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "ClassPackRedemption" WHERE "memberPackId" IN (SELECT id FROM "MemberClassPack" WHERE "memberId" = ANY($1))', [all]).catch(() => {});
  await sql('DELETE FROM "MemberClassPack" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "ClassSubscription" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "ClassWaitlist" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "SignedWaiver" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "MemberPhoto" WHERE "memberId" = ANY($1) OR "uploadedByMemberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "Payment" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "Order" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "Notification" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "LoginEvent" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('DELETE FROM "PushSubscription" WHERE "memberId" = ANY($1)', [all]).catch(() => {});
  await sql('UPDATE "Task" SET "assigneeMemberId" = NULL WHERE "assigneeMemberId" = ANY($1)', [all]).catch(() => {});
  // Kids first, then everyone else.
  if (kids.length) await sql('DELETE FROM "Member" WHERE id = ANY($1)', [kids.map((k) => k.id)]);
  await sql('DELETE FROM "Member" WHERE id = ANY($1)', [ids]);
  await sql('DELETE FROM "MagicLinkToken" WHERE email LIKE $1', [like]).catch(() => {});

  // Rule 5: verified by a post-delete SELECT, not by the absence of an error.
  const left = await sql<{ id: string }>('SELECT id FROM "Member" WHERE id = ANY($1)', [all]);
  expect(left, "L-C members torn down").toEqual([]);
}

/**
 * A run-stamped Class + ClassSchedule + ClassInstance, for the card scan.
 *
 * `POST /api/checkin/card` requires a `classInstanceId` (route.ts:60) and
 * resolves it BEFORE it looks at a single token — so a scan driven without one
 * never reaches the card logic at all and answers a flat 400 "Invalid data",
 * which is what happened to both revoke cases this round. Scanning into a
 * SEEDED class would write attendance onto another lane's fixture, so this
 * lane brings its own and tears it down.
 */
export async function makeClassInstance(tenantId: string): Promise<{ classId: string; instanceId: string }> {
  const cls = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id","tenantId","name","duration","maxCapacity","isActive","createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 60, 30, true, now()) RETURNING id`,
    [tenantId, `Campaign scan ${RUN_STAMP}`],
  );
  await sql(
    `INSERT INTO "ClassSchedule" ("id","classId","dayOfWeek","startTime","endTime","startDate","isActive")
     VALUES (gen_random_uuid()::text, $1, 1, '18:00', '19:00', now(), true)`,
    [cls[0].id],
  );
  const inst = await sql<{ id: string }>(
    `INSERT INTO "ClassInstance" ("id","classId","date","startTime","endTime","isCancelled")
     VALUES (gen_random_uuid()::text, $1, now(), '18:00', '19:00', false) RETURNING id`,
    [cls[0].id],
  );
  return { classId: cls[0].id, instanceId: inst[0].id };
}

/** The classes this lane created, instances and schedules before the class. */
export async function teardownLcClasses(): Promise<void> {
  const mine = await sql<{ id: string }>('SELECT id FROM "Class" WHERE name LIKE $1', [`%${RUN_STAMP}%`]);
  if (mine.length === 0) return;
  const ids = mine.map((c) => c.id);
  await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [ids]).catch(() => {});
  await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [ids]).catch(() => {});
  await sql('DELETE FROM "ClassInstance" WHERE "classId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "ClassSchedule" WHERE "classId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "ClassSubscription" WHERE "classId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "ClassRoster" WHERE "classId" = ANY($1)', [ids]).catch(() => {});
  await sql('DELETE FROM "Class" WHERE id = ANY($1)', [ids]);
  const left = await sql<{ id: string }>('SELECT id FROM "Class" WHERE id = ANY($1)', [ids]);
  expect(left, "L-C classes torn down").toEqual([]);
}

/** Every ImportJob this lane created, by its stamped original filename. */
export async function teardownImportJobs(): Promise<void> {
  await sql('DELETE FROM "ImportJob" WHERE "fileName" LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
}
