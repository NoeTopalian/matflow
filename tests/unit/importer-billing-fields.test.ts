// Track F — importer billing-field widening.
//
// The 4-vendor CSV importer used to carry names/phones only. Sean's real
// spreadsheet (and every other vendor export) also carries billing data —
// membership tier/type, next due date, payment status — and a "first paid
// week" import is not usable without it. These tests pin the new header
// mapping + date/status normalisation added to lib/importers/index.ts:
// per-vendor billing columns get read, dates parse (ISO + UK dd/mm/yyyy +
// permissive fallback), vendor payment words normalise onto the
// Member.paymentStatus CHECK vocabulary, and — the guard that matters most —
// a garbled billing cell is NON-FATAL: it must never drop names+phone.

import { describe, it, expect } from "vitest";
import { parseImport } from "@/lib/importers";

function csv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

describe("importer billing fields — header mapping per vendor", () => {
  it("generic: reads membership, next due date and payment status", () => {
    const text = csv([
      ["name", "email", "membership", "next due date", "payment status"],
      ["Jo Bloggs", "jo@example.com", "BJJ Unlimited", "2026-10-01", "active"],
    ]);
    const { drafts, errors } = parseImport("generic", text);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].membershipType).toBe("BJJ Unlimited");
    expect(drafts[0].nextDueAt).toBe("2026-10-01");
    expect(drafts[0].paymentStatus).toBe("paid");
  });

  it("mindbody: reads active membership, next auto-pay date and autopay status", () => {
    const text = csv([
      ["Client Name", "Email", "Active Membership", "Next Auto-Pay Date", "Autopay Status"],
      ["Sean Coates", "sean@totalbjj.example", "Unlimited Adult", "01/10/2026", "past due"],
    ]);
    const { drafts, errors } = parseImport("mindbody", text);
    expect(errors).toEqual([]);
    expect(drafts[0].membershipType).toBe("Unlimited Adult");
    // UK dd/mm/yyyy: 01/10/2026 -> 1 Oct 2026, not 10 Jan.
    expect(drafts[0].nextDueAt).toBe("2026-10-01");
    expect(drafts[0].paymentStatus).toBe("overdue");
  });

  it("glofox: reads current membership, next billing date and billing status", () => {
    const text = csv([
      ["Name", "Email", "Current Membership", "Next Billing Date", "Billing Status"],
      ["Amy Lee", "amy@example.com", "Kids BJJ", "2026-11-15", "frozen"],
    ]);
    const { drafts, errors } = parseImport("glofox", text);
    expect(errors).toEqual([]);
    expect(drafts[0].membershipType).toBe("Kids BJJ");
    expect(drafts[0].nextDueAt).toBe("2026-11-15");
    expect(drafts[0].paymentStatus).toBe("paused");
  });

  it("wodify: reads membership, next billing date and billing status", () => {
    const text = csv([
      ["Athlete Name", "Email", "Membership", "Next Billing Date", "Billing Status"],
      ["Priya Shah", "priya@example.com", "No-Gi Unlimited", "2026-09-30", "comp"],
    ]);
    const { drafts, errors } = parseImport("wodify", text);
    expect(errors).toEqual([]);
    expect(drafts[0].membershipType).toBe("No-Gi Unlimited");
    expect(drafts[0].nextDueAt).toBe("2026-09-30");
    expect(drafts[0].paymentStatus).toBe("free");
  });
});

describe("importer billing fields — payment status normalisation", () => {
  const cases: [string, string][] = [
    ["active", "paid"],
    ["current", "paid"],
    ["paid", "paid"],
    ["overdue", "overdue"],
    ["past due", "overdue"],
    ["late", "overdue"],
    ["paused", "paused"],
    ["hold", "paused"],
    ["frozen", "paused"],
    ["free", "free"],
    ["comp", "free"],
    ["pending", "pending"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["inactive", "cancelled"],
    // case-insensitive
    ["OVERDUE", "overdue"],
  ];

  it.each(cases)("normalises vendor word %s -> %s", (word, expected) => {
    const text = csv([
      ["name", "email", "payment status"],
      ["Member One", "member1@example.com", word],
    ]);
    const { drafts, errors } = parseImport("generic", text);
    expect(errors).toEqual([]);
    expect(drafts[0].paymentStatus).toBe(expected);
  });

  it("unknown payment status defaults to paid, with a note, and still imports the row", () => {
    const text = csv([
      ["name", "email", "payment status"],
      ["Member Two", "member2@example.com", "gibberish-status"],
    ]);
    const { drafts, errors } = parseImport("generic", text);
    expect(errors).toEqual([]); // non-fatal — the row is not dropped
    expect(drafts).toHaveLength(1);
    expect(drafts[0].paymentStatus).toBe("paid");
    expect(drafts[0].notes).toMatch(/unrecognised payment status/i);
  });

  it("blank payment status defaults to paid silently (no note)", () => {
    const text = csv([
      ["name", "email", "payment status"],
      ["Member Three", "member3@example.com", ""],
    ]);
    const { drafts } = parseImport("generic", text);
    expect(drafts[0].paymentStatus).toBe("paid");
    expect(drafts[0].notes).toBeUndefined();
  });
});

describe("importer billing fields — next due date parsing", () => {
  it("accepts ISO yyyy-mm-dd", () => {
    const text = csv([
      ["name", "email", "next due date"],
      ["Member Four", "member4@example.com", "2026-12-25"],
    ]);
    const { drafts } = parseImport("generic", text);
    expect(drafts[0].nextDueAt).toBe("2026-12-25");
  });

  it("accepts UK dd/mm/yyyy over the mm/dd ambiguity", () => {
    const text = csv([
      ["name", "email", "next due date"],
      ["Member Five", "member5@example.com", "25/12/2026"],
    ]);
    const { drafts } = parseImport("generic", text);
    expect(drafts[0].nextDueAt).toBe("2026-12-25");
  });

  it("an unparseable date leaves nextDueAt blank, adds a note, and never drops the row", () => {
    const text = csv([
      ["name", "email", "next due date"],
      ["Member Six", "member6@example.com", "not-a-date-at-all"],
    ]);
    const { drafts, errors } = parseImport("generic", text);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].nextDueAt).toBeUndefined();
    expect(drafts[0].notes).toMatch(/unrecognised next-due date/i);
  });

  it("a blank next-due cell is tolerated silently", () => {
    const text = csv([
      ["name", "email", "next due date"],
      ["Member Seven", "member7@example.com", ""],
    ]);
    const { drafts } = parseImport("generic", text);
    expect(drafts[0].nextDueAt).toBeUndefined();
    expect(drafts[0].notes).toBeUndefined();
  });

  it("both a garbled date and an unknown status on one row: still one imported row, two notes, no throw", () => {
    const text = csv([
      ["name", "email", "next due date", "payment status"],
      ["Member Eight", "member8@example.com", "not-a-date", "who-knows"],
    ]);
    const { drafts, errors } = parseImport("generic", text);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].nextDueAt).toBeUndefined();
    expect(drafts[0].paymentStatus).toBe("paid");
    expect(drafts[0].notes).toMatch(/unrecognised next-due date/i);
    expect(drafts[0].notes).toMatch(/unrecognised payment status/i);
  });
});

describe("importer billing fields — pre-existing free-text notes are preserved", () => {
  it("appends billing notes to an existing notes cell rather than overwriting it", () => {
    const text = csv([
      ["name", "email", "notes", "next due date"],
      ["Member Nine", "member9@example.com", "Injured left knee", "garbled"],
    ]);
    const { drafts } = parseImport("generic", text);
    expect(drafts[0].notes).toMatch(/^Injured left knee \| /);
    expect(drafts[0].notes).toMatch(/unrecognised next-due date/i);
  });
});

describe("importer billing fields — >60 rows does not choke", () => {
  it("parses a 200-row CSV with billing columns without error", () => {
    const header = ["name", "email", "membership", "next due date", "payment status"];
    const rows = [header];
    for (let i = 0; i < 200; i++) {
      rows.push([`Member ${i}`, `member${i}@example.com`, "BJJ Unlimited", "2026-10-01", "active"]);
    }
    const { drafts, errors } = parseImport("generic", csv(rows));
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(200);
    expect(drafts.every((d) => d.paymentStatus === "paid")).toBe(true);
    expect(drafts.every((d) => d.nextDueAt === "2026-10-01")).toBe(true);
  });
});
