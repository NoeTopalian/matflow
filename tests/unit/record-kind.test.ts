import { describe, it, expect } from "vitest";
import { describeRecordKind, sameNameNote } from "@/components/admin/record-kind";

describe("describeRecordKind", () => {
  it("names a staff account as a club sign-in account, with its role", () => {
    const d = describeRecordKind("user", "manager");
    expect(d.badge).toBe("Club sign-in account");
    expect(d.title).toBe("Staff account (manager)");
    expect(d.detail).toMatch(/signs in to the club's back office/);
  });
  it("names the owner role explicitly", () => {
    expect(describeRecordKind("user", "owner").title).toBe("Owner account");
  });
  it("names a member as a member record, never as an account", () => {
    const d = describeRecordKind("member");
    expect(d.badge).toBe("Member record");
    expect(d.title).toBe("Member (gym customer)");
    expect(d.detail).toMatch(/membership, attendance and payments/);
    expect(d.detail).not.toMatch(/back office/);
  });
});

describe("sameNameNote", () => {
  it("warns when the holder shares the owner's name (case and spacing ignored)", () => {
    expect(sameNameNote(" sean coates", "Sean  Coates")).toMatch(/different record from the owner's sign-in account/);
  });
  it("is silent for different names", () => {
    expect(sameNameNote("Pat Smith", "Sean Coates")).toBeNull();
  });
});
