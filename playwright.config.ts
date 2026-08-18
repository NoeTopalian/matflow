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

// `npm run dev` hardcodes --port 3847. If PLAYWRIGHT_BASE_URL points somewhere
// else (e.g. a second worktree harvesting on a private port), running that
// script would boot a server on 3847 — colliding with whoever already owns it —
// and then time out waiting on the wrong URL. Derive the port instead. The
// default path is byte-for-byte the old behaviour.
const devPort = new URL(baseURL).port || "3847";
const webServerCommand = devPort === "3847" ? "npm run dev" : `npx next dev --port ${devPort}`;

// The screenshot/accessibility harvester (tests/e2e/audit/harvest.spec.ts) is
// NOT part of the normal test matrix — it captures artefacts, it asserts
// nothing. Its project only exists when AUDIT_HARVEST=1, so a bare
// `npx playwright test` never sees it. See that file's header for the full
// invocation.
const auditHarvest = process.env.AUDIT_HARVEST === "1";

// The sticky/fixed overlap regression guard (tests/e2e/ui-audit-overlap.spec.ts)
// is likewise NOT part of the default matrix — it is a slow, whole-page
// geometry sweep over every staff and member surface at two viewports. Its
// projects only exist when UI_OVERLAP_AUDIT=1, and the `chromium` project
// ignores the file unconditionally, so a bare `npx playwright test` collects
// exactly the same tests it did before. See that file's header for how to run it.
const overlapAudit = process.env.UI_OVERLAP_AUDIT === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Every worker shares ONE `next dev` process and ONE Neon branch, so workers
  // contend for a fixed backend rather than scaling with cores. Playwright's
  // local default (half the logical CPUs — 8 on a 16-core box) pushed
  // /api/member/me from ~4s to >30s and produced a different random set of
  // timeout failures on every run. 4 keeps the suite deterministic; CI stays
  // at 1. Override with `npx playwright test --workers=N` when profiling.
  workers: process.env.CI ? 1 : 4,
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
      testIgnore: [
        "**/auth.setup.ts",
        "**/member-auth.setup.ts",
        "**/member/**",
        // Artefact harvester — runs only under the `audit-harvest` project.
        "**/audit/**",
        // Sticky/fixed overlap guard — runs only under the `overlap-*`
        // projects (UI_OVERLAP_AUDIT=1). Keeps the default matrix unchanged.
        "**/ui-audit-overlap.spec.ts",
      ],
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
    // Gated on AUDIT_HARVEST=1 so the default matrix is unchanged. The spec
    // drives its own contexts (1440×900 and 390×844, owner / member /
    // anonymous / admin), so this project carries no viewport or storageState
    // of its own — it just depends on both setups to mint the session files.
    // fullyParallel:false keeps the whole file in one worker, which is what
    // makes the manifest merge deterministic.
    ...(auditHarvest
      ? [
          {
            name: "audit-harvest",
            fullyParallel: false,
            dependencies: ["setup", "member-setup"],
            testMatch: "**/audit/harvest.spec.ts",
          },
        ]
      : []),
    // Gated on UI_OVERLAP_AUDIT=1 so the default matrix is unchanged. Four
    // projects because the guard must close all four axes the old check
    // missed: staff AND member surfaces, desktop AND mobile viewports. The
    // spec self-selects its route list from the project name ("member" in the
    // name ⇒ member routes), so each project skips the other half.
    ...(overlapAudit
      ? [
          {
            name: "overlap-staff-desktop",
            use: { ...devices["Desktop Chrome"], storageState: "tests/e2e/.auth/owner.json" },
            dependencies: ["setup"],
            testMatch: "**/ui-audit-overlap.spec.ts",
          },
          {
            name: "overlap-staff-mobile",
            use: { ...devices["Pixel 5"], storageState: "tests/e2e/.auth/owner.json" },
            dependencies: ["setup"],
            testMatch: "**/ui-audit-overlap.spec.ts",
          },
          {
            name: "overlap-member-desktop",
            use: { ...devices["Desktop Chrome"], storageState: "tests/e2e/.auth/member.json" },
            dependencies: ["member-setup"],
            testMatch: "**/ui-audit-overlap.spec.ts",
          },
          {
            name: "overlap-member-mobile",
            use: { ...devices["Pixel 5"], storageState: "tests/e2e/.auth/member.json" },
            dependencies: ["member-setup"],
            testMatch: "**/ui-audit-overlap.spec.ts",
          },
        ]
      : []),
  ],
  webServer: {
    command: webServerCommand,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
