import { defineConfig, devices } from "@playwright/test";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

// Audit iter-1-infra A7I1-V-1 [Critical]: load .env.test BEFORE anything in
// playwright reads process.env. The hand-rolled .env loader in some specs
// was reading the prod .env (which points at the prod Neon branch). With
// override:true and .env.test present, DATABASE_URL etc. are sourced from
// the test branch (ep-hidden-salad-abom7cg4). Falls back gracefully if
// .env.test is missing — CI provides DATABASE_URL via repo secrets.
const TEST_ENV = resolve(process.cwd(), ".env.test");
if (existsSync(TEST_ENV)) {
  loadDotenv({ path: TEST_ENV, override: true });
}

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: "**/auth.setup.ts",
    },
    {
      name: "member-setup",
      testMatch: "**/member-auth.setup.ts",
    },
    {
      // Owner-authenticated suite. Member-facing specs run under the member
      // projects below (they need a member session, not the owner one).
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/owner.json",
      },
      dependencies: ["setup"],
      testIgnore: ["**/auth.setup.ts", "**/member-auth.setup.ts", "**/member/**"],
    },
    {
      name: "chromium-member",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/member.json",
      },
      dependencies: ["member-setup"],
      testMatch: "**/member/**",
    },
    {
      // Staff dashboard on a phone viewport — scoped to the UI interaction
      // audit only. MobileNav (bottom tabs + "More" sheet) is a first-class
      // staff UI (docs/UI-RULES.md §4/§9), so "every menu and button works on
      // mobile" is asserted here; legacy desktop-asserting dashboard specs
      // stay desktop-only.
      name: "Mobile Chrome owner",
      use: {
        ...devices["Pixel 5"],
        storageState: "tests/e2e/.auth/owner.json",
      },
      dependencies: ["setup"],
      testMatch: "**/ui-audit-staff.spec.ts",
    },
    {
      // Mobile coverage targets the MEMBER UI, which is mobile-first. The owner
      // back-office remains desktop-first for its legacy specs; staff-mobile
      // signal comes from the scoped "Mobile Chrome owner" audit project above.
      name: "Mobile Chrome member",
      use: {
        ...devices["Pixel 5"],
        storageState: "tests/e2e/.auth/member.json",
      },
      dependencies: ["member-setup"],
      testMatch: "**/member/**",
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
