// The Create class drawer had no e2e at all, which is how "Invalid data" on
// a blank optional field lived from the first commit to 18 Sep 2026. This
// spec drives the real drawer. Noe, 10:06 the same morning: "all minimum
// criteria should be filled in" — so the refusal is asserted first.
import { test, expect } from "@playwright/test";
import { sql, RUN_STAMP } from "./helpers/db";

test.describe.configure({ mode: "serial", timeout: 180_000 });

// RUN_STAMP already carries the `e2e-` prefix the sibling specs filter on.
const NAME = `${RUN_STAMP}-create-class`;
let classId: string | null = null;

test.afterAll(async () => {
  if (!classId) return;
  // cleanupRun deletes no Class rows; this spec owns its own.
  await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [classId]).catch(() => {});
  await sql('DELETE FROM "ClassSchedule" WHERE "classId" = $1', [classId]).catch(() => {});
  await sql('DELETE FROM "Class" WHERE id = $1', [classId]).catch(() => {});
});

async function openDrawer(page: import("@playwright/test").Page) {
  await page.goto("/dashboard/timetable", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add class" }).first().click();
  await expect(page.getByRole("heading", { name: "New class" })).toBeVisible();
}

test("1 · a class cannot be created without a day, and the form says so", async ({ page }) => {
  await openDrawer(page);
  await page.getByLabel("Class Name").fill(NAME);
  await expect(page.getByRole("button", { name: "Create class" })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: /Fill in:.*at least one day/ })).toBeVisible();
});

test("2 · a blank duration blocks it too, naming Duration", async ({ page }) => {
  await openDrawer(page);
  await page.getByLabel("Class Name").fill(NAME);
  await page.getByRole("button", { name: "Add day" }).click();
  await page.getByLabel("Duration (mins)").first().fill("");
  await expect(page.getByRole("button", { name: "Create class" })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: /Fill in:.*Duration/ })).toBeVisible();
});

test("3 · name + duration + one day creates the class, with the blanks saved as blanks", async ({ page }) => {
  await openDrawer(page);
  await page.getByLabel("Class Name").fill(NAME);
  await page.getByRole("button", { name: "Add day" }).click();
  await expect(page.getByRole("button", { name: "Create class" })).toBeEnabled();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/classes") && r.request().method() === "POST"),
    page.getByRole("button", { name: "Create class" }).click(),
  ]);
  expect(res.status()).toBe(201);
  // Eight: the create mints the same 56-day window the cron maintains, and
  // 56 days hold exactly eight of any weekday. Noe, 18 Sep 2026.
  await expect(page.getByText(/Class created · 8 sessions/)).toBeVisible();

  const rows = await sql<{
    id: string;
    coachName: string | null;
    location: string | null;
    description: string | null;
    duration: number;
  }>('SELECT id, "coachName", location, description, duration FROM "Class" WHERE name = $1', [NAME]);
  expect(rows).toHaveLength(1);
  classId = rows[0].id;
  expect(rows[0]).toMatchObject({ coachName: null, location: null, description: null, duration: 60 });

  const slots = await sql<{ dayOfWeek: number }>('SELECT "dayOfWeek" FROM "ClassSchedule" WHERE "classId" = $1', [
    classId,
  ]);
  expect(slots).toHaveLength(1);

  const minted = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1', [
    classId,
  ]);
  expect(Number(minted[0].n), "a created class must be on the timetable at once, not after the cron").toBe(8);
});
