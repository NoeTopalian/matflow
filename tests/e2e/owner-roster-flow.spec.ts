import { test } from "@playwright/test";

// E2E — Playwright. Stubbed for v1 ship: requires Playwright orchestration
// (multi-browser-context, session cookie injection, seed-state setup) not yet
// established for the rank/access surface. The flow is covered by manual smoke
// tests in the spec's verification section.
test.fixme("owner creates roster class, member1 can attend, member2 cannot", async () => {
  // Plan:
  //   1. Owner login as totalbjj owner
  //   2. /dashboard/timetable → Add class → click "+ Select specific people"
  //   3. Tick member1 in the picker, save
  //   4. New browser context as member1 → /member/schedule should show "Comp team" badge
  //   5. New browser context as member2 → /member/schedule should NOT show the class
});
