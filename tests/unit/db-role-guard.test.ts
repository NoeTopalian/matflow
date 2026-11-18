// The flag-versus-role decision behind tests/global-db-role-guard.ts and the guarded database runner (19 Nov 2026).
import { describe, it, expect } from "vitest";
import { dbRoleMismatch, rlsGaps } from "../db-role-guard.mjs";

const restricted = { currentUser: "matflow_app", superuser: false, bypassRls: false, serverVersion: "17", sessionBypass: "", tables: 60, rlsTables: 55, ownedUnforced: 0, memberRowsVisible: 0 };
const owner = { ...restricted, currentUser: "neondb_owner", bypassRls: true, memberRowsVisible: 4883 };
const superuser = { ...restricted, currentUser: "postgres", superuser: true, memberRowsVisible: 12 };

describe("database role guard", () => {
  it("accepts the restricted role with RLS_ENFORCED=1 and a bypassing role without it", () => {
    expect(dbRoleMismatch(restricted, "1")).toBeNull();
    expect(dbRoleMismatch(owner, undefined)).toBeNull();
    expect(dbRoleMismatch(superuser, undefined)).toBeNull();
  });

  it("refuses the restricted role when RLS_ENFORCED=1 was left out (the 19 Nov runner mistake)", () => {
    expect(dbRoleMismatch(restricted, undefined)).toMatch(/matflow_app.*RLS_ENFORCED is not 1/);
    expect(dbRoleMismatch(restricted, "0")).toMatch(/RLS_ENFORCED is not 1/);
  });

  it("refuses RLS_ENFORCED=1 on a role that row-level security does not bind", () => {
    expect(dbRoleMismatch(owner, "1")).toMatch(/BYPASSRLS/);
    expect(dbRoleMismatch(superuser, "1")).toMatch(/superuser/);
  });

  it("the flag and the role name are not proof: each way RLS can fail to apply is named", () => {
    expect(rlsGaps({ ...restricted, rlsTables: 0 })).toEqual(["no table in schema public has row-level security enabled"]);
    expect(rlsGaps({ ...restricted, ownedUnforced: 2 })[0]).toMatch(/owns 2 RLS table/);
    expect(rlsGaps({ ...restricted, sessionBypass: "on" })[0]).toMatch(/app\.bypass_rls/);
    expect(rlsGaps({ ...restricted, memberRowsVisible: 3 })[0]).toMatch(/3 Member row\(s\) are visible/);
    expect(dbRoleMismatch({ ...restricted, memberRowsVisible: 3 }, "1")).toMatch(/does not bind/);
  });

  it("an empty or unmigrated database cannot demonstrate visibility, and is not refused for that", () => {
    expect(rlsGaps({ ...restricted, memberRowsVisible: null })).toEqual([]);
  });
});
