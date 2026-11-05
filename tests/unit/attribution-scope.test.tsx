import { describe, it, expect, vi } from "vitest";
import { firstForeignAttribution, attributionNotFoundMessage } from "@/lib/attribution-scope";

// A fake withTenantContext tx: a row resolves only when its id is in the given
// tenant's set. Asserts the security outcome — a foreign id is reported, an
// in-tenant id is accepted — not the SQL.
function tx(inTenant: { users?: string[]; members?: string[] }, tenantId: string) {
  const find = (ids: string[] = []) =>
    vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
      where.tenantId === tenantId && ids.includes(where.id) ? { id: where.id } : null,
    );
  return { user: { findFirst: find(inTenant.users) }, member: { findFirst: find(inTenant.members) } };
}

describe("firstForeignAttribution", () => {
  const T = "tenant-A";

  it("returns null when no attribution ids are supplied", async () => {
    expect(await firstForeignAttribution(tx({}, T), T, {})).toBeNull();
  });

  it("treats null ids as cleared, not foreign", async () => {
    expect(await firstForeignAttribution(tx({}, T), T, { trialRunById: null, creditedToUserId: null, creditedToMemberId: null })).toBeNull();
  });

  it("accepts ids that resolve inside the tenant", async () => {
    const t = tx({ users: ["u1"], members: ["m1"] }, T);
    expect(await firstForeignAttribution(t, T, { trialRunById: "u1", creditedToMemberId: "m1" })).toBeNull();
  });

  it("reports a cross-tenant staff trial-run id", async () => {
    const t = tx({ users: ["u1"] }, T); // "uB" belongs to another tenant → not found
    expect(await firstForeignAttribution(t, T, { trialRunById: "uB" })).toBe("trialRunById");
  });

  it("reports a cross-tenant credited member id", async () => {
    const t = tx({ members: ["m1"] }, T);
    expect(await firstForeignAttribution(t, T, { creditedToMemberId: "mB" })).toBe("creditedToMemberId");
  });

  it("reports a cross-tenant credited staff id", async () => {
    const t = tx({ users: ["u1"] }, T);
    expect(await firstForeignAttribution(t, T, { creditedToUserId: "uB" })).toBe("creditedToUserId");
  });

  it("does not confuse a user id with a member id (type must match)", async () => {
    // mB is a valid MEMBER id but is offered as creditedToUserId → must be rejected.
    const t = tx({ users: ["u1"], members: ["mB"] }, T);
    expect(await firstForeignAttribution(t, T, { creditedToUserId: "mB" })).toBe("creditedToUserId");
  });

  it("gives a distinct message per field", () => {
    expect(attributionNotFoundMessage("creditedToMemberId")).toMatch(/member/i);
    expect(attributionNotFoundMessage("trialRunById")).toMatch(/staff/i);
    expect(attributionNotFoundMessage("creditedToUserId")).toMatch(/staff/i);
  });
});
