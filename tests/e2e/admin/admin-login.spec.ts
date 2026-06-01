/**
 * Area 6 — Operator/admin login page contract.
 *
 * Locks the iter-1/iter-2 closures:
 *   - The /admin/login page renders with the Account tab active by default
 *     (email + password fields visible, Bootstrap tab present but inactive).
 *   - Navigating to a protected admin page (/admin/tenants) as an anonymous
 *     user redirects to /admin/login.
 *
 * No DB interaction. The redirect is performed by the server-rendered page
 * calling `redirect("/admin/login")` when `isAdminPageAuthed()` returns false.
 * Both assertions are deterministic on any running server instance.
 *
 * Both the "chromium" and "Mobile Chrome" Playwright projects must pass.
 */
import { test, expect } from "@playwright/test";

test.describe("Admin login page — /admin/login", () => {
  test("renders the sign-in heading and MatFlow operations eyebrow", async ({ page }) => {
    await page.goto("/admin/login");

    // The brand block is always rendered regardless of active mode.
    await expect(page.getByText("MatFlow operations")).toBeVisible();
    await expect(page.getByRole("heading", { name: /admin sign in/i })).toBeVisible();
  });

  test("Account tab is selected by default and shows email + password fields", async ({ page }) => {
    await page.goto("/admin/login");

    // The tab list should be rendered with Account as the active tab.
    const accountTab = page.getByRole("tab", { name: /account/i });
    await expect(accountTab).toBeVisible();
    await expect(accountTab).toHaveAttribute("aria-selected", "true");

    // Email and password inputs must be visible without any interaction.
    await expect(page.locator("input[type='email']")).toBeVisible();
    await expect(page.locator("input[type='password']")).toBeVisible();
  });

  test("Bootstrap tab is present and inactive on initial load", async ({ page }) => {
    await page.goto("/admin/login");

    const bootstrapTab = page.getByRole("tab", { name: /bootstrap/i });
    await expect(bootstrapTab).toBeVisible();
    await expect(bootstrapTab).toHaveAttribute("aria-selected", "false");
  });

  test("switching to Bootstrap tab shows the secret field and hides email/password", async ({ page }) => {
    await page.goto("/admin/login");

    await page.getByRole("tab", { name: /bootstrap/i }).click();

    // Secret (password type) input must appear; email input disappears.
    // The Bootstrap section renders a single password-type input for the secret.
    const inputs = page.locator("input[type='password']");
    await expect(inputs.first()).toBeVisible();
    await expect(page.locator("input[type='email']")).not.toBeVisible();
  });

  test("submit button is disabled when fields are empty", async ({ page }) => {
    await page.goto("/admin/login");

    // On initial load, email and password are empty — button must be disabled.
    await expect(page.getByRole("button", { name: /sign in/i })).toBeDisabled();
  });
});

test.describe("Admin route protection — anonymous redirect", () => {
  test("visiting /admin/tenants without a session redirects to /admin/login", async ({ page }) => {
    // Ensure no admin cookies are present (fresh context provides this).
    await page.goto("/admin/tenants");

    // The server-rendered page calls redirect("/admin/login") when unauthed.
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("visiting /admin as anonymous user redirects to /admin/login", async ({ page }) => {
    await page.goto("/admin");

    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("login page is publicly accessible without authentication", async ({ page }) => {
    const response = await page.goto("/admin/login");

    // Must not itself redirect to another auth gate.
    await expect(page).toHaveURL(/\/admin\/login/);
    // A non-error status — the page renders, not a 4xx/5xx.
    expect(response?.status()).toBeLessThan(400);
  });
});
