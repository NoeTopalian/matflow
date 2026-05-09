import { describe, it } from "vitest";

// Integration test — requires a real DB. Stubbed for the v1 ship; the soft-delete
// behaviour is exercised end-to-end by the manual smoke-test in the plan's
// verification section. Promoted to full integration coverage once Vitest
// integration runner has a dedicated test-DB-fixture pattern in this repo.
describe("RankSystem soft-delete", () => {
  it.todo("hides soft-deleted RankSystem from GET /api/ranks");
  it.todo("refuses DELETE when classes depend on the rank");
  it.todo("returns 200 + sets deletedAt when no dependencies");
});
