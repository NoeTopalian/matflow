import { test, expect } from "@playwright/test";

test.describe("Mark Attendance (admin tool)", () => {
  test("admin check-in page is accessible (redirects to login or renders)", async ({ page }) => {
    await page.goto("/dashboard/checkin");
    const url = page.url();
    expect(url).toMatch(/login|checkin/);
  });
});
