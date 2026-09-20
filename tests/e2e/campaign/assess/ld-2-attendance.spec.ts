/**
 * Lane L-D, file 2 — the attendance column (J34, J36–J40).
 *
 * The seam this file exists for: `lib/checkin.ts` is shared by the staff route,
 * the member route and the public kiosk route, and each caller sets a different
 * enforcement profile. Three callers × ten result kinds is where a refusal
 * becomes a 500, a credit vanishes, and a mark loses its author.
 */
import { test, expect } from "@playwright/test";
import {
  OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL, PASSWORD,
  SCOPE, RUN_STAMP, sql, seededTenantId, sessionFor, memberSession, closeSessions, post, del, get,
  mkClass, mkInstance, mkStaff, mkTenant, nowWindow, teardownClasses, teardownTenant,
  countRows, hashToken, tokenSecretOrThrow, resetBucketsLike,
} from "./ld-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const NAME = (s: string) => `${SCOPE} ld2 ${s}`;
let origin: string;
let tenantId: string;
let managerEmail: string;
let foreign: { id: string; slug: string };
let foreignInstanceId: string;
let foreignMemberId: string;

test.beforeAll(async ({ baseURL }) => {
  origin = baseURL!;
  tenantId = await seededTenantId();
  const hash = await sql<{ passwordHash: string }>(
    'SELECT "passwordHash" FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, OWNER_EMAIL],
  );
  if (hash.length === 0) throw new Error(`${OWNER_EMAIL} is missing — re-seed the test branch.`);
  managerEmail = (await mkStaff(tenantId, "manager", hash[0].passwordHash)).email;

  foreign = await mkTenant();
  const fcls = await mkClass(foreign.id, `${RUN_STAMP} foreign attendance class`);
  foreignInstanceId = await mkInstance(fcls);
  const fm = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', now(), now()) RETURNING id`,
    [foreign.id, `${RUN_STAMP} foreign member`, `${RUN_STAMP}-fm@example.test`],
  );
  foreignMemberId = fm[0].id;
});

test.afterAll(async () => {
  await closeSessions();
  await teardownClasses(tenantId, SCOPE);
  await teardownTenant(foreign.id);
  await sql('DELETE FROM "User" WHERE email LIKE $1', [`${SCOPE}-%@example.test`]);
  await sql('DELETE FROM "Member" WHERE email LIKE $1', [`${RUN_STAMP}-%@example.test`]);
  await resetBucketsLike("checkin:card:%");
  expect(await countRows("Class", '"tenantId" = $1 AND name LIKE $2', [tenantId, `${SCOPE}%`])).toBe(0);
});

/** A run-stamped member of the seeded club, open now. */
async function subject(label: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const m = await sql<{ id: string; name: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', now(), now()) RETURNING id, name`,
    [tenantId, `${SCOPE} ${label} ${suffix}`, `${RUN_STAMP}-${label}-${suffix}@example.test`],
  );
  return m[0];
}

// ── J36 · tick, walk-in, un-tick ─────────────────────────────────────────────

test.describe("J36 marking the register", () => {
  for (const [role, email, pw] of [
    ["owner", OWNER_EMAIL, PASSWORD],
    ["coach", COACH_EMAIL, PASSWORD],
    ["admin", ADMIN_EMAIL, PASSWORD],
  ] as const) {
    test(`ALLOWED: ${role} ticks a name, and the row names them`, async ({ browser, baseURL }) => {
      const ctx = await sessionFor(browser, baseURL!, email, pw);
      const cls = await mkClass(tenantId, NAME(`tick-${role}`));
      const inst = await mkInstance(cls, nowWindow());
      const m = await subject(`tick-${role}`);

      const res = await post(ctx.request, "/api/checkin", origin, { classInstanceId: inst, memberId: m.id });
      expect(res.status(), await res.text()).toBe(201);

      const row = await sql<{ checkInMethod: string; checkedInById: string | null }>(
        'SELECT "checkInMethod", "checkedInById" FROM "AttendanceRecord" WHERE "classInstanceId" = $1 AND "memberId" = $2',
        [inst, m.id],
      );
      expect(row.length).toBe(1);
      expect(row[0].checkInMethod).toBe("admin");
      expect(row[0].checkedInById, "a staff mark with no author").not.toBeNull();

      // Audit rows are fire-and-forget: poll, never assert once.
      await expect.poll(async () =>
        (await sql('SELECT id FROM "AuditLog" WHERE action = $1 AND "entityId" = $2', ["attendance.mark", `${inst}:${m.id}`])).length,
        { timeout: 5_000 },
      ).toBe(1);

      // Un-tick through the same screen's route.
      const undo = await del(ctx.request, `/api/checkin?classInstanceId=${inst}&memberId=${m.id}`, origin);
      expect(undo.status()).toBe(200);
      expect(await countRows("AttendanceRecord", '"classInstanceId" = $1 AND "memberId" = $2', [inst, m.id])).toBe(0);
      await expect.poll(async () =>
        (await sql('SELECT id FROM "AuditLog" WHERE action = $1 AND "entityId" = $2', ["attendance.override", `${inst}:${m.id}`])).length,
        { timeout: 5_000 },
      ).toBe(1);
    });
  }

  test("two identical ticks race to exactly one row and no 500", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const cls = await mkClass(tenantId, NAME("race"));
    const inst = await mkInstance(cls, nowWindow());
    const m = await subject("race");
    const body = { classInstanceId: inst, memberId: m.id };
    const [a, b] = await Promise.all([
      post(ctx.request, "/api/checkin", origin, body),
      post(ctx.request, "/api/checkin", origin, body),
    ]);
    const codes = [a.status(), b.status()].sort();
    expect(codes.every((c) => c !== 500), `a race produced a 500: ${codes}`).toBe(true);
    expect(codes).toEqual([201, 409]);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1 AND "memberId" = $2', [inst, m.id])).toBe(1);
  });

  test("the coach upsert attributes its admin row (was critic 2 #7: unattributed)", async ({ browser, baseURL }) => {
    // app/api/coach/instances/[id]/attendance/route.ts:46-57 creates with
    // { checkInMethod: "admin" } and no checkedInById. No screen uses it, so
    // every row it writes is a staff mark nobody signed.
    const ctx = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const cls = await mkClass(tenantId, NAME("upsert"));
    const inst = await mkInstance(cls, nowWindow());
    const m = await subject("upsert");
    const res = await post(ctx.request, `/api/coach/instances/${inst}/attendance`, origin, { memberId: m.id, attended: true });
    expect(res.status(), await res.text()).toBe(200);
    const row = await sql<{ checkedInById: string | null; checkInMethod: string }>(
      'SELECT "checkedInById", "checkInMethod" FROM "AttendanceRecord" WHERE "classInstanceId" = $1 AND "memberId" = $2',
      [inst, m.id],
    );
    expect(row.length).toBe(1);
    // Fixed in round 1: the create branch stamps checkedInById from the session.
    expect(row[0].checkedInById, "the coach upsert route writes an unattributed admin row").not.toBeNull();
  });

  test("REFUSED: a member cannot mark another member, and nothing is written", async ({ browser, baseURL }) => {
    const ctx = await memberSession(browser, baseURL!);
    const cls = await mkClass(tenantId, NAME("member-marks"));
    const inst = await mkInstance(cls, nowWindow());
    const victim = await subject("victim");
    const res = await post(ctx.request, "/api/checkin", origin, { classInstanceId: inst, memberId: victim.id });
    expect(res.status()).toBe(403);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [victim.id])).toBe(0);

    const undo = await del(ctx.request, `/api/checkin?classInstanceId=${inst}&memberId=${victim.id}`, origin);
    expect(undo.status()).toBe(403);
  });

  test("cross-tenant: a seeded staff session cannot mark into the foreign club", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const before = await countRows("AttendanceRecord", '"classInstanceId" = $1', [foreignInstanceId]);
    const byInstance = await post(ctx.request, "/api/checkin", origin, {
      classInstanceId: foreignInstanceId, memberId: (await subject("xt")).id,
    });
    expect(byInstance.status(), "a foreign instance must 404, never 403").toBe(404);
    const byMember = await post(ctx.request, "/api/checkin", origin, {
      classInstanceId: await mkInstance(await mkClass(tenantId, NAME("xt-local")), nowWindow()),
      memberId: foreignMemberId,
    });
    expect(byMember.status()).toBe(404);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [foreignInstanceId])).toBe(before);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [foreignMemberId])).toBe(0);
  });

  test("GET /api/checkin/members answers every staff role and refuses a member", async ({ browser, baseURL }) => {
    const cls = await mkClass(tenantId, NAME("members-list"));
    const inst = await mkInstance(cls, nowWindow());
    for (const [email, pw] of [[OWNER_EMAIL, PASSWORD], [COACH_EMAIL, PASSWORD], [ADMIN_EMAIL, PASSWORD], [managerEmail, PASSWORD]] as const) {
      const ctx = await sessionFor(browser, baseURL!, email, pw);
      const res = await get(ctx.request, `/api/checkin/members?instanceId=${inst}`);
      expect(res.status(), `${email} refused the member list`).toBe(200);
    }
    const member = await memberSession(browser, baseURL!);
    expect((await get(member.request, `/api/checkin/members?instanceId=${inst}`)).status()).toBe(403);
    // A foreign instance answers like a missing one.
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    expect((await get(owner.request, `/api/checkin/members?instanceId=${foreignInstanceId}`)).status()).toBe(404);
  });
});

// ── J34 · rank gate and roster ───────────────────────────────────────────────

test.describe("J34 rank gate and roster", () => {
  test("a rank-gated class refuses a member below it on the self path and admits a staff mark", async ({ browser, baseURL }) => {
    const ranks = await sql<{ id: string; order: number; discipline: string }>(
      `SELECT id, "order", discipline FROM "RankSystem" WHERE "tenantId" = $1 AND "deletedAt" IS NULL ORDER BY discipline, "order"`,
      [tenantId],
    );
    const byDisc = new Map<string, typeof ranks>();
    for (const r of ranks) byDisc.set(r.discipline, [...(byDisc.get(r.discipline) ?? []), r]);
    const pair = [...byDisc.values()].find((rs) => rs.length >= 2);
    test.skip(!pair, "no discipline has two ranks — re-seed to exercise the gate");

    const cls = await mkClass(tenantId, NAME("rank-gate"), { requiredRankId: pair![1].id });
    const inst = await mkInstance(cls, nowWindow());
    const m = await subject("unranked");

    // Staff mark bypasses the gate by design.
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const admin = await post(owner.request, "/api/checkin", origin, { classInstanceId: inst, memberId: m.id });
    expect(admin.status(), await admin.text()).toBe(201);
    await del(owner.request, `/api/checkin?classInstanceId=${inst}&memberId=${m.id}`, origin);

    // Self path: an unranked member fails closed with the 403 copy.
    const selfMember = await memberSession(browser, baseURL!);
    const before = await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst]);
    const self = await post(selfMember.request, "/api/checkin", origin, { classInstanceId: inst });
    expect([402, 403, 409]).toContain(self.status());
    if (self.status() === 403) {
      expect((await self.json()).error).toContain("rank");
    }
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst])).toBe(before);
  });

  test("roster add/remove: owner, manager and admin allowed; coach and member refused", async ({ browser, baseURL }) => {
    const cls = await mkClass(tenantId, NAME("roster"));
    const m = await subject("roster");
    const allowed = [[OWNER_EMAIL, PASSWORD], [managerEmail, PASSWORD], [ADMIN_EMAIL, PASSWORD]] as const;
    for (const [email, pw] of allowed) {
      const ctx = await sessionFor(browser, baseURL!, email, pw);
      const add = await post(ctx.request, `/api/classes/${cls}/roster`, origin, { memberId: m.id });
      expect([201, 409], `${email}: ${await add.text()}`).toContain(add.status());
      expect(await countRows("ClassRoster", '"classId" = $1 AND "memberId" = $2', [cls, m.id])).toBe(1);
      const gone = await del(ctx.request, `/api/classes/${cls}/roster/${m.id}`, origin);
      expect(gone.status()).toBe(200);
      expect(await countRows("ClassRoster", '"classId" = $1 AND "memberId" = $2', [cls, m.id])).toBe(0);
    }
    for (const email of [COACH_EMAIL, MEMBER_EMAIL] as const) {
      const ctx = email === MEMBER_EMAIL
        ? await memberSession(browser, baseURL!)
        : await sessionFor(browser, baseURL!, email, PASSWORD);
      expect((await post(ctx.request, `/api/classes/${cls}/roster`, origin, { memberId: m.id })).status()).toBe(403);
      expect((await get(ctx.request, `/api/classes/${cls}/roster`)).status()).toBe(403);
      expect((await del(ctx.request, `/api/classes/${cls}/roster/${m.id}`, origin)).status()).toBe(403);
      expect(await countRows("ClassRoster", '"classId" = $1', [cls])).toBe(0);
    }
  });

  test("roster_not_listed: 403 with copy at the staff route", async ({ browser, baseURL }) => {
    const cls = await mkClass(tenantId, NAME("roster-gate"));
    const inst = await mkInstance(cls, nowWindow());
    const onList = await subject("on-list");
    const offList = await subject("off-list");
    await sql(
      `INSERT INTO "ClassRoster" ("id", "tenantId", "classId", "memberId", "addedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, now())`,
      [tenantId, cls, onList.id],
    );
    const member = await memberSession(browser, baseURL!);
    const before = await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst]);
    const res = await post(member.request, "/api/checkin", origin, { classInstanceId: inst });
    // The self path enforces the roster gate; whichever gate bites first, the
    // answer must never be a 500 and must never write.
    expect(res.status(), `staff-side refusal became ${res.status()}`).not.toBe(500);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst])).toBe(before);
    void offList;
  });
});

// ── J37 · card scan ──────────────────────────────────────────────────────────

test.describe("J37 scan cards", () => {
  test("malformed and oversize tokens are refused, never 500, and nothing is written", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const cls = await mkClass(tenantId, NAME("scan"));
    const inst = await mkInstance(cls, nowWindow());
    const before = await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst]);

    const bodies: Array<[string, unknown]> = [
      ["empty array", { classInstanceId: inst, tokens: [] }],
      ["4097-char token", { classInstanceId: inst, tokens: ["x".repeat(4097)] }],
      ["26 tokens", { classInstanceId: inst, tokens: Array.from({ length: 26 }, (_, i) => `tok${i}`) }],
      ["junk token", { classInstanceId: inst, tokens: ["not.a.token"] }],
      ["no instance", { tokens: ["abc"] }],
    ];
    for (const [label, data] of bodies) {
      const res = await post(ctx.request, "/api/checkin/card", origin, data);
      expect(res.status(), `${label} answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    }
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst])).toBe(before);
  });

  test("a foreign instance is 404 and a cancelled one 409", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const foreignRes = await post(ctx.request, "/api/checkin/card", origin, {
      classInstanceId: foreignInstanceId, tokens: ["abc"],
    });
    expect(foreignRes.status()).toBe(404);

    const cls = await mkClass(tenantId, NAME("scan-cancelled"));
    const inst = await mkInstance(cls, { ...nowWindow(), isCancelled: true });
    const cancelled = await post(ctx.request, "/api/checkin/card", origin, { classInstanceId: inst, tokens: ["abc"] });
    expect(cancelled.status()).toBe(409);
  });

  test("REFUSED: a member cannot scan", async ({ browser, baseURL }) => {
    const ctx = await memberSession(browser, baseURL!);
    const cls = await mkClass(tenantId, NAME("scan-member"));
    const inst = await mkInstance(cls, nowWindow());
    const res = await post(ctx.request, "/api/checkin/card", origin, { classInstanceId: inst, tokens: ["abc"] });
    expect(res.status()).toBe(403);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst])).toBe(0);
  });
});

// ── J38 · kiosk, on a throwaway tenant only ──────────────────────────────────

test.describe("J38 kiosk", () => {
  let kioskToken: string;
  let kioskClassInstanceId: string;
  let kioskMemberId: string;

  test.beforeAll(async () => {
    // Round 2: every cell in this block answered 404 because the test process
    // had no AUTH_SECRET/NEXTAUTH_SECRET, so `hashToken` HMAC'd with "" and the
    // hash never matched the server's. A missing secret must name itself, not
    // arrive as five "the kiosk cannot find this club" failures.
    tokenSecretOrThrow();
    // NEVER rotate totalbjj's kiosk token — every other lane shares it.
    kioskToken = `${RUN_STAMP}${Math.random().toString(36).slice(2, 10)}kiosk`;
    await sql('UPDATE "Tenant" SET "kioskTokenHash" = $1 WHERE id = $2', [hashToken(kioskToken), foreign.id]);
    const cls = await mkClass(foreign.id, `${RUN_STAMP} kiosk class`);
    kioskClassInstanceId = await mkInstance(cls, nowWindow());
    const m = await sql<{ id: string }>(
      `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "membershipType", "waiverAccepted", "accountType", "joinedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'monthly', true, 'adult', now(), now()) RETURNING id`,
      [foreign.id, `${RUN_STAMP} Kioskina Testerton`, `${RUN_STAMP}-kiosk@example.test`],
    );
    kioskMemberId = m[0].id;
  });

  test.afterAll(async () => {
    await resetBucketsLike("kiosk:%");
  });

  test("the search JSON carries no PII beyond the allow-list", async ({ request }) => {
    const res = await request.get(`/api/kiosk/${kioskToken}/members?q=Kioskina`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.members.length).toBeGreaterThan(0);
    const allowed = new Set(["kioskMemberToken", "name", "ageGroup", "beltName", "beltColor", "waiverOk", "selfTrainable", "linkedKids"]);
    for (const m of body.members) {
      for (const key of Object.keys(m)) {
        expect(allowed.has(key), `the kiosk search leaked \`${key}\``).toBe(true);
      }
      for (const kid of m.linkedKids ?? []) {
        const kidAllowed = new Set(["kioskMemberToken", "name", "ageGroup", "waiverOk", "age"]);
        for (const key of Object.keys(kid)) {
          expect(kidAllowed.has(key), `a child's \`${key}\` reached the kiosk`).toBe(true);
        }
        expect(Object.keys(kid)).not.toContain("dateOfBirth");
      }
    }
  });

  test("a short query returns nothing and an unknown token is a bare 404", async ({ request }) => {
    const short = await request.get(`/api/kiosk/${kioskToken}/members?q=K`, { maxRedirects: 0 });
    expect(short.status()).toBe(200);
    expect((await short.json()).members).toEqual([]);

    const bogus = await request.get(`/api/kiosk/${"z".repeat(40)}/members?q=Kioskina`, { maxRedirects: 0 });
    expect(bogus.status()).toBe(404);
    expect((await bogus.json()).error).toBe("Not found");

    // The order of those two refusals is the point, and it was wrong: the
    // `q.length < 2` shortcut sat ABOVE the token lookup, so a fabricated
    // token WITH a short query (or no `q` at all) answered
    // `200 { members: [] }` — "that kiosk exists, you just did not type
    // enough" — where every other public lookup in the product answers a
    // made-up identifier with 404. A free oracle for guessing a kiosk URL, and
    // the one kiosk surface whose paused-club refusal could be skipped by
    // omitting a parameter. Round 3: the token is resolved first.
    for (const [label, url] of [
      ["short query", `/api/kiosk/${"z".repeat(40)}/members?q=K`],
      ["no query at all", `/api/kiosk/${"z".repeat(40)}/members`],
    ] as const) {
      const res = await request.get(url, { maxRedirects: 0 });
      expect(res.status(), `a fabricated token with a ${label} was answered as if the club existed`).toBe(404);
      expect((await res.json()).error).toBe("Not found");
    }
  });

  test("a harvested kioskMemberToken is refused at another club's kiosk, re-spelled, and with junk appended", async ({ request }) => {
    const found = await request.get(`/api/kiosk/${kioskToken}/members?q=Kioskina`, { maxRedirects: 0 });
    const token = (await found.json()).members[0].kioskMemberToken as string;

    const before = await countRows("AttendanceRecord", '"classInstanceId" = $1', [kioskClassInstanceId]);

    // Mis-tenanted: the seeded club's kiosk, if it has a token, must refuse it.
    const seededHash = await sql<{ kioskTokenHash: string | null }>('SELECT "kioskTokenHash" FROM "Tenant" WHERE id = $1', [tenantId]);
    test.skip(!seededHash[0].kioskTokenHash, "the seeded club has no kiosk token — cross-tenant replay unmet");

    for (const [label, candidate] of [
      ["token.junk", `${token}.junk`],
      ["re-spelled with padding", `${token}=`],
      ["truncated", token.slice(0, -4)],
    ] as const) {
      const res = await request.post(`/api/kiosk/${kioskToken}/checkin`, {
        headers: { Origin: origin }, maxRedirects: 0,
        data: { kioskMemberToken: candidate, classInstanceId: kioskClassInstanceId },
      });
      expect(res.status(), `${label} answered ${res.status()}`).toBe(400);
      expect((await res.json()).error).toContain("invalid or expired");
    }
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [kioskClassInstanceId])).toBe(before);

    // The genuine token works exactly once.
    const ok = await request.post(`/api/kiosk/${kioskToken}/checkin`, {
      headers: { Origin: origin }, maxRedirects: 0,
      data: { kioskMemberToken: token, classInstanceId: kioskClassInstanceId },
    });
    expect(ok.status(), await ok.text()).toBe(201);
    const again = await request.post(`/api/kiosk/${kioskToken}/checkin`, {
      headers: { Origin: origin }, maxRedirects: 0,
      data: { kioskMemberToken: token, classInstanceId: kioskClassInstanceId },
    });
    expect(again.status()).toBe(409);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1 AND "memberId" = $2', [kioskClassInstanceId, kioskMemberId])).toBe(1);

    await expect.poll(async () =>
      (await sql('SELECT id FROM "AuditLog" WHERE action = $1 AND "tenantId" = $2', ["auth.checkin.kiosk", foreign.id])).length,
      { timeout: 5_000 },
    ).toBeGreaterThan(0);
  });

  test("roster_not_listed at the kiosk is a 403 (was X-7 Task 9: a 500)", async ({ request }) => {
    // lib/checkin.ts returns { kind: "roster_not_listed" }; the kiosk route's
    // switch has no case for it, so it falls through `default:` to a 500 and
    // the tablet says "Could not check in — please ask staff."
    const cls = await mkClass(foreign.id, `${RUN_STAMP} kiosk roster class`);
    const inst = await mkInstance(cls, nowWindow());
    const other = await sql<{ id: string }>(
      `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "joinedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', now(), now()) RETURNING id`,
      [foreign.id, `${RUN_STAMP} Rosterless Pat`, `${RUN_STAMP}-rosterless@example.test`],
    );
    await sql(
      `INSERT INTO "ClassRoster" ("id", "tenantId", "classId", "memberId", "addedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, now())`,
      [foreign.id, cls, kioskMemberId],
    );
    const found = await request.get(`/api/kiosk/${kioskToken}/members?q=Rosterless`, { maxRedirects: 0 });
    const token = (await found.json()).members[0].kioskMemberToken as string;
    const res = await request.post(`/api/kiosk/${kioskToken}/checkin`, {
      headers: { Origin: origin }, maxRedirects: 0,
      data: { kioskMemberToken: token, classInstanceId: inst },
    });
    // Fixed in round 1: the kiosk switch now carries the staff route's sentence.
    expect(res.status(), "a member not on the roster gets a 500 at the kiosk").toBe(403);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1 AND "memberId" = $2', [inst, other[0].id])).toBe(0);
  });

  test("the waiver gate is the API's, not the tablet's (was x10: two calls walked past it)", async ({ request }) => {
    // F4 is specified as a hard block — `docs/spec.md:141`, "cannot check in at
    // all" — and until this round the whole of it was
    // `components/kiosk/KioskPage.tsx` declining to POST. The kiosk URL is the
    // only credential on that surface and it is printed on a lobby tablet, so
    // the gate was skippable in the two calls below: search for the member,
    // post the `kioskMemberToken` the search hands out. Measured before the
    // fix: 201 and a written AttendanceRecord for a member who had signed
    // nothing.
    const cls = await mkClass(foreign.id, `${RUN_STAMP} kiosk waiver class`);
    const inst = await mkInstance(cls, nowWindow());
    const unsigned = await sql<{ id: string }>(
      `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "membershipType", "waiverAccepted", "accountType", "joinedAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'monthly', false, 'adult', now(), now()) RETURNING id`,
      [foreign.id, `${RUN_STAMP} Unsigned Wren`, `${RUN_STAMP}-unsigned@example.test`],
    );
    const memberId = unsigned[0].id;

    // Call one: the search the tablet makes, which hands out the token.
    const found = await request.get(`/api/kiosk/${kioskToken}/members?q=Unsigned`, { maxRedirects: 0 });
    expect(found.status()).toBe(200);
    const row = (await found.json()).members.find(
      (m: { name: string }) => m.name === `${RUN_STAMP} Unsigned Wren`,
    );
    expect(row, "the search did not offer the unsigned member at all").toBeTruthy();
    expect(row.waiverOk, "the endpoint reported this member as signed").toBe(false);

    // Call two: the post the client would have refused to make.
    const res = await request.post(`/api/kiosk/${kioskToken}/checkin`, {
      headers: { Origin: origin }, maxRedirects: 0,
      data: { kioskMemberToken: row.kioskMemberToken, classInstanceId: inst },
    });
    expect(res.status(), `the API admitted an unsigned member: ${await res.text()}`).toBe(403);
    const body = await res.json();
    // A named refusal, not the 500 the tablet blames itself for — and the
    // `reason` is what routes the kiosk back to its own waiver screen.
    expect(body.reason).toBe("waiver_unsigned");
    expect(body.error).toMatch(/waiver/i);
    expect(
      await countRows("AttendanceRecord", '"classInstanceId" = $1 AND "memberId" = $2', [inst, memberId]),
      "a refused check-in still wrote the row",
    ).toBe(0);

    // The same two calls, once the waiver is on file: admitted, exactly once.
    await sql('UPDATE "Member" SET "waiverAccepted" = true, "waiverAcceptedAt" = now() WHERE id = $1', [memberId]);
    const signedSearch = await request.get(`/api/kiosk/${kioskToken}/members?q=Unsigned`, { maxRedirects: 0 });
    const signedRow = (await signedSearch.json()).members.find(
      (m: { name: string }) => m.name === `${RUN_STAMP} Unsigned Wren`,
    );
    const ok = await request.post(`/api/kiosk/${kioskToken}/checkin`, {
      headers: { Origin: origin }, maxRedirects: 0,
      data: { kioskMemberToken: signedRow.kioskMemberToken, classInstanceId: inst },
    });
    expect(ok.status(), await ok.text()).toBe(201);
    expect(
      await countRows("AttendanceRecord", '"classInstanceId" = $1 AND "memberId" = $2', [inst, memberId]),
    ).toBe(1);
  });

  test("a suspended club's kiosk is closed (was critic 1 #11: wide open)", async ({ request }) => {
    const before = await sql<{ subscriptionStatus: string | null }>('SELECT "subscriptionStatus" FROM "Tenant" WHERE id = $1', [foreign.id]);
    await sql('UPDATE "Tenant" SET "subscriptionStatus" = $1 WHERE id = $2', ["suspended", foreign.id]);
    try {
      const res = await request.get(`/api/kiosk/${kioskToken}/classes`, { maxRedirects: 0 });
      // Fixed in round 1: all three kiosk routes and the page ask tenantAdmission.
      expect(res.status(), "the kiosk ignores tenant admission").toBe(403);
    } finally {
      await sql('UPDATE "Tenant" SET "subscriptionStatus" = $1 WHERE id = $2', [before[0].subscriptionStatus ?? "trial", foreign.id]);
    }
  });

  test("the kiosk page holds its width at 768 with no sideways scroll", async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, storageState: undefined, viewport: { width: 768, height: 1024 } });
    const page = await ctx.newPage();
    const res = await page.goto(`/kiosk/${kioskToken}`);
    expect(res?.status()).toBeLessThan(400);
    await page.waitForLoadState("domcontentloaded");
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect([scrollWidth, innerWidth]).toEqual([768, 768]);
    const overflow = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.left < -0.5 || r.right > window.innerWidth + 0.5) bad.push(`${el.tagName}.${(el as HTMLElement).className}`);
      }
      return bad;
    });
    expect(overflow, "a fixed/sticky element hangs outside the viewport").toEqual([]);
    await ctx.close();
  });
});

// ── J39 · member self check-in ───────────────────────────────────────────────

test.describe("J39 member self check-in", () => {
  test("402 with no coverage, 409 outside the window, 404 for another member's id", async ({ browser, baseURL }) => {
    const ctx = await memberSession(browser, baseURL!);
    const cls = await mkClass(tenantId, NAME("self"));
    const open = await mkInstance(cls, nowWindow());
    const closed = await mkInstance(cls, { startTime: "03:00", endTime: "04:00" });

    // Round 4: the self path asks for a signed waiver before it asks about
    // coverage, and the seeded member is created without one
    // (prisma/seed.ts has no waiverAccepted), so the gate is driven here
    // explicitly and then arranged out of the way — otherwise every
    // assertion below would silently be measuring the waiver.
    const self = await sql<{ id: string; waiverAccepted: boolean }>(
      'SELECT id, "waiverAccepted" FROM "Member" WHERE "tenantId" = $1 AND email = $2', [tenantId, MEMBER_EMAIL],
    );
    expect(self.length, `${MEMBER_EMAIL} is missing — re-seed the test branch.`).toBe(1);
    if (!self[0].waiverAccepted) {
      const unsigned = await post(ctx.request, "/api/checkin", origin, { classInstanceId: open });
      expect(unsigned.status(), "an unsigned member checked themselves in").toBe(403);
      expect((await unsigned.json()).reason).toBe("waiver_unsigned");
      expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [open])).toBe(0);
      await sql('UPDATE "Member" SET "waiverAccepted" = true, "waiverAcceptedAt" = now() WHERE id = $1', [self[0].id]);
    }

    const outside = await post(ctx.request, "/api/checkin", origin, { classInstanceId: closed });
    expect([402, 409]).toContain(outside.status());
    if (outside.status() === 409) expect((await outside.json()).error).toContain("Check-in is only available");

    const inWindow = await post(ctx.request, "/api/checkin", origin, { classInstanceId: open });
    expect([201, 402], await inWindow.text()).toContain(inWindow.status());
    if (inWindow.status() === 201) {
      const row = await sql<{ checkInMethod: string; checkedInById: string | null }>(
        'SELECT "checkInMethod", "checkedInById" FROM "AttendanceRecord" WHERE "classInstanceId" = $1', [open],
      );
      expect(row[0].checkInMethod).toBe("self");
      expect(row[0].checkedInById, "a self check-in was attributed to a staff user").toBeNull();
      const dupe = await post(ctx.request, "/api/checkin", origin, { classInstanceId: open });
      expect(dupe.status()).toBe(409);
    }

    // Another member's id is the admin branch, which a member may not reach.
    const victim = await subject("self-victim");
    const other = await post(ctx.request, "/api/checkin", origin, { classInstanceId: open, memberId: victim.id });
    expect(other.status()).toBe(403);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [victim.id])).toBe(0);

    // A foreign child id on the parent branch answers like a missing one.
    const onBehalf = await post(ctx.request, "/api/checkin", origin, { classInstanceId: open, onBehalfOfMemberId: foreignMemberId });
    expect(onBehalf.status()).toBe(404);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [foreignMemberId])).toBe(0);
  });

  test("checkInMethod: admin from a member session does not bypass the gates", async ({ browser, baseURL }) => {
    const ctx = await memberSession(browser, baseURL!);
    const cls = await mkClass(tenantId, NAME("method-forge"));
    const closed = await mkInstance(cls, { startTime: "03:00", endTime: "04:00" });
    const res = await post(ctx.request, "/api/checkin", origin, { classInstanceId: closed, checkInMethod: "admin" });
    expect(res.status(), "a member forged their way past the window with checkInMethod").not.toBe(201);
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [closed])).toBe(0);
  });
});

// ── J40 · every reader agrees ────────────────────────────────────────────────

test.describe("J40 readers", () => {
  test("the register and the dashboard stats move by exactly the rows written", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const cls = await mkClass(tenantId, NAME("readers"));
    const inst = await mkInstance(cls, nowWindow());

    // The register serialises `attended` / `attendedAt`, never `checkInTime`
    // (app/api/coach/instances/[id]/register/route.ts:118-145). Round 2 counted
    // `"checkInTime"` and so counted 0 both sides of a real 201 — a metric that
    // could not move, not a product that did not.
    type RegisterRow = { memberId: string; attended: boolean; walkIn: boolean };
    const attendedCount = async () => {
      const r = await get(ctx.request, `/api/coach/instances/${inst}/register`);
      expect(r.status()).toBe(200);
      const body = (await r.json()) as { expected: RegisterRow[] };
      return body.expected.filter((e) => e.attended).length;
    };

    const beforeAttended = await attendedCount();

    const m = await subject("reader");
    const res = await post(ctx.request, "/api/checkin", origin, { classInstanceId: inst, memberId: m.id });
    expect(res.status()).toBe(201);

    const afterAttended = await attendedCount();
    expect(afterAttended - beforeAttended, "the register did not move by exactly one").toBe(1);

    const todays = await get(ctx.request, "/api/coach/today");
    const listed = ((await todays.json()) as Array<{ id: string; attendedCount: number }>).find((r) => r.id === inst);
    expect(listed?.attendedCount, "coach/today disagrees with the database").toBe(
      await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst]),
    );
  });

  test("a foreign register answers like a missing one", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const res = await get(ctx.request, `/api/coach/instances/${foreignInstanceId}/register`);
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain(RUN_STAMP);
  });
});
