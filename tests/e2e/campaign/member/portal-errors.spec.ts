import { test, expect, type Page } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId, getOrder } from "../helpers/db";

/**
 * The half of the member portal that only shows up when the backend is down —
 * plus the two member journeys that actually write a row.
 *
 * `portal-sweep.spec.ts` proves each screen composes when everything works.
 * UI-RULES §7 says an HTTP error is NEVER an empty state, and this codebase's
 * documented failure mode is exactly that: a 500 rendered as "no items yet", so
 * a member believes their gym has no timetable / no shop / no bills rather than
 * knowing the app failed. Nothing asserted it. Each case below forces one real
 * data call to 500 and demands the screen SAY SO.
 */

const IGNORABLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /react-devtools/i,
  /webpack-hmr|turbopack-hmr/i,
  /Failed to load resource/i,
  /the server responded with a status of 500/i,
  /HTTP 500/i,
  /destination stream closed early/i,
  /DeprecationWarning: Calling client\.query\(\)/i,
];

/**
 * Exactly the shape the API layer returns for a failure, so the page takes its
 * real error branch rather than a JSON-parse accident.
 */
async function break500(page: Page, matches: (url: URL) => boolean) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!matches(url)) return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Something went wrong", reference: "MF-TEST00" }),
    });
  });
}

const CASES: Array<{
  label: string;
  href: string;
  /** The one data call broken for this case. */
  matches: (url: URL) => boolean;
  /** The copy the member must see. Not a status code, not a toast. */
  copy: RegExp;
}> = [
  {
    label: "Home",
    href: "/member/home",
    matches: (u) => u.pathname === "/api/member/home",
    copy: /Couldn.t load your details/i,
  },
  {
    label: "Schedule",
    href: "/member/schedule",
    matches: (u) => u.pathname === "/api/member/schedule",
    copy: /Couldn.t load your timetable/i,
  },
  {
    label: "Progress",
    href: "/member/progress",
    matches: (u) => u.pathname === "/api/member/me",
    copy: /Couldn.t load your progress/i,
  },
  {
    label: "Profile",
    href: "/member/profile",
    matches: (u) => u.pathname === "/api/me/gym",
    copy: /Couldn.t load your gym.s details/i,
  },
  {
    label: "Billing",
    href: "/member/billing",
    matches: (u) => u.pathname === "/api/me/gym",
    copy: /Couldn.t load your billing details/i,
  },
  {
    label: "Shop",
    href: "/member/shop",
    matches: (u) => u.pathname === "/api/member/products",
    copy: /Couldn.t load the shop/i,
  },
  {
    label: "Actions",
    href: "/member/actions",
    matches: (u) => u.pathname === "/api/member/tasks",
    copy: /Couldn.t load your action list/i,
  },
];

test.describe("a broken data call is shown as a failure, never as an empty screen", () => {
  for (const c of CASES) {
    test(`${c.label} (${c.href})`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (err) => {
        if (!IGNORABLE.some((re) => re.test(err.message))) pageErrors.push(err.message);
      });

      await break500(page, c.matches);
      await page.goto(c.href, { waitUntil: "domcontentloaded" });

      // The screen must name the failure to the member.
      await expect(
        page.locator("body"),
        `${c.href} swallowed a 500 — the member is looking at a screen that does not say anything failed`,
      ).toContainText(c.copy, { timeout: 45_000 });

      // …and must not have blown up into an error boundary instead.
      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
      expect(body, `${c.href} threw to an error boundary rather than handling the 500`).not.toMatch(
        /Application error|MF-[A-Z0-9]{6}/,
      );
      expect(pageErrors, `${c.href} threw on the client when its data call failed`).toEqual([]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The two member journeys that write
// ─────────────────────────────────────────────────────────────────────────────

test("adding a child through the portal writes a real kid Member linked to the parent", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const tenantId = await seededTenantId();
  const childName = `${RUN_STAMP} Kid ${testInfo.project.name.replace(/[^a-z0-9]/gi, "")}`;
  let childId: string | null = null;

  try {
    // X-7 Task 8 repair. The control this test drove lives on member HOME
    // (app/member/home/page.tsx:676, "+ Add a child") but that card renders
    // only for an account the portal already believes is a parent, so for the
    // seeded adult member it is never on the page and the test failed on its
    // own selector rather than on the product.
    //
    // The control that is always reachable is the one in FamilySection
    // (components/member/FamilySection.tsx:158 "Add a child", :277 "Add another
    // child"), rendered by app/member/profile/page.tsx:322. Drive that. Same
    // journey, same modal (EditChildModal), same POST /api/member/children.
    await page.goto("/member/profile", { waitUntil: "domcontentloaded" });
    const addChild = page.getByRole("button", { name: /^(\+ )?Add (a child|another child)$/i });
    await expect(addChild, "the member portal offers no way to add a child").toBeVisible({ timeout: 45_000 });
    await addChild.click();

    await expect(page.getByRole("heading", { name: /Add a child/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("textbox").first().fill(childName);
    await page.getByRole("button", { name: /^Add child$/i }).click();

    // The consequence, in Postgres — not a toast.
    await expect(async () => {
      const rows = await sql<{ id: string; accountType: string; parentMemberId: string | null }>(
        'SELECT id, "accountType", "parentMemberId" FROM "Member" WHERE "tenantId" = $1 AND name = $2',
        [tenantId, childName],
      );
      expect(rows, "no kid Member row was written").toHaveLength(1);
      expect(rows[0].accountType, "the child was not stored as a kids account").toBe("kids");
      expect(rows[0].parentMemberId, "the child was not linked to the parent").not.toBeNull();
      childId = rows[0].id;
    }).toPass({ timeout: 30_000 });
  } finally {
    if (childId) {
      await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [childId]);
      await sql('DELETE FROM "Member" WHERE id = $1', [childId]);
    } else {
      await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND name = $2', [tenantId, childName]);
    }
  }
});

test("a pay-at-desk checkout leaves a pending Order the gym can collect against", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/member/shop", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 45_000 });

  const addToCart = page.getByRole("button", { name: /add to cart|add to basket|^\+$/i }).first();
  test.skip(
    (await addToCart.count()) === 0,
    "the seeded tenant has no purchasable product — nothing to check out",
  );
  await addToCart.click();

  // Open the cart, then check out. Both are the real buttons a member presses.
  const cartButton = page.getByRole("button", { name: /cart|basket|checkout/i }).first();
  if (await cartButton.count()) await cartButton.click();

  const checkoutResponse = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/member/checkout",
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: /checkout|place order|pay at/i }).last().click();
  const payload = (await (await checkoutResponse).json().catch(() => ({}))) as {
    mode?: string;
    orderRef?: string;
  };

  test.skip(payload.mode !== "pay_at_desk", `this club's shop rail is ${payload.mode ?? "unknown"}, not pay-at-desk`);

  await expect(page.getByRole("heading", { name: /Order Placed!/i })).toBeVisible({ timeout: 20_000 });

  const rows = await sql<{ id: string; status: string; orderRef: string }>(
    'SELECT id, status, "orderRef" FROM "Order" WHERE "orderRef" = $1',
    [payload.orderRef ?? "-"],
  );
  expect(rows, "the member saw an order reference but no Order row exists").toHaveLength(1);
  const order = await getOrder(rows[0].id);
  expect(order?.status, "the desk order was not left pending for the gym to collect").toBe("pending");

  // KNOWN GAP (K13): nothing in the staff dashboard lists pending desk orders,
  // so this row is written and then invisible to the gym. Asserted here so the
  // row's existence is at least proven; the missing screen is a controller item.

  await sql('DELETE FROM "Order" WHERE id = $1', [rows[0].id]);
});
