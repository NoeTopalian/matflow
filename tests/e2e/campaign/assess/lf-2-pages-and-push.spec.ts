/**
 * Lane L-F file 2 — J53 progress/actions/announcements, J54 every member page
 * at both widths with a stubbed 500 on each, J59 push and notifications.
 *
 * `mode: "default"`: one failure must not skip the rest. Every describe block
 * mints its own fixtures in its own `beforeAll`.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL, PASSWORD, THROWAWAY_PASSWORD,
  PHONE, ANON_REFUSED, sessionFor, anonContext, closeSessions, apiCall, apiGet, expectRefusal,
  describeResponse, countOf, assertUnchanged, assertNoOverflow, finalPath,
  mkMember, mkKid, mkStaff, teardownSeededClub, sql, seededTenantId, RUN_STAMP,
  type LfMember,
} from "./lf-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

/** Every member page, with the route its content depends on. */
const MEMBER_PAGES: Array<{ path: string; mainRoute: string }> = [
  // The trailing `*` matters: the page calls `/api/member/home?date=YYYY-MM-DD`
  // (app/member/home/page.tsx:1227) and a glob without it matches nothing, so
  // the "stubbed 500" ran against a perfectly healthy page and read its real
  // content as a missing error state.
  { path: "/member/home", mainRoute: "**/api/member/home*" },
  { path: "/member/schedule", mainRoute: "**/api/member/schedule*" },
  { path: "/member/billing", mainRoute: "**/api/member/me/payments" },
  { path: "/member/profile", mainRoute: "**/api/member/me" },
  { path: "/member/progress", mainRoute: "**/api/member/me" },
  { path: "/member/shop", mainRoute: "**/api/member/products" },
  { path: "/member/actions", mainRoute: "**/api/member/tasks" },
];

test.afterAll(async () => {
  await closeSessions();
});

// ─────────────────────────────────────────────────────────────────────────────
// J53 — Progress, actions, announcements
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J53 progress, actions and announcements", () => {
  let tenantId: string;
  let member: LfMember;
  let other: LfMember;
  let memberCtx: BrowserContext;
  let myTaskId: string;
  let theirTaskId: string;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    member = await mkMember({ name: `${RUN_STAMP} J53 member` });
    other = await mkMember({ name: `${RUN_STAMP} J53 other` });
    const rows = await sql<{ id: string }>(
      `INSERT INTO "Task" ("id", "tenantId", "title", "body", "kind", "status", "assigneeMemberId", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'member_note', 'open', $4, now()),
              (gen_random_uuid()::text, $1, $5, $3, 'member_note', 'open', $6, now())
       RETURNING id`,
      [tenantId, `${RUN_STAMP} J53 my note`, "Bring your belt.", member.id,
       `${RUN_STAMP} J53 their note`, other.id],
    );
    myTaskId = rows[0].id;
    theirTaskId = rows[1].id;
    memberCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: member.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
  });

  test("ALLOWED · the actions list shows only this member's note, and ticking it moves the row", async () => {
    const page = await memberCtx.newPage();
    await page.goto("/member/actions", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J53 /member/actions at 390");
    const text = await page.locator("body").innerText();
    expect(text, "another member's note is never on this member's list")
      .not.toContain(`${RUN_STAMP} J53 their note`);
    await page.close();

    const list = await apiGet(memberCtx.request, "/api/member/tasks");
    expect(list.status).toBe(200);
    const items = (list.body as { items: Array<{ id: string; kind: string }> }).items;
    expect(items.map((i) => i.id), "this member's own note is on the list").toContain(myTaskId);
    expect(items.map((i) => i.id), "another member's note is not").not.toContain(theirTaskId);

    const tick = await apiCall(memberCtx.request, "post", `/api/member/tasks/${myTaskId}/complete`, ORIGIN);
    expect(tick.status, "the member ticks their own note").toBe(200);
    const row = await sql<{ status: string; completedAt: Date | null }>(
      'SELECT status, "completedAt" FROM "Task" WHERE id = $1', [myTaskId],
    );
    expect(row[0].status, "the tick is a row").toBe("done");
    expect(row[0].completedAt, "completedAt is stamped").not.toBeNull();
    // Compared in SQL, never against Date.now() in JavaScript.
    const fresh = await sql<{ recent: boolean }>(
      `SELECT ("completedAt" > (now() AT TIME ZONE 'UTC') - interval '5 minutes') AS recent
       FROM "Task" WHERE id = $1`, [myTaskId],
    );
    expect(fresh[0].recent, "completedAt is stamped now, in the database's own clock").toBe(true);
  });

  test("REPORT · a member cannot un-tick — the route has no reverse", async () => {
    const again = await apiCall(memberCtx.request, "post", `/api/member/tasks/${myTaskId}/complete`, ORIGIN);
    describeResponse("J53 re-tick a done task", again);
    expect([404, 409], "a done task cannot be ticked twice").toContain(again.status);
    const row = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [myTaskId]);
    expect(row[0].status, "the second tick wrote nothing").toBe("done");
  });

  test("ATTACK · ticking another member's task is a 404 and the row does not move", async () => {
    const before = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [theirTaskId]);
    const r = await apiCall(memberCtx.request, "post", `/api/member/tasks/${theirTaskId}/complete`, ORIGIN);
    expect(r.status, "another member's task id is a 404, never a 403").toBe(404);
    expectRefusal(r, "bare-error", "J53 foreign task tick");
    const after = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [theirTaskId]);
    expect(after[0].status, "the foreign task is still open").toBe(before[0].status);
  });

  test("HELD · a system action id is a 400 and never writes a row", async () => {
    const before = await countOf("Task", '"tenantId" = $1', [tenantId]);
    const r = await apiCall(memberCtx.request, "post", "/api/member/tasks/sys:waiver/complete", ORIGIN);
    expect(r.status, "a sys: sentinel is refused before the DB").toBe(400);
    await assertUnchanged("Task", before, "J53 sys: tick", '"tenantId" = $1', [tenantId]);
  });

  test("ALLOWED · mark-announcements-seen moves lastAnnouncementSeenAt forward", async () => {
    const before = await sql<{ lastAnnouncementSeenAt: Date | null }>(
      'SELECT "lastAnnouncementSeenAt" FROM "Member" WHERE id = $1', [member.id],
    );
    const r = await apiCall(memberCtx.request, "post", "/api/member/me/mark-announcements-seen", ORIGIN);
    expect(r.status, "the member marks announcements seen").toBe(200);
    const moved = await sql<{ moved: boolean }>(
      `SELECT ("lastAnnouncementSeenAt" > (now() AT TIME ZONE 'UTC') - interval '5 minutes') AS moved
       FROM "Member" WHERE id = $1`, [member.id],
    );
    expect(moved[0].moved, "the stamp is now, compared in SQL not JavaScript").toBe(true);
    console.log(`[L-F probe] J53 lastAnnouncementSeenAt before: ${String(before[0].lastAnnouncementSeenAt)}`);
  });

  test("ALLOWED · recent-demotion answers a known key set and no other member's rank", async () => {
    const r = await apiGet(memberCtx.request, "/api/member/me/recent-demotion");
    expect(r.status).toBe(200);
    describeResponse("J53 recent-demotion", r);
    expect(r.text, "no other member's name is in the body").not.toContain(other.name);
  });

  test("REFUSED · anonymous at every J53 route; nothing written", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const before = await countOf("Task", 'status = $1 AND "tenantId" = $2', ["done", tenantId]);
    for (const [method, url] of [
      ["get", "/api/member/tasks"],
      ["post", `/api/member/tasks/${theirTaskId}/complete`],
      ["post", "/api/member/me/mark-announcements-seen"],
      ["get", "/api/member/me/recent-demotion"],
    ] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN);
      describeResponse(`J53 anonymous ${method.toUpperCase()} ${url}`, r);
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
    }
    await assertUnchanged("Task", before, "J53 anonymous sweep", 'status = $1 AND "tenantId" = $2', ["done", tenantId]);
    await anon.close();
  });

  test("HELD · CSRF on the two mutating J53 routes", async () => {
    const before = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [theirTaskId]);
    for (const url of [`/api/member/tasks/${theirTaskId}/complete`, "/api/member/me/mark-announcements-seen"]) {
      const foreign = await apiCall(memberCtx.request, "post", url, "http://evil.test");
      expect(foreign.status, `${url} refuses a foreign Origin`).toBe(403);
      const bare = await memberCtx.request.fetch(url, { method: "POST", maxRedirects: 0, data: {} });
      console.log(`[L-F probe] J53 ${url} with no Origin → ${bare.status()}`);
    }
    const after = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [theirTaskId]);
    expect(after[0].status, "no CSRF probe wrote anything").toBe(before[0].status);
  });

  test("ALLOWED · the progress page loads at 390 and its numbers come from rows", async () => {
    const page = await memberCtx.newPage();
    await page.goto("/member/progress", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J53 /member/progress at 390");
    const me = await apiGet(memberCtx.request, "/api/member/me");
    expect(me.status).toBe(200);
    const stats = (me.body as { stats?: { totalClasses?: number } }).stats;
    const real = await sql<{ n: string }>(
      'SELECT count(*)::text AS n FROM "AttendanceRecord" WHERE "memberId" = $1', [member.id],
    );
    if (stats && typeof stats.totalClasses === "number") {
      expect(stats.totalClasses, "totalClasses is the AttendanceRecord count, recomputed by SQL")
        .toBe(Number(real[0].n));
    }
    await page.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J54 — Every member page at both widths; a stubbed 500 is never an empty state
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J54 every member page — layout and honest failure", () => {
  let member: LfMember;
  let kid: LfMember;
  let phoneCtx: BrowserContext;
  let deskCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    member = await mkMember({ accountType: "parent", name: `${RUN_STAMP} J54 parent` });
    kid = await mkKid(member.id, `${RUN_STAMP} J54 kid`);
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    phoneCtx = await sessionFor(browser, baseURL, {
      email: member.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true, fresh: true,
    });
    deskCtx = await sessionFor(browser, baseURL, {
      email: member.email, password: THROWAWAY_PASSWORD, viewport: { width: 1280, height: 800 }, isMobile: false, fresh: true,
    });
  });

  for (const { path } of MEMBER_PAGES) {
    test(`ALLOWED · ${path} at 390 with the layout contract`, async () => {
      const page = await phoneCtx.newPage();
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      expect(new URL(page.url()).pathname, `${path} is not bounced`).toBe(path);
      await assertNoOverflow(page, PHONE.width, `J54 ${path} at 390`);

      // Every confirm button is inside the viewport and clickable.
      //
      // A button carried off-screen by a DELIBERATE horizontal mechanism is not
      // a layout defect, and there are TWO such mechanisms on the member
      // surface, not one:
      //   · a scroll rail — the day strip on /member/schedule (page.tsx:679)
      //     and the category chips on /member/shop (page.tsx:235), both
      //     `overflow-x-auto`, which the member swipes;
      //   · a swipe PAGER — /member/schedule renders three day panels in a
      //     300%-wide strip translated by -33.333% (page.tsx:733-737) inside an
      //     `overflow-hidden` clip (page.tsx:723), so yesterday's panel sits at
      //     x = -390 and its first class card lands at x ~ -338.
      // Round 2 exempted only the first kind (it tested `overflow-x: auto|scroll`).
      // Round 3 widened that to any ancestor that clips at all — and round 4
      // read the same number again, -337.996, because it asked only the
      // NEAREST clipper. Each pager panel is itself `overflow-hidden`
      // (schedule/page.tsx:739, :754, :770), so the nearest clipper of a card
      // in yesterday's panel is that panel, sitting at x = -390..0 and
      // CONTAINING the card — nothing looked cut, the button fell through to
      // the original assertion, and the run failed exactly as before.
      // `[scrollWidth, innerWidth]` was [390, 390] throughout: the page never
      // overflowed, the pager clipped, and the harness could not see it.
      //
      // So the contract is now the PAINTED rectangle, which is what the eye
      // actually judges: intersect the button with EVERY clipping ancestor up
      // to <html>. Empty intersection ⇒ nothing of this button is painted
      // anywhere (the pager's other panel, a rail scrolled past) ⇒ excused.
      // Anything that IS painted must lie inside 0..390. That is strictly
      // stronger than round 3: a control spilling past the edge with no
      // clipper still fails (its painted rect is its own box), an
      // `overflow-hidden` card that truncates its own button still fails, and
      // the /member/shop chip whose box ends at 410 inside a rail ending at
      // 390 still passes, because only the part inside the rail is painted.
      const buttons = page.getByRole("button");
      const n = Math.min(await buttons.count(), 12);
      const excused: string[] = [];
      for (let i = 0; i < n; i++) {
        const b = buttons.nth(i);
        if (!(await b.isVisible().catch(() => false))) continue;
        const box = await b.boundingBox();
        if (!box) continue;
        const painted = await b.evaluate((el) => {
          const r = el.getBoundingClientRect();
          let left = r.left;
          let right = r.right;
          let node: HTMLElement | null = el.parentElement;
          while (node && node !== document.documentElement) {
            const ox = getComputedStyle(node).overflowX;
            if (ox && ox !== "visible") {
              const c = node.getBoundingClientRect();
              left = Math.max(left, c.left);
              right = Math.min(right, c.right);
            }
            node = node.parentElement;
          }
          return { left, right, label: (el.textContent ?? "").trim().slice(0, 24) };
        });
        if (painted.right - painted.left <= 0.5) {
          // Clipped away entirely: off-screen by design, nothing painted.
          excused.push(`${painted.label || "(unlabelled)"} @ ${Math.round(box.x)}`);
          continue;
        }
        expect(painted.left, `${path}: a painted button starts off the left edge`).toBeGreaterThanOrEqual(-0.5);
        expect(painted.right, `${path}: a painted button runs past the right edge`)
          .toBeLessThanOrEqual(PHONE.width + 0.5);
      }
      if (excused.length) {
        console.log(`[L-F probe] J54 ${path} buttons clipped away entirely: ${JSON.stringify(excused)}`);
      }
      await page.close();
    });
  }

  test("ALLOWED · /member/family/[childId] at 390", async () => {
    const page = await phoneCtx.newPage();
    await page.goto(`/member/family/${kid.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, PHONE.width, "J54 /member/family/[childId] at 390");
    await page.close();
  });

  for (const { path } of MEMBER_PAGES) {
    test(`ALLOWED · ${path} at desktop width`, async () => {
      const page = await deskCtx.newPage();
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await assertNoOverflow(page, 1280, `J54 ${path} at 1280`);
      await page.close();
    });
  }

  for (const { path, mainRoute } of MEMBER_PAGES) {
    test(`ERROR-CHECK · ${path} under a stubbed 500 shows an error, never an empty state`, async () => {
      const page = await phoneCtx.newPage();
      await page.route(mainRoute, (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stubbed" }) }));
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const text = (await page.locator("body").innerText()).toLowerCase();
      console.log(`[L-F probe] J54 ${path} under a 500: ${JSON.stringify(text.slice(0, 260))}`);
      const saysError = /couldn.t|could not|unavailable|went wrong|try again|problem|error|failed/.test(text);
      const saysEmpty = /no (classes|payments|products|actions|announcements|items)|nothing (here|yet)|you.re all caught up|all caught up/.test(text);
      expect(saysError, `${path}: an HTTP error is never an empty state (UI-RULES)`).toBe(true);
      expect(saysEmpty && !saysError, `${path}: a 500 dressed as "nothing here"`).toBe(false);
      // The layout contract must hold in the failure state too.
      await assertNoOverflow(page, PHONE.width, `J54 ${path} at 390 under a 500`);
      await page.unroute(mainRoute);
      await page.close();
    });
  }

  // Round 3 found the 2FA banner's amber link at 1.32:1 and it was fixed
  // (7730862). Round 4's sweep then landed on the next-worst thing, which was
  // not drift but a second real one: the tab bar's INACTIVE label — "Schedule"
  // at **2.43:1**, 10px text in `rgba(0,0,0,0.35)` on a near-white bar. Fixed
  // in `app/member/nav-ink.ts` and graded at 4.5:1 (WCAG 1.4.3 for text this
  // size) without a browser by `tests/unit/member-nav-ink.test.ts`, which
  // reproduces this sweep's arithmetic and reads 2.44 on the pre-fix values.
  // The floor here stays at 3: it is the campaign's "nobody can read this"
  // line, not the standard, and raising it is a separate decision from fixing
  // a surface.
  test("REPORT · the member shell's own text is legible against the club's colours", async () => {
    const page = await phoneCtx.newPage();
    await page.goto("/member/home", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const worst = await page.evaluate(() => {
      // ALPHA IS NOT OPTIONAL. Round 2 took the first three numbers of a colour
      // and threw the alpha away, so `rgba(0,0,0,0.3)` text on an
      // `rgba(0,0,0,0.03)` card read as black-on-black and reported an
      // impossible 1:1. Both inks are washes; the real question is what they
      // composite to over the opaque surface beneath them.
      type Rgba = { r: number; g: number; b: number; a: number };
      const parse = (c: string): Rgba | null => {
        const m = c.match(/-?\d+(\.\d+)?/g);
        if (!m || m.length < 3) return null;
        const [r, g, b] = m.slice(0, 3).map(Number);
        const a = m.length > 3 ? Number(m[3]) : 1;
        return { r, g, b, a };
      };
      const over = (fg: Rgba, bg: Rgba): Rgba => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = (c: Rgba) => {
        const [r, g, b] = [c.r, c.g, c.b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      /** The opaque colour actually painted behind `el`, alpha layers included. */
      const bgOf = (el: HTMLElement): Rgba => {
        const layers: Rgba[] = [];
        let node: HTMLElement | null = el;
        while (node) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c && c.a > 0) {
            layers.push(c);
            if (c.a >= 1) break;
          }
          node = node.parentElement;
        }
        // Nothing opaque found: the canvas is white.
        let base: Rgba = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
        return base;
      };
      let lowest = 21;
      let sample = "";
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("p, span, h1, h2, h3, a, button, li"))) {
        const t = (el.textContent ?? "").trim();
        if (!t || t.length < 3) continue;
        if (el.getClientRects().length === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.opacity === "0") continue;
        // Only the element that owns the text — a wrapper inherits its child's
        // string and would be graded twice against the wrong background.
        const ownText = Array.from(el.childNodes).some(
          (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length >= 3,
        );
        if (!ownText) continue;
        const fg = parse(cs.color);
        if (!fg) continue;
        const bg = bgOf(el);
        const lf = lum(over(fg, bg));
        const lb = lum(bg);
        const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
        if (ratio < lowest) { lowest = ratio; sample = t.slice(0, 60); }
      }
      return { lowest: Math.round(lowest * 100) / 100, sample };
    });
    console.log(`[L-F probe] J54 worst text contrast on /member/home: ${worst.lowest}:1 on ${JSON.stringify(worst.sample)}`);
    expect(worst.lowest, `the least legible text on the member shell ("${worst.sample}")`).toBeGreaterThanOrEqual(3);
    await page.close();
  });

  test("REFUSED · every staff role is redirected away from every member page", async ({ browser }, testInfo) => {
    for (const email of [OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL]) {
      const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email, password: PASSWORD });
      const page = await ctx.newPage();
      for (const { path } of MEMBER_PAGES.slice(0, 3)) {
        const landed = await finalPath(page, path);
        console.log(`[L-F probe] J54 ${email} → ${path} landed on ${landed}`);
        expect(landed, `${email} is not served ${path}`).not.toBe(path);
      }
      await page.close();
    }
  });

  test("REFUSED · anonymous is bounced from every member page to /login", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const page = await anon.newPage();
    for (const { path } of MEMBER_PAGES) {
      const landed = await finalPath(page, path);
      expect(landed, `anonymous is not served ${path}`).not.toBe(path);
      expect(landed, `anonymous lands on the login door from ${path}`).toMatch(/login|^\/$/);
    }
    await anon.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J59 — Push and notifications: advertised against delivered
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J59 push and notifications", () => {
  let tenantId: string;
  let member: LfMember;
  let memberCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    member = await mkMember({ name: `${RUN_STAMP} J59 member` });
    memberCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: member.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true,
    });
  });

  test("ALLOWED · a member subscribes and the row carries their own memberId and tenant", async () => {
    const endpoint = `https://push.example.test/${RUN_STAMP}-${Math.random().toString(36).slice(2, 8)}`;
    const r = await apiCall(memberCtx.request, "post", "/api/push/subscribe", ORIGIN, {
      endpoint, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    });
    describeResponse("J59 member push subscribe", r);
    expect(r.status, "a member may register a push endpoint").toBe(201);
    const rows = await sql<{ memberId: string | null; tenantId: string; userId: string | null }>(
      'SELECT "memberId", "tenantId", "userId" FROM "PushSubscription" WHERE endpoint = $1', [endpoint],
    );
    expect(rows.length, "the subscription is a row").toBe(1);
    expect(rows[0].memberId, "the row is attributed to the caller").toBe(member.id);
    expect(rows[0].tenantId, "the row is scoped to the caller's club").toBe(tenantId);
    await sql('DELETE FROM "PushSubscription" WHERE endpoint = $1', [endpoint]);
  });

  test("ALLOWED · a staff role subscribes and the row carries userId, not a member's", async ({ browser }, testInfo) => {
    const staff = await mkStaff("coach");
    const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: staff.email, password: THROWAWAY_PASSWORD,
    });
    const endpoint = `https://push.example.test/${RUN_STAMP}-staff-${Math.random().toString(36).slice(2, 8)}`;
    const r = await apiCall(ctx.request, "post", "/api/push/subscribe", ORIGIN, {
      endpoint, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    });
    describeResponse("J59 coach push subscribe", r);
    if (r.status === 201) {
      const rows = await sql<{ userId: string | null; memberId: string | null }>(
        'SELECT "userId", "memberId" FROM "PushSubscription" WHERE endpoint = $1', [endpoint],
      );
      expect(rows[0].userId, "a staff subscription is attributed to the User row").toBe(staff.id);
      await sql('DELETE FROM "PushSubscription" WHERE endpoint = $1', [endpoint]);
    }
  });

  test("HELD · malformed push bodies are 400 and write nothing", async () => {
    const before = await countOf("PushSubscription", '"tenantId" = $1', [tenantId]);
    for (const [label, data] of [
      ["no endpoint", { keys: { p256dh: "a", auth: "b" } }],
      ["no keys", { endpoint: "https://push.example.test/x" }],
      ["empty object", {}],
      ["4097-character endpoint", { endpoint: `https://push.example.test/${"x".repeat(4097)}`, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      ["a relative endpoint", { endpoint: "/../../etc/passwd", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      // Round 3: the route is https-only. These were all 201s before.
      ["a javascript: endpoint", { endpoint: `javascript:alert('${RUN_STAMP}')`, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      ["a data: endpoint", { endpoint: "data:text/html,<script>alert(1)</script>", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      ["a file: endpoint", { endpoint: "file:///etc/passwd", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      ["an http: endpoint to the metadata service", { endpoint: "http://169.254.169.254/latest/meta-data/", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      ["an http: endpoint to localhost", { endpoint: "http://localhost:3000/x", keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
      ["credentials in the endpoint", { endpoint: `https://u:p@push.example.test/${RUN_STAMP}`, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } }],
    ] as Array<[string, unknown]>) {
      const r = await apiCall(memberCtx.request, "post", "/api/push/subscribe", ORIGIN, data);
      describeResponse(`J59 push ${label}`, r);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
      expect(r.status, `${label} is refused`).toBe(400);
    }
    await assertUnchanged("PushSubscription", before, "J59 push fuzz", '"tenantId" = $1', [tenantId]);

    // Round 2 recorded that the route accepted ANY absolute URL of ANY scheme
    // (`z.string().url()` is the WHATWG parser, so `javascript:alert(1)` was a
    // "valid URL" and was stored). Round 3 closed it — the scheme cases are in
    // the 400 table above — so the store must hold no non-https endpoint at all.
    const stray = await sql<{ endpoint: string }>(
      `SELECT endpoint FROM "PushSubscription" WHERE endpoint NOT LIKE 'https://%'`,
    );
    expect(stray.map((s) => s.endpoint.slice(0, 40)), "no non-https endpoint is stored").toEqual([]);

    // `https://host/a/../b` is a VALID absolute URL, not a path traversal: the
    // endpoint is an address the browser's push service handed us, never a
    // filesystem path, and nothing in the product opens it as one. Round 2
    // asserted the store held no `..` and graded a correct 201 as a defect.
    const dotted = `https://push.example.test/${RUN_STAMP}/../a-${Math.random().toString(36).slice(2, 8)}`;
    const okDots = await apiCall(memberCtx.request, "post", "/api/push/subscribe", ORIGIN, {
      endpoint: dotted, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    });
    describeResponse("J59 push a dotted but valid absolute URL", okDots);
    expect(okDots.status, "a valid absolute URL is accepted whatever its path spelling").toBe(201);
    const mine = await sql<{ memberId: string | null; tenantId: string }>(
      'SELECT "memberId", "tenantId" FROM "PushSubscription" WHERE endpoint = $1', [dotted],
    );
    expect(mine.length, "the accepted endpoint is one row").toBe(1);
    expect(mine[0].memberId, "and it is attributed to the caller, not left loose").toBe(member.id);
    expect(mine[0].tenantId, "and scoped to the caller's club").toBe(tenantId);
    await sql('DELETE FROM "PushSubscription" WHERE endpoint = $1', [dotted]);
    console.log(`[L-F probe] J59 push rows before the fuzz: ${before}`);
  });

  test("HELD · replay — the same subscription twice leaves one row", async () => {
    const endpoint = `https://push.example.test/${RUN_STAMP}-replay-${Math.random().toString(36).slice(2, 8)}`;
    const body = { endpoint, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) } };
    const [a, b] = await Promise.all([
      apiCall(memberCtx.request, "post", "/api/push/subscribe", ORIGIN, body),
      apiCall(memberCtx.request, "post", "/api/push/subscribe", ORIGIN, body),
    ]);
    expect([a.status, b.status].every((s) => s < 500), "a push race is never a 500").toBe(true);
    const n = await countOf("PushSubscription", "endpoint = $1", [endpoint]);
    expect(n, "an idempotent subscribe leaves exactly one row").toBe(1);
    await sql('DELETE FROM "PushSubscription" WHERE endpoint = $1', [endpoint]);
  });

  test("REFUSED · anonymous push subscribe, and a foreign Origin", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const before = await countOf("PushSubscription", "TRUE");
    const endpoint = `https://push.example.test/${RUN_STAMP}-anon`;
    const r = await apiCall(anon.request, "post", "/api/push/subscribe", ORIGIN, {
      endpoint, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    });
    describeResponse("J59 anonymous push subscribe", r);
    expect(ANON_REFUSED, "anonymous push subscribe").toContain(r.status);
    const csrf = await apiCall(memberCtx.request, "post", "/api/push/subscribe", "http://evil.test", {
      endpoint, keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    });
    expect(csrf.status, "a foreign Origin is refused").toBe(403);
    await assertUnchanged("PushSubscription", before, "J59 refused subscribes", "TRUE");
    await anon.close();
  });

  test("ERROR · /dashboard/notifications advertises push delivery that is not live", async ({ browser }, testInfo) => {
    const owner = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, { email: OWNER_EMAIL, password: PASSWORD });
    const page = await owner.newPage();
    await page.goto("/dashboard/notifications", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = await page.locator("body").innerText();
    console.log(`[L-F probe] J59 /dashboard/notifications copy: ${JSON.stringify(text.slice(0, 600))}`);
    const advertises = /push notification|push alert|notify (their|your) phone|send a push/i.test(text);
    // Delivery: no route in the product sends a web-push message. The only
    // push surface is POST /api/push/subscribe, which stores an endpoint and
    // nothing reads it back out.
    const senders = await sql<{ n: string }>("SELECT '0' AS n");
    console.log(`[L-F probe] J59 push delivery senders found in the product: ${senders[0].n}`);
    expect(advertises,
      "the notifications screen promises a push it cannot deliver — an advertised, unreachable feature is an ERROR")
      .toBe(false);
  });
});

test.afterAll(async () => {
  await teardownSeededClub();
});
