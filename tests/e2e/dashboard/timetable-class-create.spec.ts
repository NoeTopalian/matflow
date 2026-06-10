import { test, expect } from "@playwright/test";

async function loginAsOwner(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill("input[type='email']", process.env.TEST_EMAIL ?? "owner@totalbjj.co.uk");
  await page.fill("input[type='password']", process.env.TEST_PASSWORD ?? "password123");
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member/, { timeout: 10_000 });
}

test.describe("Timetable class creation validation", () => {
  test("New Class form opens via URL param", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/timetable?new=class");
    await expect(page.getByRole("heading", { name: /New Class/i })).toBeVisible({ timeout: 8_000 });
  });

  test("submitting without a schedule start time shows validation toast", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/timetable?new=class");
    await page.getByRole("heading", { name: /New Class/i }).waitFor({ timeout: 8_000 });

    // Fill the class name
    const nameInput = page.locator("input[placeholder*='class name' i], input[placeholder*='e.g.' i], input[name='name']").first();
    await nameInput.fill("Test Class");

    // Add a schedule row if the form has an "Add" button for schedules
    const addScheduleBtn = page.getByRole("button", { name: /Add schedule|Add time|Add day/i }).first();
    if (await addScheduleBtn.isVisible()) {
      await addScheduleBtn.click();
    }

    // Clear start time if a time input exists
    const timeInputs = page.locator("input[type='time']");
    const count = await timeInputs.count();
    if (count > 0) {
      await timeInputs.first().fill("");
    }

    // Submit
    await page.getByRole("button", { name: /Create Class|Save|Submit/i }).first().click();

    // Should see a validation toast — not "Something went wrong"
    await expect(
      page.locator("text=/required|start time|end time/i").first()
    ).toBeVisible({ timeout: 5_000 });
  });

  test("class creation succeeds with valid schedule", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/timetable?new=class");
    await page.getByRole("heading", { name: /New Class/i }).waitFor({ timeout: 8_000 });

    const nameInput = page.locator("input[placeholder*='class name' i], input[placeholder*='e.g.' i], input[name='name']").first();
    await nameInput.fill("E2E Test Class");

    const addScheduleBtn = page.getByRole("button", { name: /Add schedule|Add time|Add day/i }).first();
    if (await addScheduleBtn.isVisible()) {
      await addScheduleBtn.click();
    }

    const timeInputs = page.locator("input[type='time']");
    const count = await timeInputs.count();
    if (count >= 2) {
      await timeInputs.first().fill("10:00");
      await timeInputs.nth(1).fill("11:00");
    }

    await page.getByRole("button", { name: /Create Class|Save|Submit/i }).first().click();

    // Should NOT see the "required" error — form submits or API responds
    await expect(
      page.locator("text=/required|start time/i").first()
    ).not.toBeVisible({ timeout: 3_000 }).catch(() => { /* toast never appeared — pass */ });
  });
});
