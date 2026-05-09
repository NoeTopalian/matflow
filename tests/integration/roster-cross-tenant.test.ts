import { describe, it } from "vitest";

// Integration test — requires a real DB and a session-cookie test fixture pattern
// not yet established in this repo. Stubbed to keep the spec's coverage table
// honest. The cross-tenant rejection logic is covered functionally by Task 2's
// unit test (it asserts the same `findFirst({ where: { id, tenantId } })` shape
// that prevents cross-tenant resolution).
describe("Roster cross-tenant rejection (integration)", () => {
  it.todo("POST /api/classes/[id]/roster rejects member from different tenant with 404");
  it.todo("GET /api/classes/[id]/roster returns empty for class in different tenant");
  it.todo("DELETE /api/classes/[id]/roster/[memberId] cannot remove cross-tenant roster row");
});
