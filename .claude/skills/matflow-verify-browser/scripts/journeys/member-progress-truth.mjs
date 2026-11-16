// Journey: member progress tells the truth about imported history (PR #96, Round 10, 16 Nov 2026).
// A synthetic club whose ONLY attendance is an imported history ending three weeks ago (the state a real club is in
// after a TeamUp import with no MatFlow check-ins since). Checks: imported sessions keep their session dates; this
// week / month / streak say "no records since <date>" instead of 0; the heat strip marks the no-records weeks; a failed
// load is an error with retry, never an empty or zero page; the guardian sees only the confirmed child (not a
// suggested-only child, not another family's child), and that child's page says "no attendance recorded since".
// Needs `fixture.mjs create` and `server.mjs start`. Cleans up its own seeded rows.
//   node journeys/member-progress-truth.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("member-progress-truth");
const tenantId = club.tenantId;
const errors = [];
const DAY = 86_400_000;
const ZONE = "Europe/London";

// Club "today" (London) as a UTC-midnight day marker, and a London wall-clock → instant helper.
const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const today = new Date(`${p.year}-${p.month}-${p.day}T00:00:00.000Z`);
const londonAt = (marker, hh, mm) => {
  const utc = marker.getTime() + (hh * 60 + mm) * 60_000;
  const f = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute);
  return new Date(utc - (shown - utc));
};

const member = await memberLogin(club); // the guardian (adult, "Member 1")
const owner = (await q(`select id from "User" where "tenantId" = $1 and role = 'owner' limit 1`, [tenantId]))[0];
const job = randomUUID(), cls = randomUUID();
const sessions = [35, 28, 21].map((d) => ({ id: randomUUID(), marker: new Date(today.getTime() - d * DAY) }));
const childA = randomUUID(), childB = randomUUID(), childC = randomUUID();

try {
  await q(`insert into "ImportJob" (id, "tenantId", "createdById", source, "fileName", "fileBlobUrl", "updatedAt") values ($1, $2, $3, 'teamup', 'synthetic-history.csv', 'inline:synthetic', now())`, [job, tenantId, owner.id]);
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'Imported Gi', 60, 30)`, [cls, tenantId]);
  await q(`insert into "Member" (id, "tenantId", name, email, "accountType", "parentMemberId", "guardianConfirmedAt", "guardianSuggestedBy") values
    ($1, $4, 'Synthetic Child A', $5, 'kids', $7, now(), 'staff'),
    ($2, $4, 'Synthetic Child B', $6, 'kids', $7, null, null),
    ($3, $4, 'Synthetic Child C', $8, 'kids', null, null, null)`,
    [childA, childB, childC, tenantId, `child-a-${childA.slice(0, 8)}@example.test`, `child-b-${childB.slice(0, 8)}@example.test`, member.id, `child-c-${childC.slice(0, 8)}@example.test`]);
  for (const s of sessions) {
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime", "sourceImportJobId") values ($1, $2, $3, '18:00', '19:00', $4)`, [s.id, cls, s.marker, job]);
    for (const who of [member.id, childA]) {
      await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod", "checkInTime", "importJobId") values ($1, $2, $3, $4, 'import', $5, $6)`, [randomUUID(), tenantId, who, s.id, londonAt(s.marker, 18, 0), job]);
    }
  }
  const lastStart = londonAt(sessions[2].marker, 18, 0);
  const expectedSince = londonAt(new Date(sessions[2].marker.getTime() + DAY), 0, 0).toISOString(); // club midnight after the last import

  const browser = await chromium.launch();
  try {
    const ctx = await context(browser, "10.96.0.1");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(page, club, member);

    const me = await page.request.get("/api/member/me");
    const body = me.ok() ? await me.json() : null;
    const dates = (body?.stats?.weeklyCounts ?? []).flatMap((w) => w.classes.map((c) => c.date)).sort();
    const wantDates = sessions.map((s) => londonAt(s.marker, 18, 0).toISOString()).sort();
    L.check("data", "P1 imported sessions are dated by their session start (18:00 club time)", JSON.stringify(dates) === JSON.stringify(wantDates), { got: dates, want: wantDates });
    L.check("data", "P2 the club's records stop at the imported history: noRecordsSince = club midnight after the last import", body?.stats?.noRecordsSince === expectedSince, { got: body?.stats?.noRecordsSince ?? null, want: expectedSince, lastStart: lastStart.toISOString() });

    await page.goto("/member/progress");
    await page.getByText("Current Streak").first().waitFor({ timeout: 90000 });
    const tiles = await page.getByText(/no records since/).count();
    L.check("ui", "P3 This Week, This Month and Current Streak say 'no records since <date>' instead of 0", tiles >= 3, { tiles });
    const noRecWeeks = await page.locator('[aria-label*="no attendance records"]').count();
    L.check("ui", "P4 the heat strip marks the weeks after the history as no records", noRecWeeks >= 1, { noRecWeeks });
    await shot(page, "progress-no-records");

    // A failed load is an error with retry, never an empty or zero page.
    await page.route("**/api/member/me", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.reload();
    const err = await page.getByText("Couldn't load your progress").first().waitFor({ timeout: 60000 }).then(() => true, () => false);
    const zeroOrDash = await page.getByText(/no records since|classes attended/).count();
    L.check("ui", "P5 a failed load shows the error, and no figures (neither 0 nor '—')", err && zeroOrDash === 0, { err, figures: zeroOrDash });
    await page.unroute("**/api/member/me");
    await page.reload();
    const back = await page.getByText(/no records since/).first().waitFor({ timeout: 90000 }).then(() => true, () => false);
    L.check("ui", "P6 after the failure clears, the page shows the no-records state again", back, { back });

    // Guardian: only the confirmed child.
    const kids = await page.request.get("/api/member/me/children");
    const list = kids.ok() ? await kids.json() : [];
    const ids = (Array.isArray(list) ? list : []).map((k) => k.id);
    L.check("guardian", "G1 the guardian's children list holds only the confirmed child", ids.length === 1 && ids[0] === childA, { count: ids.length, onlyA: ids[0] === childA });
    const a = await page.goto(`/member/family/${childA}`);
    const aNote = await page.getByTestId("child-no-records").waitFor({ timeout: 60000 }).then(() => true, () => false);
    const aTime = await page.getByText("Class at 18:00").count();
    L.check("guardian", "G2 the confirmed child's page says no attendance recorded since, and lists imported classes at their session time", a?.status() === 200 && aNote && aTime >= 1, { status: a?.status(), aNote, aTime });
    await shot(page, "guardian-child-no-records");
    for (const [label, id] of [["G3 a suggested-only child", childB], ["G4 another family's child", childC]]) {
      const r = await page.goto(`/member/family/${id}`);
      const notShown = r?.status() === 404 || (await page.getByText("Synthetic Child").count()) === 0;
      L.check("guardian", `${label} is not shown to the guardian`, notShown, { status: r?.status() });
    }

    const phone = await context(browser, "10.96.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const p2 = await phone.newPage();
    p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await p2.goto("/member/progress");
    await p2.getByText("Current Streak").first().waitFor({ timeout: 90000 });
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", "M1 /member/progress at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
    await shot(p2, "progress-no-records-mobile");
    L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
  } finally {
    await browser.close();
  }
} finally {
  // Remove exactly what this journey seeded (the fixture teardown removes the club itself).
  await q(`delete from "AttendanceRecord" where "tenantId" = $1 and "importJobId" = $2`, [tenantId, job]);
  await q(`delete from "ClassInstance" where "classId" = $1`, [cls]);
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [cls, tenantId]);
  await q(`delete from "Member" where id = any($1) and "tenantId" = $2`, [[childA, childB, childC], tenantId]);
  await q(`delete from "ImportJob" where id = $1 and "tenantId" = $2`, [job, tenantId]);
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
