import { describe, it, expect } from "vitest";
import { isStepUpAction, canonicalStepUpChange, stepUpVersion } from "@/lib/operator-step-up";

const tx = (user: Record<string, unknown> | null) =>
  ({ user: { findFirst: async () => user } }) as never;

describe("staff.login_email step-up action", () => {
  it("is a known action with a { newEmail } change, normalised", () => {
    expect(isStepUpAction("staff.login_email")).toBe(true);
    expect(canonicalStepUpChange("staff.login_email", { newEmail: " Pat@Example.COM " })).toEqual({ newEmail: "pat@example.com" });
    expect(canonicalStepUpChange("staff.login_email", {})).toBeNull();
  });
  it("versions a non-owner staff account on role, session version, address and password presence", async () => {
    const v = await stepUpVersion(
      tx({ id: "u1", role: "manager", sessionVersion: 3, email: "Pat@x.com", passwordHash: "h" }),
      "staff.login_email",
      "t1/u1/change",
    );
    expect(v).toBe("user:u1:role=manager:sv3:email=pat@x.com:pw=true");
  });
  it("refuses to version an owner (owners use owner.login_email)", async () => {
    const v = await stepUpVersion(
      tx({ id: "u1", role: "owner", sessionVersion: 1, email: "o@x.com", passwordHash: "h" }),
      "staff.login_email",
      "t1/u1/change",
    );
    expect(v).toBeNull();
  });
  it("is null for a user outside the tenant", async () => {
    expect(await stepUpVersion(tx(null), "staff.login_email", "t1/u9/change")).toBeNull();
  });
});
