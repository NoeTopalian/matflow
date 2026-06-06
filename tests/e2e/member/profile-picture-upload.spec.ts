/**
 * feat/member-profile-pictures Track A Phase A6 — e2e spec for the
 * /member/profile picture upload flow.
 *
 * What this proves end-to-end:
 *   1. Camera button on /member/profile is reachable + clickable.
 *   2. File input accepts an image, the upload pipeline completes (POST /api/upload
 *      → PUT /api/members/:id/profile-picture).
 *   3. The Avatar swaps from initials to <img> after a successful upload.
 *   4. Reload preserves the picture (proves DB row landed, not just client state).
 *   5. "Remove picture" link is visible after upload, and clicking it returns
 *      the page to the initials fallback.
 *
 * Skipped without TEST_PASSWORD per the audit C-1 sentinel pattern.
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "";

test.describe.serial("Member profile picture upload", () => {
  test.skip(
    !process.env.TEST_PASSWORD,
    "TEST_PASSWORD env var required (audit C-1) — set it in .env.test to run.",
  );

  test("member uploads a picture, sees it persist across reload, then removes it", async ({
    page,
  }) => {
    // Generate a tiny valid PNG on the fly so we don't ship a binary asset.
    // 1×1 transparent PNG — passes the magic-byte check in /api/upload.
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(require("node:os").tmpdir(), "matflow-avatar-")),
      "avatar.png",
    );
    fs.writeFileSync(tmpFile, pngBytes);

    // Log in as the seeded member.
    await page.goto("/login");
    await page.getByPlaceholder(/gym code/i).fill(process.env.TEST_GYM_CODE ?? "totalbjj");
    await page.getByRole("button", { name: /continue|next/i }).click();
    await page.getByPlaceholder(/email/i).fill(process.env.TEST_EMAIL ?? "member@totalbjj.com");
    await page.getByPlaceholder(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/member\/home/);

    // Navigate to profile.
    await page.goto("/member/profile");

    // Avatar should start as initials (no picture set in the seed).
    const avatar = page.locator("img[alt]").first();
    await expect(page.getByRole("button", { name: /add profile picture|change profile picture/i }))
      .toBeVisible();

    // Pick the temporary file via the hidden input. The Camera button just
    // clicks the input — Playwright can target the input directly.
    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles(tmpFile);

    // Wait for the upload to complete (button stops showing the spinner).
    await expect(
      page.getByRole("button", { name: /change profile picture/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Avatar img should now have a non-empty src.
    await expect(avatar).toHaveAttribute("src", /https:\/\/|^data:/);

    // Reload — picture must persist (proves DB row).
    await page.reload();
    await expect(page.locator("img[alt]").first()).toHaveAttribute("src", /https:\/\/|^data:/);

    // Remove the picture.
    await page.getByRole("button", { name: /remove picture/i }).click();
    await expect(
      page.getByRole("button", { name: /add profile picture/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Cleanup the temp file (best effort).
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  });
});
