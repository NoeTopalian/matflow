/**
 * teamup-2 exceptions (2 Oct 2026): one row per decision/confirmation the owner
 * owes, built from the parser's drafts and errors, downloadable as a CSV with
 * the formula guard on every text cell. Pinned on a small file shaped like
 * the real export: a decision (two started actives), a scheduled start, a
 * kid on a shared email (suggested guardian), a kid whose only adult is an
 * emergency contact (guardian draft), a second adult on a shared email, an
 * active adult with no email, a cancellation with no date, a plan with no
 * tier, and a refused row.
 */
import { describe, it, expect } from "vitest";
import { parseTeamUp } from "@/lib/importers/teamup";
import { buildExceptionRows, countByKind, exceptionsCsv } from "@/lib/importers/teamup-exceptions";

const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";

function row(o: { name: string; email: string; plan: string; status: string; start: string; expiry?: string; cancelled?: string; dob?: string; ec?: [string, string, string]; other?: string }): string {
  return [o.name, o.email, o.other ?? "", o.plan, "recurring", o.status, "Stripe", o.start, o.start, o.expiry ?? "", o.cancelled ?? "", "Yes", "", "", "", "", "", "", "GB", "", "", "", o.dob ?? "", o.ec?.[0] ?? "", o.ec?.[1] ?? "", o.ec?.[2] ?? ""].join(",");
}

const FILE = [
  HEADER,
  // 2: Dan — two started actives → decision.
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-05", dob: "1992-11-13", other: "Adults Unlimited 2026" }),
  // 3
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Adults Unlimited 2026", status: "active", start: "2026-06-01", dob: "1992-11-13", other: "Adults Advanced 2026" }),
  // 4: Sue — started active + a future start → scheduled.
  row({ name: "Sue Start", email: "sue@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-02-01", expiry: "2026-10-31", dob: "1990-01-01" }),
  // 5
  row({ name: "Sue Start", email: "sue@example.test", plan: "Adults Unlimited 2026", status: "active", start: "2026-11-01", dob: "1990-01-01" }),
  // 6: Kim (kid) shares Pat's email → suggested from shared email.
  row({ name: "Pat Parent", email: "pat@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-03-01", dob: "1985-05-05" }),
  // 7
  row({ name: "Kim Parent", email: "pat@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-03-01", dob: "2018-04-04", ec: ["Pat Parent", "07700900001", "Mother"] }),
  // 8: Ola (kid) on her own email, adult only as emergency contact → guardian draft.
  row({ name: "Ola Only", email: "ola-payer@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-04-01", dob: "2017-09-09", ec: ["Mo Only", "07700900002", "Father"] }),
  // 9: Second adult on Pat's email.
  row({ name: "Sam Parent", email: "pat@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-03-01", dob: "1986-06-06" }),
  // 10: Active adult, no email.
  row({ name: "Ned Noemail", email: "", plan: "Adults Advanced 2026", status: "active", start: "2026-05-01", dob: "1991-02-02" }),
  // 11: Cancelled, no date.
  row({ name: "Cal Cancelled", email: "cal@example.test", plan: "Legacy Plan 4-weekly", status: "cancelled", start: "2025-01-01", dob: "1980-03-03" }),
  // 12: Kid, no email, no adult → refused.
  row({ name: "Lil Nobody", email: "", plan: "Kids Unlimited 2026", status: "active", start: "2026-03-01", dob: "2019-01-01" }),
].join("\n");

const parsed = parseTeamUp(FILE, { asOf: "2026-10-02" });
const TIERS = new Set(["adults advanced 2026", "adults unlimited 2026", "kids unlimited 2026"]);

describe("buildExceptionRows", () => {
  const rows = buildExceptionRows(parsed.drafts, parsed.errors, TIERS);
  const counts = countByKind(rows);

  it("lists every exception class exactly once for this file", () => {
    expect(counts).toEqual({
      decision_required: 1,
      scheduled_start: 1,
      guardian_suggested: 2, // Kim (shared email) + Ola (emergency contact)
      guardian_draft: 1, // Mo Only, made from Ola's emergency contact
      shared_email_adult: 1, // Sam
      missing_email_active: 1, // Ned
      cancelled_without_date: 1, // Cal
      plan_without_tier: 1, // Legacy Plan 4-weekly
      refused_row: 1, // Lil
    });
  });

  it("names the decision's options and rows, the scheduled plan and date, and the suggested guardian", () => {
    const dan = rows.find((r) => r.kind === "decision_required")!;
    expect(dan.name).toBe("Dan Coles");
    expect(dan.detail).toBe("Adults Advanced 2026 or Adults Unlimited 2026");
    expect(dan.sourceRows).toEqual([2, 3]);
    const sue = rows.find((r) => r.kind === "scheduled_start")!;
    expect(sue.detail).toBe("Adults Unlimited 2026 from 2026-11-01");
    const kim = rows.find((r) => r.kind === "guardian_suggested" && r.name === "Kim Parent")!;
    expect(kim.detail).toBe("Pat Parent (shared email address)");
    const ola = rows.find((r) => r.kind === "guardian_suggested" && r.name === "Ola Only")!;
    expect(ola.detail).toBe("Mo Only (emergency contact)");
    const mo = rows.find((r) => r.kind === "guardian_draft")!;
    expect(mo.email).toBe("ola-payer@example.test");
  });

  it("never prints a synthesised login as an email", () => {
    for (const r of rows) expect(r.email ?? "").not.toMatch(/no-login|matflow\.local/);
  });
});

describe("exceptionsCsv", () => {
  it("guards formula-prefixed text and quotes commas; header names the club, file and as-of", () => {
    const csv = exceptionsCsv(
      [{ kind: "refused_row", name: "=cmd()", email: null, action: "Fix it", detail: "a, b", sourceRows: [4, 5] }],
      { club: "Total BJJ", file: "report.csv", asOf: "2026-10-02" },
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("MatFlow TeamUp import exceptions,Total BJJ,report.csv,as of 2026-10-02");
    expect(lines[1]).toBe("Kind,What it means,Person or row,Email,Detail,What to do,Source rows");
    expect(lines[2]).toBe(`refused_row,Row not imported,'=cmd(),,"a, b",Fix it,4 5`);
  });
});
