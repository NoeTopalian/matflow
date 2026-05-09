import { test } from "@playwright/test";

// E2E — Playwright. Stubbed for v1 ship; needs seeded state (a class with N
// white-belt subscribers) which the existing seed scripts don't yet expose.
test.fixme("tightening rank gate shows affected count + cancels subscriptions on commit", async () => {
  // Plan:
  //   1. Seed: class C with 5 ClassSubscription rows from white-belt members
  //   2. Owner edits class, sets requiredRank=blue
  //   3. PATCH ?dryRun=1 returns affectedMemberIds.length === 5
  //   4. Confirm modal shows "5 will lose access"
  //   5. Click commit
  //   6. ClassSubscription count for class C === 0
});
