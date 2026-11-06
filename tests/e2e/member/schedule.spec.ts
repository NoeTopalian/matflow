import { test, expect, type Page } from "@playwright/test";

/** The class blocks of the day on show (the centre pane; the panes either side are inert). */
const blocks = (page: Page) => page.getByTestId("schedule-pane").getByTestId("schedule-day").locator("[data-cell-key] button");

/** The first day of the week on show that has a class, chosen by its day pill. Fails if no day has one. */
async function dayWithClasses(page: Page) {
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
    await page.getByRole("button", { name: new RegExp(`^${day}\\s*\\d`) }).click();
    if ((await blocks(page).count()) > 0) return day;
  }
  throw new Error("no day of this week has a class on the member schedule");
}

test.describe("Member Schedule", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/member/schedule");
  });

  test("week label is shown", async ({ page }) => {
    // Week nav shows a date range like "6–12 April"
    await expect(page.locator("text=/\\d+.*–.*\\d+/")).toBeVisible();
  });

  test("day pills are rendered (7 days)", async ({ page }) => {
    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    for (const day of dayLabels) {
      await expect(page.locator(`text=${day}`).first()).toBeVisible();
    }
  });

  test("Today button is present", async ({ page }) => {
    await expect(page.locator("button", { hasText: "Today" }).first()).toBeVisible();
  });

  test("a day of the week shows its classes as blocks on the day grid", async ({ page }) => {
    await dayWithClasses(page);
    expect(await blocks(page).count()).toBeGreaterThan(0);
    await expect(page.locator("body")).not.toContainText("Couldn't load your timetable");
  });

  test("tapping a class opens the detail sheet", async ({ page }) => {
    await dayWithClasses(page);
    await blocks(page).first().click();
    // EventSheet should appear
    await expect(page.locator("text=/Time|Coach|Location/i").first()).toBeVisible();
  });
});
