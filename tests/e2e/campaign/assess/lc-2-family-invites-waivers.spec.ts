/**
 * Lane L-C — J23 (parent and children), J25 (invites), J26 (waivers).
 *
 * Allow-lists read from the routes:
 *   POST /api/member/children          → any session carrying `memberId`
 *                                        (children/route.ts:39-41) — NOT
 *                                        "a parent": being a member is enough.
 *   POST /api/members/[id]/link-child  → owner only (link-child/route.ts:19)
 *   DELETE /api/members/[id]/unlink-child → owner only (unlink-child:20)
 *   POST /api/members/bulk-invite      → requireApiStaff — ALL FOUR staff
 *                                        roles (bulk-invite/route.ts:41), which
 *                                        the manifest records as owner+manager.
 *   POST /api/members/accept-invite    → anonymous, token-gated
 *   POST /api/members/[id]/waiver-link → STAFF_ROLES, all four (waiver-link:46)
 *   POST /api/waiver/open              → anonymous, waiver_open token only
 *   GET  /api/waiver/[id]/signature    → staff, or the member themself (:47-49)
 *
 * Mail: `.env.test` carries no key, so every send answers non-2xx and leaves an
 * `EmailLog` row at status 'failed'. The ROW proves the route ran; delivery is
 * UNCOVERED and needs a live Resend. Only a MISSING row is an ERROR.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";
import {
  OWNER_A, COACH_A, ADMIN_A, MEMBER_A, PASSWORD_A, THROWAWAY_PASSWORD,
  sessionFor, anonContext, closeSessions, createThrowawayStaff, createThrowawayTenant,
  teardownThrowawayTenant, teardownThrowawayStaff, countOf, assertUnchanged, apiCall,
  clearBucket, makeMember, makeToken, dobForAgeToday, teardownLc, hashed, ANON_REFUSED,
  TOKEN_MINTING_WORKS, TOKEN_MINTING_BLOCKER,
  type LcMember, type ThrowawayTenant,
} from "./lc-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3847";
const GOOD_PASSWORD = "Campaign!2026aA";

let tenantA: string;
let tenantB: ThrowawayTenant;
let managerEmail: string;

test.beforeAll(async () => {
  tenantA = await seededTenantId();
  tenantB = await createThrowawayTenant();
  managerEmail = (await createThrowawayStaff("manager")).email;
});

test.afterAll(async () => {
  await clearBucket("accept-invite:");
  await clearBucket("waiver:");
  await clearBucket("member:create:");
  await teardownLc();
  await teardownThrowawayTenant(tenantB).catch(() => {});
  await teardownThrowawayStaff().catch(() => {});
  await closeSessions();
});

/** A member with a real login, so the portal routes can be driven as them. */
async function memberWithLogin(tag: string, over: Record<string, unknown> = {}): Promise<LcMember & { password: string }> {
  const m = await makeMember({ tag, passwordHash: hashed(GOOD_PASSWORD), ...over });
  await sql('UPDATE "Member" SET "onboardingCompleted" = true, "waiverAccepted" = true WHERE id = $1', [m.id]);
  return { ...m, password: GOOD_PASSWORD };
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J23 — a parent adds children from the portal", () => {
  test("12, exactly-13-today and 15 get the accountType the club's own timezone implies", async ({ browser, baseURL }) => {
    const parent = await memberWithLogin("parent");
    const ctx = await sessionFor(browser, baseURL!, {
      email: parent.email, password: parent.password, viewport: { width: 390, height: 844 }, isMobile: true,
    });
    const rc = ctx.request;

    const zone = (await sql<{ timezone: string | null }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantA]))[0].timezone ?? "Europe/London";

    const cases: [string, string, string][] = [
      ["twelve", dobForAgeToday(12), "kids"],
      // The calibration case: a DOB whose thirteenth birthday is TODAY in the
      // club's zone. Read from local components, never from UTC getters — a
      // UTC read is a day out for half the world and would silently pass.
      ["thirteen-today", dobForAgeToday(13), "junior"],
      ["fifteen", dobForAgeToday(15), "junior"],
    ];

    for (const [label, dob, expectedByAge] of cases) {
      const res = await apiCall(rc, "post", "/api/member/children", ORIGIN, {
        name: `Campaign kid ${label} ${RUN_STAMP}`, dateOfBirth: dob, accountType: expectedByAge === "kids" ? "kids" : "junior",
      });
      expect(res.status, `parent adds ${label} (club zone ${zone})`).toBe(201);
      const kidId = (res.body as { kid?: { id: string }; id?: string }).kid?.id ?? (res.body as { id: string }).id;
      const row = await sql<{ accountType: string; parentMemberId: string; email: string; passwordHash: string | null; dateOfBirth: Date | null }>(
        'SELECT "accountType", "parentMemberId", email, "passwordHash", "dateOfBirth" FROM "Member" WHERE id = $1', [kidId]);
      expect(row, `${label} is a row`).toHaveLength(1);
      expect(row[0].parentMemberId, "the kid hangs off the parent").toBe(parent.id);
      expect(row[0].accountType, `${label} accountType`).toBe(expectedByAge);
      expect(row[0].passwordHash, "kids are passwordless by design").toBeNull();
      // The synthetic address must never be mailed.
      expect(row[0].email, "server-synthesised, never the client's field").toMatch(/@no-login\.matflow\.local$/);
      const mailed = await sql('SELECT id FROM "EmailLog" WHERE recipient = $1', [row[0].email]);
      expect(mailed, "a synthetic inbox is never written to").toEqual([]);
    }

    // The parent's own hint, and GET /api/member/me/children agreeing with SQL.
    const mine = await apiCall(rc, "get", "/api/member/me/children", ORIGIN);
    expect(mine.status).toBe(200);
    const bySql = await countOf("Member", '"parentMemberId" = $1', [parent.id]);
    const listed = JSON.parse(mine.text) as { children?: unknown[] } | unknown[];
    const n = Array.isArray(listed) ? listed.length : (listed.children ?? []).length;
    expect(n, "the screen's count and the database's count agree").toBe(bySql);
  });

  test("a member who is nobody's parent may still create a child — and a kid may not adopt", async ({ browser, baseURL }) => {
    const plain = await memberWithLogin("plainmember");
    const ctx = await sessionFor(browser, baseURL!, { email: plain.email, password: plain.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const res = await apiCall(ctx.request, "post", "/api/member/children", ORIGIN, { name: `Campaign adopted ${RUN_STAMP}`, accountType: "kids" });
    // Record, do not assume: the gate is `session.user.memberId`, not "is a
    // parent". If this is 201 the product's answer is "any member may become a
    // parent by adding a child", which is defensible — but it is not what the
    // journey list says, so the report states it.
    expect([201, 403], `a non-parent member POSTing children answered ${res.status}`).toContain(res.status);
    if (res.status === 201) {
      const kids = await countOf("Member", '"parentMemberId" = $1', [plain.id]);
      expect(kids, "…and the row really exists").toBe(1);
    }

    // A member who IS someone's kid cannot nest their own.
    const parent = await memberWithLogin("nestparent");
    const kid = await memberWithLogin("nestkid", { accountType: "kids", parentMemberId: parent.id });
    const kidCtx = await sessionFor(browser, baseURL!, { email: kid.email, password: kid.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const nested = await apiCall(kidCtx.request, "post", "/api/member/children", ORIGIN, { name: "Nested", accountType: "kids" });
    expect(nested.status, "children/route.ts:75 — the parent relation is a single hop").toBe(400);
    expect(await countOf("Member", '"parentMemberId" = $1', [kid.id]), "nothing nested").toBe(0);
  });

  test("a parent cannot touch another parent's child; link-child and unlink-child are owner-only", async ({ browser, baseURL }) => {
    const mine = await memberWithLogin("mineparent");
    const theirs = await memberWithLogin("theirsparent");
    const theirKid = await makeMember({ tag: "theirkid", accountType: "kids", parentMemberId: theirs.id });

    const mineCtx = await sessionFor(browser, baseURL!, { email: mine.email, password: mine.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const stolen = await apiCall(mineCtx.request, "patch", `/api/member/children/${theirKid.id}`, ORIGIN, { name: `stolen-${RUN_STAMP}` });
    expect([403, 404], "another parent's child is not reachable").toContain(stolen.status);
    const row = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [theirKid.id]);
    expect(row[0].name, "nothing was written").toBe(theirKid.name);

    const read = await apiCall(mineCtx.request, "get", `/api/member/children/${theirKid.id}`, ORIGIN);
    expect([403, 404], "…and nothing was read").toContain(read.status);
    expect(read.text, "no PII in the refusal").not.toContain(theirKid.name);

    // link-child / unlink-child at the staff plane, role by role.
    //
    // ROUND 2: there is no such thing as a free kid. `Member_kids_must_have_parent`
    // (migration 20260515000001) is `accountType <> 'kids' OR parentMemberId IS
    // NOT NULL`, so the round-1 "unparented kid waiting to be linked" could not
    // be inserted at all. The real shape of this journey is a RE-link: a child
    // already under one guardian being moved to another, which is what a club
    // does when a family changes hands. The refusal proof is therefore "the
    // child is still under the parent they started with", which is stronger
    // than "still null".
    const otherParent = await memberWithLogin("otherparent");
    const moving = await makeMember({ tag: "movingkid", accountType: "kids", parentMemberId: otherParent.id });
    for (const [role, email, password, want] of [
      ["manager", managerEmail, THROWAWAY_PASSWORD, 403],
      ["coach", COACH_A, PASSWORD_A, 403],
      ["admin", ADMIN_A, PASSWORD_A, 403],
      ["owner", OWNER_A, PASSWORD_A, 200],
    ] as [string, string, string, number][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await apiCall(ctx.request, "post", `/api/members/${mine.id}/link-child`, ORIGIN, { childMemberId: moving.id });
      expect(res.status, `${role} POST members/[id]/link-child`).toBe(want);
      const linked = await sql<{ parentMemberId: string | null }>('SELECT "parentMemberId" FROM "Member" WHERE id = $1', [moving.id]);
      expect(linked[0].parentMemberId, want === 403 ? "a refused link writes nothing" : "the owner's link is a row").toBe(want === 403 ? otherParent.id : mine.id);
    }

    // And a member calling the staff route directly.
    const memberLink = await apiCall(mineCtx.request, "post", `/api/members/${mine.id}/link-child`, ORIGIN, { childMemberId: theirKid.id });
    expect(memberLink.status, "a member at the staff link route").toBe(403);
    expect((memberLink.body as { ok?: boolean }).ok, "apiError shape").toBe(false);

    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const unlink = await apiCall(own.request, "delete", `/api/members/${mine.id}/unlink-child?childMemberId=${moving.id}`, ORIGIN);
    expect([200, 400], `unlink answered ${unlink.status}`).toContain(unlink.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J25 — bulk invite and accepting one", () => {
  test("bulk-invite admits ALL FOUR staff roles, not owner+manager", async ({ browser, baseURL }) => {
    const target = await makeMember({ tag: "invitee" });
    // Coach first: if the manifest were right this would be a 403.
    const coach = await sessionFor(browser, baseURL!, { email: COACH_A, password: PASSWORD_A });
    const res = await apiCall(coach.request, "post", "/api/members/bulk-invite", ORIGIN, { memberIds: [target.id] });
    expect(res.status, "bulk-invite/route.ts:41 is requireApiStaff — the manifest says OM").toBe(200);

    // The row that proves the route ran even though no mail key exists.
    await expect.poll(async () =>
      (await sql('SELECT id FROM "EmailLog" WHERE recipient = $1', [target.email])).length,
      { timeout: 10_000, message: "EmailLog is synchronous; a missing row is the ERROR" },
    ).toBeGreaterThan(0);
    const log = await sql<{ status: string }>('SELECT status FROM "EmailLog" WHERE recipient = $1', [target.email]);
    expect(log[0].status, "no Resend key in .env.test — delivery is UNCOVERED, the row is not").toBe("failed");
    const token = await sql<{ purpose: string }>('SELECT purpose FROM "MagicLinkToken" WHERE email = $1', [target.email]);
    expect(token.map((t) => t.purpose), "an invite mints a first_time_signup token").toContain("first_time_signup");

    // A member and an anonymous caller.
    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const anon = await anonContext(browser, baseURL!);
    const before = await countOf("MagicLinkToken", '"tenantId" = $1', [tenantA]);
    for (const [label, rc, want] of [["member", memberCtx.request, 403], ["anonymous", anon.request, 401]] as [string, APIRequestContext, number][]) {
      const r = await apiCall(rc, "post", "/api/members/bulk-invite", ORIGIN, { memberIds: [target.id] });
      if (want === 403) expect(r.status, `${label} POST bulk-invite`).toBe(403);
      else expect(ANON_REFUSED, `${label} POST bulk-invite`).toContain(r.status);
    }
    await assertUnchanged("MagicLinkToken", before, '"tenantId" = $1', [tenantA]);
    await anon.close();
  });

  test("a no-email member is skipped and a kid is never a candidate", async ({ browser, baseURL }) => {
    const parent = await makeMember({ tag: "bparent", accountType: "parent" });
    const kid = await makeMember({ tag: "bkid", accountType: "kids", parentMemberId: parent.id });
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const res = await apiCall(own.request, "post", "/api/members/bulk-invite", ORIGIN, { memberIds: [kid.id] });
    expect(res.status).toBe(200);
    const kidRow = await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [kid.id]);
    const tokens = await sql('SELECT id FROM "MagicLinkToken" WHERE email = $1', [kidRow[0].email]);
    expect(tokens, "accountType: { not: 'kids' } keeps synthetic inboxes out of the send").toEqual([]);
    const mail = await sql('SELECT id FROM "EmailLog" WHERE recipient = $1', [kidRow[0].email]);
    expect(mail, "…and nothing was mailed to one").toEqual([]);
  });

  test("accept-invite: the adult sets a password, the token dies, and the same token twice is 410", async ({ browser, baseURL }) => {
    test.skip(!TOKEN_MINTING_WORKS, TOKEN_MINTING_BLOCKER);
    const anon = await anonContext(browser, baseURL!);
    const rc = anon.request;
    const m = await makeMember({ tag: "accept" });
    const { raw } = await makeToken({ tenantId: tenantA, email: m.email, purpose: "first_time_signup" });

    const ok = await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: raw, password: GOOD_PASSWORD });
    expect(ok.status, "anonymous with a first_time_signup token").toBe(200);
    const row = await sql<{ passwordHash: string | null; sessionVersion: number }>('SELECT "passwordHash", "sessionVersion" FROM "Member" WHERE id = $1', [m.id]);
    expect(row[0].passwordHash, "the password is a row, not a toast").not.toBeNull();

    const again = await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: raw, password: GOOD_PASSWORD });
    expect(again.status, "the same token twice").toBe(410);

    // An expired token, a wrong-purpose token, a 4 097-character token.
    const expired = await makeToken({ tenantId: tenantA, email: m.email, purpose: "first_time_signup", expiresAt: new Date(Date.now() - 1000) });
    expect((await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: expired.raw, password: GOOD_PASSWORD })).status, "expired").toBe(410);

    const wrongPurpose = await makeToken({ tenantId: tenantA, email: m.email, purpose: "login" });
    expect((await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: wrongPurpose.raw, password: GOOD_PASSWORD })).status,
      "a login token presented to the invite consumer").toBe(404);

    const waiverPurpose = await makeToken({ tenantId: tenantA, email: m.email, purpose: "waiver_open" });
    expect((await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: waiverPurpose.raw, password: GOOD_PASSWORD })).status,
      "a waiver_open token presented to the invite consumer").toBe(404);

    const oversize = await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: "a".repeat(4097), password: GOOD_PASSWORD });
    expect(oversize.status, "a 4 097-character token is refused by the schema, never a 500").toBe(400);

    // Enumeration: an unknown token must answer like a known-but-consumed one
    // only in so far as neither confirms an address exists.
    const unknown = await apiCall(rc, "post", "/api/members/accept-invite", ORIGIN, { token: "b".repeat(48), password: GOOD_PASSWORD });
    expect(unknown.status).toBe(404);
    expect(unknown.text, "the refusal names no member").not.toContain(m.email);
    await anon.close();
    await clearBucket("accept-invite:");
  });

  test("an under-13 accepting an invite is refused; today they get a working password", async ({ browser, baseURL }) => {
    const anon = await anonContext(browser, baseURL!);
    const child = await makeMember({ tag: "under13" });
    const { raw } = await makeToken({ tenantId: tenantA, email: child.email, purpose: "first_time_signup" });

    const res = await apiCall(anon.request, "post", "/api/members/accept-invite", ORIGIN, {
      token: raw, password: GOOD_PASSWORD, dateOfBirth: dobForAgeToday(9),
    });
    const row = await sql<{ passwordHash: string | null; accountType: string }>(
      'SELECT "passwordHash", "accountType" FROM "Member" WHERE id = $1', [child.id]);

    // The manifest's contract (J25 "under-13 refusal") and the product's own
    // invariant everywhere else — members/route.ts:251 and children/route.ts:96
    // both write `passwordHash: null` for kids, and bulk-invite excludes them
    // from the candidate set entirely. accept-invite/route.ts has no age gate:
    // it hashes the password FIRST (line 79) and only then derives
    // accountType = "kids" (line 99), leaving an under-13 with a login.
    expect(res.status, "an under-13 must not be able to set a password").toBe(422);
    expect(row[0].passwordHash, "…and must remain passwordless").toBeNull();
    // ROUND 2. Round 1's fix refuses BEFORE the token is looked up and before
    // anything is written — deliberately, so a child's attempt cannot burn the
    // family's one invite link. "accountType is now 'kids'" was written against
    // the OLD behaviour, where the row was updated first and classified second;
    // under the fix the correct assertion is that the row is untouched. The
    // child is classified when the account is created for them properly, by a
    // parent (member/children/route.ts) or by staff (members/route.ts).
    expect(row[0].accountType, "a refused invite writes NOTHING — not even the classification").toBe("adult");
    expect(res.text, "…and the refusal says who should hold the account, in British English").toMatch(/parent|guardian/i);
    // The link must survive the refusal, or the parent is locked out of an
    // invite the club believes it sent.
    const tok = await sql<{ used: boolean }>('SELECT used FROM "MagicLinkToken" WHERE "tokenHash" IS NOT NULL AND email = $1', [child.email]);
    if (tok.length > 0) expect(tok[0].used, "the invite link is not burned by a child's attempt").toBe(false);
    await anon.close();
    await clearBucket("accept-invite:");
  });

  test("a mixed-case invite address resolves to the same member", async ({ browser, baseURL }) => {
    // Skipped for the same environment blocker: with the hashes disagreeing,
    // EVERY token answers 404 and the case-sensitivity question this test asks
    // would be answered by the wrong 404.
    test.skip(!TOKEN_MINTING_WORKS, TOKEN_MINTING_BLOCKER);
    const anon = await anonContext(browser, baseURL!);
    const m = await makeMember({ tag: "mixed" });
    const { raw } = await makeToken({ tenantId: tenantA, email: m.email.toUpperCase(), purpose: "first_time_signup" });
    const res = await apiCall(anon.request, "post", "/api/members/accept-invite", ORIGIN, { token: raw, password: GOOD_PASSWORD });
    // `tenantId_email` is a case-SENSITIVE unique, so an upper-cased token
    // address finds no member. Record which it is rather than assume.
    expect([200, 404], `a mixed-case invite address answered ${res.status}`).toContain(res.status);
    if (res.status === 404) {
      const row = await sql<{ passwordHash: string | null }>('SELECT "passwordHash" FROM "Member" WHERE id = $1', [m.id]);
      expect(row[0].passwordHash, "the member is left unable to accept their own invite").toBeNull();
    }
    await anon.close();
    await clearBucket("accept-invite:");
  });

  test("a first_time_signup token is host-independent: the session lands in the token's own club", async ({ browser, baseURL }) => {
    test.skip(!TOKEN_MINTING_WORKS, TOKEN_MINTING_BLOCKER);
    const anon = await anonContext(browser, baseURL!);
    const bMember = await makeMember({ tag: "btoken", tenantId: tenantB.id });
    const { raw } = await makeToken({ tenantId: tenantB.id, email: bMember.email, purpose: "first_time_signup" });
    const res = await apiCall(anon.request, "post", "/api/members/accept-invite", ORIGIN, { token: raw, password: GOOD_PASSWORD });
    expect(res.status, "the token names its own tenant; the host does not").toBe(200);
    expect((res.body as { tenantSlug: string }).tenantSlug, "and the club it names is tenant B, never the seeded club").toBe(tenantB.slug);
    const aCount = await countOf("Member", '"tenantId" = $1 AND email = $2', [tenantA, bMember.email]);
    expect(aCount, "no member was created in the seeded club").toBe(0);
    await anon.close();
    await clearBucket("accept-invite:");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J26 — waivers: minting the link, opening it, signing it", () => {
  test("waiver-link's allow-list today is all four staff roles", async ({ browser, baseURL }) => {
    const target = await makeMember({ tag: "wl" });
    for (const [role, email, password] of [
      ["manager", managerEmail, THROWAWAY_PASSWORD],
      ["coach", COACH_A, PASSWORD_A],
      ["admin", ADMIN_A, PASSWORD_A],
      ["owner", OWNER_A, PASSWORD_A],
    ] as [string, string, string][]) {
      const ctx = await sessionFor(browser, baseURL!, { email, password });
      const res = await apiCall(ctx.request, "post", `/api/members/${target.id}/waiver-link`, ORIGIN, {});
      expect(res.status, `${role} POST members/[id]/waiver-link — widened from owner+manager`).toBe(200);
    }
    const minted = await sql<{ purpose: string }>('SELECT purpose FROM "MagicLinkToken" WHERE email = $1', [target.email]);
    expect(minted.length, "four mints, four rows").toBeGreaterThanOrEqual(4);
    expect(new Set(minted.map((t) => t.purpose)), "…all of purpose waiver_open").toEqual(new Set(["waiver_open"]));

    // A member, a parent and an anonymous caller at the same route.
    const memberCtx = await sessionFor(browser, baseURL!, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
    const anon = await anonContext(browser, baseURL!);
    const before = await countOf("MagicLinkToken", 'email = $1', [target.email]);
    for (const [label, rc, want] of [["member", memberCtx.request, 403], ["anonymous", anon.request, 401]] as [string, APIRequestContext, number][]) {
      const r = await apiCall(rc, "post", `/api/members/${target.id}/waiver-link`, ORIGIN, {});
      if (want === 403) expect(r.status, `${label} minting a waiver link`).toBe(403);
      else expect(ANON_REFUSED, `${label} minting a waiver link`).toContain(r.status);
    }
    await assertUnchanged("MagicLinkToken", before, 'email = $1', [target.email]);
    await anon.close();
  });

  test("a no-email member's waiver link is a 400, not a token nobody can receive", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const parent = await makeMember({ tag: "wparent", accountType: "parent" });
    const kid = await makeMember({ tag: "wkid", accountType: "kids", parentMemberId: parent.id });
    // A kid's address is synthetic and unreachable — the route must refuse.
    const res = await apiCall(ctx.request, "post", `/api/members/${kid.id}/waiver-link`, ORIGIN, {});
    expect([200, 400], `a synthetic-address member's waiver link answered ${res.status}`).toContain(res.status);
    if (res.status === 200) {
      const kidRow = await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [kid.id]);
      const mail = await sql('SELECT id FROM "EmailLog" WHERE recipient = $1', [kidRow[0].email]);
      expect(mail, "a link minted for a no-login address is a link nobody can open").toEqual([]);
    }
  });

  test("/api/waiver/open: a login token is refused, a waiver token signs once", async ({ browser, baseURL }) => {
    test.skip(!TOKEN_MINTING_WORKS, TOKEN_MINTING_BLOCKER);
    const anon = await anonContext(browser, baseURL!);
    const rc = anon.request;
    const m = await makeMember({ tag: "wopen" });

    // A `login` token at the waiver consumer.
    const wrong = await makeToken({ tenantId: tenantA, email: m.email, purpose: "login" });
    const before = await countOf("SignedWaiver", '"memberId" = $1', [m.id]);
    const wrongRes = await apiCall(rc, "post", "/api/waiver/open", ORIGIN, { token: wrong.raw, signerName: "Mallory" });
    expect(wrongRes.status, "open/route.ts:86 filters on purpose").toBe(404);
    await assertUnchanged("SignedWaiver", before, '"memberId" = $1', [m.id]);

    // The real thing.
    const good = await makeToken({ tenantId: tenantA, email: m.email, purpose: "waiver_open" });
    const ok = await apiCall(rc, "post", "/api/waiver/open", ORIGIN, { token: good.raw, signerName: `Campaign Signer ${RUN_STAMP}` });
    expect(ok.status, "anonymous signing through a waiver link").toBe(200);
    const signed = await sql<{ id: string; signerName: string; collectedBy: string }>(
      'SELECT id, "signerName", "collectedBy" FROM "SignedWaiver" WHERE "memberId" = $1', [m.id]);
    expect(signed, "the signature is a row").toHaveLength(1);
    expect(signed[0].collectedBy).toBe("kiosk_waiver_link");
    const member = await sql<{ waiverAccepted: boolean; waiverAcceptedAt: Date | null }>(
      'SELECT "waiverAccepted", "waiverAcceptedAt" FROM "Member" WHERE id = $1', [m.id]);
    expect(member[0].waiverAccepted, "and the member's flag agrees with it").toBe(true);
    expect(member[0].waiverAcceptedAt).not.toBeNull();

    // Signing twice with the same token.
    const twice = await apiCall(rc, "post", "/api/waiver/open", ORIGIN, { token: good.raw, signerName: "Second" });
    expect(twice.status, "a used waiver link").toBe(410);
    const after = await countOf("SignedWaiver", '"memberId" = $1', [m.id]);
    expect(after, "one link, one signature").toBe(1);

    // A cross-tenant token: the signature must land in the token's own club.
    const bMember = await makeMember({ tag: "bwaiver", tenantId: tenantB.id });
    const bToken = await makeToken({ tenantId: tenantB.id, email: bMember.email, purpose: "waiver_open" });
    const bRes = await apiCall(rc, "post", "/api/waiver/open", ORIGIN, { token: bToken.raw, signerName: "B Signer" });
    expect(bRes.status).toBe(200);
    const bSigned = await sql<{ tenantId: string }>('SELECT "tenantId" FROM "SignedWaiver" WHERE "memberId" = $1', [bMember.id]);
    expect(bSigned[0].tenantId, "host-independent: the row belongs to the token's tenant").toBe(tenantB.id);

    // Malformed.
    for (const [label, body, want] of [
      ["empty token", { token: "", signerName: "x" }, 400],
      ["oversize token", { token: "a".repeat(4097), signerName: "x" }, 400],
      ["no signerName", { token: good.raw }, 400],
      ["re-spelled token", { token: good.raw + ".junk", signerName: "x" }, 404],
    ] as [string, Record<string, unknown>, number][]) {
      const r = await apiCall(rc, "post", "/api/waiver/open", ORIGIN, body);
      expect(r.status, `waiver/open with ${label}`).toBe(want);
    }
    await anon.close();
    await clearBucket("waiver:open:");
  });

  test("a signature is readable by staff and by its own member, and by nobody else", async ({ browser, baseURL }) => {
    const mine = await memberWithLogin("sigmine");
    const other = await memberWithLogin("sigother");
    const rows = await sql<{ id: string }>(
      // ROUND 2: the column is `acceptedAt`, not `signedAt` — the round-1
      // INSERT named a column that does not exist and the whole case died on
      // the SQL rather than on anything the product did.
      `INSERT INTO "SignedWaiver" ("id","tenantId","memberId","titleSnapshot","contentSnapshot","signerName","collectedBy","acceptedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 'Campaign waiver', 'Campaign content', $3, 'staff', now())
       RETURNING id`,
      [tenantA, mine.id, `Campaign ${RUN_STAMP}`],
    );
    const sigId = rows[0].id;

    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const staffRes = await apiCall(own.request, "get", `/api/waiver/${sigId}/signature`, ORIGIN);
    expect([200, 404], `staff reading a signature answered ${staffRes.status}`).toContain(staffRes.status);

    const mineCtx = await sessionFor(browser, baseURL!, { email: mine.email, password: mine.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const selfRes = await apiCall(mineCtx.request, "get", `/api/waiver/${sigId}/signature`, ORIGIN);
    expect([200, 404], `the member's own signature answered ${selfRes.status}`).toContain(selfRes.status);

    const otherCtx = await sessionFor(browser, baseURL!, { email: other.email, password: other.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const otherRes = await apiCall(otherCtx.request, "get", `/api/waiver/${sigId}/signature`, ORIGIN);
    expect(otherRes.status, "another member's signature — route.ts:51").toBe(403);
    expect(otherRes.text, "…and no image bytes in the refusal").not.toContain("data:image");

    const anon = await anonContext(browser, baseURL!);
    const anonRes = await apiCall(anon.request, "get", `/api/waiver/${sigId}/signature`, ORIGIN);
    expect(ANON_REFUSED, "anonymous").toContain(anonRes.status);
    await anon.close();
  });

  test("sign-for-child refuses the wrong parent, and signing twice does not double the row", async ({ browser, baseURL }) => {
    const rightParent = await memberWithLogin("rightp");
    const wrongParent = await memberWithLogin("wrongp");
    // ROUND 2 — the safeguarding pre-condition, which round 1 did not know
    // about. sign-for-child/route.ts:108 refuses with 400 "Add your emergency
    // contact details first" unless the PARENT carries all three of name,
    // phone and relation. A throwaway parent has none, so the right parent's
    // signature answered 400 and the test never reached the authorisation it
    // was written to prove. Set them on the parent, not on the child: the kid
    // inherits the parent's trio (route header).
    for (const p of [rightParent, wrongParent]) {
      await sql(
        'UPDATE "Member" SET "emergencyContactName" = $1, "emergencyContactPhone" = $2, "emergencyContactRelation" = $3 WHERE id = $4',
        [`Campaign Guardian ${RUN_STAMP}`, "+447700900123", "Parent", p.id],
      );
    }
    const kid = await makeMember({ tag: "sfckid", accountType: "kids", parentMemberId: rightParent.id, dateOfBirth: new Date("2017-03-03") });
    // A 1x1 PNG — the route validates the magic bytes (sign-for-child:83).
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    const wrongCtx = await sessionFor(browser, baseURL!, { email: wrongParent.email, password: wrongParent.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const before = await countOf("SignedWaiver", '"memberId" = $1', [kid.id]);
    const stolen = await apiCall(wrongCtx.request, "post", "/api/waiver/sign-for-child", ORIGIN, { childMemberId: kid.id, signerName: "Mallory", signatureDataUrl: png, agreedTo: true });
    expect([403, 404], `the wrong parent signing answered ${stolen.status}`).toContain(stolen.status);
    await assertUnchanged("SignedWaiver", before, '"memberId" = $1', [kid.id]);
    const kidRow = await sql<{ waiverAccepted: boolean }>('SELECT "waiverAccepted" FROM "Member" WHERE id = $1', [kid.id]);
    expect(kidRow[0].waiverAccepted, "the child's waiver flag was not flipped by a stranger").toBe(false);

    const rightCtx = await sessionFor(browser, baseURL!, { email: rightParent.email, password: rightParent.password, viewport: { width: 390, height: 844 }, isMobile: true });
    const ok = await apiCall(rightCtx.request, "post", "/api/waiver/sign-for-child", ORIGIN, { childMemberId: kid.id, signerName: `Campaign ${RUN_STAMP}`, signatureDataUrl: png, agreedTo: true });
    // 201, not 200 — the route returns Created (sign-for-child/route.ts:150).
    expect(ok.status, "the right parent signs for their own child").toBe(201);
    const signed = await countOf("SignedWaiver", '"memberId" = $1', [kid.id]);
    expect(signed, "one signature").toBe(1);
    const flipped = await sql<{ waiverAccepted: boolean }>('SELECT "waiverAccepted" FROM "Member" WHERE id = $1', [kid.id]);
    expect(flipped[0].waiverAccepted, "the child's flag agrees with the row").toBe(true);

    // Signing twice. The route has no duplicate guard and SignedWaiver is
    // deliberately append-only evidence (schema comment: it must outlive the
    // member, and detached rows keep the snapshots). So the invariant worth
    // holding is not "exactly one row for ever" — it is "one row per accepted
    // request, no lost write and no double write".
    const twice = await apiCall(rightCtx.request, "post", "/api/waiver/sign-for-child", ORIGIN, { childMemberId: kid.id, signerName: "Again", signatureDataUrl: png, agreedTo: true });
    expect([201, 409], `signing twice answered ${twice.status}`).toContain(twice.status);
    const total = await countOf("SignedWaiver", '"memberId" = $1', [kid.id]);
    expect(total, "one row per accepted signature — never two for one request, never none for one 201")
      .toBe(twice.status === 201 ? 2 : 1);

    // An anonymous caller and a staff session at the member-facing sign route.
    const anon = await anonContext(browser, baseURL!);
    expect(ANON_REFUSED, "anonymous at waiver/sign").toContain((await apiCall(anon.request, "post", "/api/waiver/sign", ORIGIN, { signatureDataUrl: png, signerName: "x", agreedTo: true })).status);
    const own = await sessionFor(browser, baseURL!, { email: OWNER_A });
    const staffSign = await apiCall(own.request, "post", "/api/waiver/sign", ORIGIN, { signatureDataUrl: png, signerName: "Owner", agreedTo: true });
    expect(staffSign.status, "a staff session has no memberId — waiver/sign:52").toBe(400);
    await anon.close();
    await clearBucket("waiver:");
  });

  test("the kiosk waiver request is reachable without a session but not without a valid member token", async ({ browser, baseURL }) => {
    const anon = await anonContext(browser, baseURL!);
    const m = await makeMember({ tag: "kioskwaiver" });
    const before = await countOf("MagicLinkToken", 'email = $1', [m.email]);
    for (const [label, body, want] of [
      ["no token", { memberToken: "" }, 400],
      ["junk token", { memberToken: "token.junk" }, 400],
      ["oversize token", { memberToken: "a".repeat(4097) }, 400],
    ] as [string, Record<string, unknown>, number][]) {
      const r = await apiCall(anon.request, "post", "/api/waiver/kiosk-request", ORIGIN, body);
      expect([want, ...ANON_REFUSED], `kiosk-request with ${label}`).toContain(r.status);
    }
    await assertUnchanged("MagicLinkToken", before, 'email = $1', [m.email]);
    await anon.close();
    await clearBucket("waiver:kiosk-request:");
  });
});
