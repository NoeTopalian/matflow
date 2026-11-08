/**
 * J86 — an anonymous visitor on a synthetic PUBLISHED club (ticket T9c, Tests:
 * "E2E: an anonymous visitor on a synthetic published club").
 *
 * ARRANGE through the database (a throwaway club with the public page on, two
 * live classes, one paused class, one class whose schedule starts next month,
 * one ticked and one unticked tier, an inline logo); ACT as a visitor with no
 * cookies; ASSERT on the page, its metadata, the logo route, and that
 * switching the page off brings back the login redirect.
 *
 * Runs against the TEST branch only (global-setup refuses anything else).
 * Never against a club that exists outside this run.
 */
import { test, expect } from "@playwright/test";
import { sql, RUN_STAMP } from "../campaign/helpers/db";

// No owner session: the chromium project's storageState would make this an
// owner visit, and the point is a stranger.
test.use({ storageState: { cookies: [], origins: [] } });

// A 1x1 transparent PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let tenantId = "";
let slug = "";
const classPrefix = `${RUN_STAMP} pub`;

async function addClass(name: string, opts: { isActive?: boolean; startsInDays?: number; coachName?: string } = {}) {
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "coachName", "duration", "maxCapacity", "isActive", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 60, 20, $4, now())
     RETURNING id`,
    [tenantId, name, opts.coachName ?? null, opts.isActive ?? true],
  );
  const start = new Date(Date.now() + (opts.startsInDays ?? -7) * 86_400_000);
  await sql(
    `INSERT INTO "ClassSchedule" ("id", "classId", "dayOfWeek", "startTime", "endTime", "startDate", "isActive")
     VALUES (gen_random_uuid()::text, $1, 2, '19:00', '20:00', $2, true)`,
    [rows[0].id, start],
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  slug = `${RUN_STAMP}-pub-${suffix}`.toLowerCase();
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Tenant" ("id", "slug", "name", "subscriptionStatus", "logoUrl",
       "publicPageEnabled", "publicPageEnabledAt", "publicPageDescription", "publicPageEmail", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 'active', $3, true, now(), $4, $5, now())
     RETURNING id`,
    [slug, `${RUN_STAMP} Riverside BJJ`, PNG, "Gi and no-gi for every level.", `hello-${suffix}@example.test`],
  );
  tenantId = rows[0].id;
  await addClass(`${classPrefix} Fundamentals`, { coachName: "Coach Sam" });
  await addClass(`${classPrefix} Open Mat`);
  await addClass(`${classPrefix} Paused Class`, { isActive: false });
  await addClass(`${classPrefix} Next Month Class`, { startsInDays: 30 });
  await sql(
    `INSERT INTO "MembershipTier" ("id", "tenantId", "name", "description", "pricePence", "currency", "billingCycle", "showOnPublicPage", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, 'Unlimited', 'Internal note: legacy TeamUp plan', 6500, 'GBP', 'monthly', true, now(), now()),
            (gen_random_uuid()::text, $1, 'Hidden Plan', NULL, 9900, 'GBP', 'monthly', false, now(), now())`,
    [tenantId],
  );
});

test.afterAll(async () => {
  if (!tenantId) return;
  await sql(`DELETE FROM "ClassSchedule" WHERE "classId" IN (SELECT id FROM "Class" WHERE "tenantId" = $1)`, [tenantId]).catch(() => {});
  await sql(`DELETE FROM "Class" WHERE "tenantId" = $1`, [tenantId]).catch(() => {});
  await sql(`DELETE FROM "MembershipTier" WHERE "tenantId" = $1`, [tenantId]).catch(() => {});
  await sql(`DELETE FROM "Tenant" WHERE id = $1`, [tenantId]).catch(() => {});
});

test("renders the published page with only live classes and ticked prices", async ({ page }) => {
  const res = await page.goto(`/${slug}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByTestId("public-club-page")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${RUN_STAMP} Riverside BJJ`);
  await expect(page.getByText("Gi and no-gi for every level.")).toBeVisible();

  const body = page.getByTestId("public-club-page");
  await expect(body).toContainText(`${classPrefix} Fundamentals`);
  await expect(body).toContainText(`${classPrefix} Open Mat`);
  await expect(body).not.toContainText(`${classPrefix} Paused Class`);
  await expect(body).not.toContainText(`${classPrefix} Next Month Class`);

  const tiers = page.getByTestId("public-club-tiers");
  await expect(tiers).toContainText("Unlimited");
  await expect(tiers).toContainText("£65.00");
  await expect(tiers).not.toContainText("Hidden Plan");
  // A tier's free-text description is never published.
  await expect(body).not.toContainText("Internal note");

  await expect(page.getByTestId("public-club-login")).toHaveAttribute("href", `/login?club=${slug}`);
  await expect(page.getByTestId("public-club-join")).toHaveAttribute("href", /^mailto:/);
});

test("is indexable, with a canonical URL, Open Graph logo and JSON-LD", async ({ page }) => {
  await page.goto(`/${slug}`);
  const robots = await page.locator('meta[name="robots"]').getAttribute("content");
  expect(robots ?? "").toContain("index");
  expect(robots ?? "").not.toContain("noindex");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://matflow.studio/${slug}`);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    `https://matflow.studio/api/tenant/${slug}/logo`,
  );
  const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}");
  expect(ld["@type"]).toBe("ExerciseGym");
  expect(ld.url).toBe(`https://matflow.studio/${slug}`);
  // The page never inlines the logo's base64 for a published club.
  expect(await page.content()).not.toContain("data:image/png;base64");
});

test("the logo route serves the published club's logo to a stranger", async ({ request }) => {
  const res = await request.get(`/api/tenant/${slug}/logo`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
});

test("timetable search narrows the list on the client", async ({ page }) => {
  await page.goto(`/${slug}`);
  const search = page.getByRole("searchbox", { name: "Search classes" });
  await search.fill("fundamentals");
  const body = page.getByTestId("public-club-page");
  await expect(body).toContainText(`${classPrefix} Fundamentals`);
  await expect(body).not.toContainText(`${classPrefix} Open Mat`);
});

test("switching the page off brings back the login redirect and the logo 404", async ({ page, request }) => {
  await sql(`UPDATE "Tenant" SET "publicPageEnabled" = false, "publicPageEnabledAt" = NULL WHERE id = $1`, [tenantId]);
  // The gate caches each slug's answer for 30 s per server instance; a save
  // through Settings clears it at once, a database write does not.
  await expect
    .poll(
      async () => {
        const res = await page.goto(`/${slug}`);
        return res ? new URL(page.url()).pathname + new URL(page.url()).search : "";
      },
      { timeout: 45_000, intervals: [2_000, 5_000] },
    )
    .toBe(`/login?club=${slug}`);
  const logo = await request.get(`/api/tenant/${slug}/logo`);
  expect(logo.status()).toBe(404);
});
