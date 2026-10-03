/**
 * Every source row and every person accounted for, separately (Total BJJ
 * handover, 3 Oct 2026). The preview's "Will import" is a count of DRAFTS —
 * the people in the file who will be created PLUS the guardian records the
 * importer synthesises from emergency contacts, MINUS children it had to
 * hold back — so it is not a people count and must never be read as one.
 *
 * On the synthetic fixture of tests/unit/import-teamup.test.ts (every name
 * invented), through parseTeamUp and the real commit route over an in-memory
 * database, this pins the separate counts the handover reports:
 *   source rows · provisional people · member drafts by account type ·
 *   synthesised guardian records · existing matched · guardian suggestions ·
 *   membership-history records · duplicates · quarantined · excluded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseTeamUp } from "@/lib/importers/teamup";
import { buildExceptionRows } from "@/lib/importers/teamup-exceptions";

const h = vi.hoisted(() => ({ files: new Map<string, string>(), ledger: [] as Record<string, unknown>[] }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: async () => ({ ok: true, tenantId: "t1", userId: "u1" }) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/member-status", () => ({ recordStatusEventsBulk: vi.fn(async () => {}) }));
vi.mock("@/lib/api-error", () => ({ apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }) }));
vi.mock("@/lib/import-storage", () => ({ readImportFile: async (url: string) => h.files.get(url) ?? null, deleteImportFile: async () => {} }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx()) }));

type Row = Record<string, unknown> & { id: string };
let db: { jobs: Row[]; members: Row[] };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { not?: unknown; in?: unknown[]; notIn?: unknown[]; lt?: Date; gte?: Date; endsWith?: string; mode?: string };
      const val = row[k];
      const ci = op.mode === "insensitive";
      const norm = (x: unknown) => (ci && typeof x === "string" ? x.toLowerCase() : x);
      if ("not" in op) return (val ?? null) !== op.not;
      if ("in" in op) return op.in!.map(norm).includes(norm(val));
      if ("notIn" in op) return !op.notIn!.includes(val);
      if ("endsWith" in op) return typeof val === "string" && val.endsWith(op.endsWith!);
      if ("lt" in op) return val != null && (val as Date) < op.lt!;
      if ("gte" in op) return val != null && (val as Date) >= op.gte!;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

function makeTx() {
  return {
    importJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => db.jobs.find((x) => matches(x, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => db.jobs.find((x) => x.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(db.jobs.find((x) => x.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.jobs.filter((x) => matches(x, where));
        for (const x of hit) Object.assign(x, data);
        return { count: hit.length };
      },
    },
    membershipTier: { findMany: async () => [] },
    member: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.members.filter((m) => matches(m, where)).map((m) => ({ ...m, children: db.members.filter((c) => c.parentMemberId === m.id) })),
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const d of data) db.members.push({ ...d, id: `m${db.members.length + 1}` });
        return { count: data.length };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => db.members.filter((m) => matches(m, where)).length,
    },
    user: { findUnique: async () => ({ name: "Owner", email: "owner@example.test", tenant: { name: "Club" } }) },
    tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
    importedMembership: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => { h.ledger.push(...data); return { count: data.length }; },
      count: async () => h.ledger.length,
    },
  };
}

// The fixture of tests/unit/import-teamup.test.ts (invented people).
const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
function row(o: Partial<Record<"name" | "email" | "other" | "plan" | "type" | "status" | "proc" | "start" | "expiry" | "cancelled" | "completed" | "marketing" | "phone" | "dob" | "ecName" | "ecPhone" | "ecRel", string>>): string {
  const v = (s?: string) => ((s ?? "").includes(",") ? `"${s}"` : (s ?? ""));
  return [o.name, o.email, o.other, o.plan, o.type ?? "recurring", o.status, o.proc ?? "Stripe", o.start, o.start, o.expiry, o.cancelled, "Yes", o.completed, "", "", "", "", "", "GB", o.marketing, o.phone, "", o.dob, o.ecName, o.ecPhone, o.ecRel].map(v).join(",");
}
const FIXTURE = [
  HEADER,
  row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-14", dob: "1990-04-15", ecName: "Bob Lovelace", ecPhone: "07000000002", ecRel: "Husband" }),
  row({ name: "Ada Lovelace", email: "ada@example.test", other: "Adults Advanced 2026", plan: "Beginners Course 2026", status: "upgraded", start: "2025-11-01", expiry: "2026-01-13" }),
  row({ name: "Priya Sharma", email: "priya@example.test", plan: "Advanced Unlimited Adult Classes (OLD)", status: "active", start: "2024-12-01", dob: "1985-06-12" }),
  row({ name: "Neha Sharma", email: "priya@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-02-02", dob: "2016-03-21", ecName: "Priya Sharma", ecRel: "Mother" }),
  row({ name: "Arjun Sharma", email: "priya@example.test", plan: "Kids Once-A-Week 2026", status: "hold", start: "2026-02-02", dob: "2013-12-16", ecName: "Priya Sharma", ecRel: "Mother" }),
  row({ name: "Leo Okafor", email: "okafor.family@example.test", plan: "Kids Once-A-Week 2026", status: "active", start: "2026-03-14", dob: "2019-06-24", ecName: "Chidi Okafor", ecPhone: "07000000005", ecRel: "Father" }),
  row({ name: "Musa Kasim", email: "", plan: "Adults Advanced 2026", status: "active", start: "2026-05-04", dob: "1998-01-08" }),
  row({ name: "(Deleted Customer)", email: "", plan: "Kids Unlimited Membership (OLD)", status: "cancelled", start: "2024-12-01", expiry: "2025-08-31", cancelled: "2025-08-22" }),
  row({ name: "Tom Roper", email: "tom@example.test", plan: "Advanced Unlimited Adult Classes", status: "cancelled", start: "2025-02-03", expiry: "2025-12-08", cancelled: "2025-12-08", dob: "1999-06-28" }),
  row({ name: "Elvis Webster", email: "elvis@example.test", plan: "8 Week Beginners Course", type: "prepaid", status: "completed", proc: "", start: "2025-01-16", expiry: "2025-07-24", completed: "2025-07-25T01:01:35+01:00", dob: "2003-02-11" }),
  row({ name: "Sam Rice", email: "rice.house@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-06-01", dob: "1992-11-10" }),
  row({ name: "Jo Rice", email: "rice.house@example.test", plan: "Beginners Course 2026", status: "active", start: "2026-06-01", dob: "1994-02-02" }),
  row({ name: "Zain Ali", email: "zain@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-04-08", dob: "2000-01-08" }),
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-06-17", dob: "1992-11-13" }),
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Advanced Once Per Week 2026", status: "active", start: "2026-06-20", dob: "1992-11-13" }),
  // Added for this ledger: an exact duplicate of Tom's row, and a child with no email (held back).
  row({ name: "Tom Roper", email: "tom@example.test", plan: "Advanced Unlimited Adult Classes", status: "cancelled", start: "2025-02-03", expiry: "2025-12-08", cancelled: "2025-12-08", dob: "1999-06-28" }),
  row({ name: "Lil Nobody", email: "", plan: "Kids Unlimited 2026", status: "active", start: "2026-03-01", dob: "2019-01-01" }),
].join("\n");

const EXPORTED = new Date("2026-09-24T10:00:00Z");

/** The handover's separate counts, from the parser and the commit manifest. */
function accounting(parsed: ReturnType<typeof parseTeamUp>, manifest: { created: { total: number }; skippedExisting: number; commitErrors: number; reconciles: boolean; teamup2: { ledger: { rows: number; persisted: number } } }) {
  const by = (k: string) => parsed.drafts.filter((d) => d.accountType === k).length;
  const disp = (p: string) => parsed.rows.filter((r) => r.disposition.startsWith(p)).length;
  return {
    sourceRows: parsed.summary.sourceRows,
    provisionalPeople: parsed.summary.people,
    memberDrafts: { adult: by("adult"), junior: by("junior"), kids: by("kids") },
    synthesisedGuardianRecords: by("parent"),
    existingMatched: manifest.skippedExisting,
    created: manifest.created.total,
    guardianSuggestions: {
      sharedEmail: parsed.drafts.filter((d) => d.guardianSuggestedBy === "shared_email").length,
      emergencyContact: parsed.drafts.filter((d) => d.guardianSuggestedBy === "emergency_contact").length,
    },
    membershipHistoryRecords: disp("member_history"),
    duplicates: disp("duplicate_of"),
    quarantined: disp("quarantined"),
    quarantinedPeople: parsed.summary.kidsWithoutParent,
    excluded: disp("excluded"),
    ledgerPersisted: manifest.teamup2.ledger.persisted,
  };
}

beforeEach(() => {
  h.files.clear();
  h.ledger = [];
  h.files.set("local-import://acc", FIXTURE);
  db = {
    members: [],
    jobs: [{ id: "job1", tenantId: "t1", source: "teamup", mode: "create", status: "preview", fileBlobUrl: "local-import://acc", fileName: "teamup.csv", fileHash: "hash-acc", sourceExportedAt: EXPORTED, sourceExportedAtProvenance: "owner_stated", startedAt: null, completedAt: null, rolledBackAt: null, manifest: null, mappingVersion: "teamup-2@2026-10-02" }],
  };
});

describe("every source row and every person, accounted for separately", () => {
  const parsed = parseTeamUp(FIXTURE, { asOf: "2026-09-24" });

  it("source rows = history records + duplicates + quarantined + excluded", () => {
    expect(parsed.summary.sourceRows).toBe(17);
    expect(parsed.rows).toHaveLength(17);
    const n = (p: string) => parsed.rows.filter((r) => r.disposition.startsWith(p)).length;
    expect({ history: n("member_history"), duplicate: n("duplicate_of"), quarantined: n("quarantined"), excluded: n("excluded") }).toEqual({ history: 14, duplicate: 1, quarantined: 1, excluded: 1 });
  });

  it("people in the file = adults + children imported + children held back; guardian records are NOT people in the file", () => {
    const s = parsed.summary;
    expect(s.people).toBe(13);
    expect(s.people).toBe(s.adults + s.kids + s.kidsWithoutParent);
    expect({ adults: s.adults, kids: s.kids, heldBack: s.kidsWithoutParent }).toEqual({ adults: 9, kids: 3, heldBack: 1 });
    expect(parsed.drafts.filter((d) => d.accountType === "parent")).toHaveLength(1);
  });

  it("'Will import' = drafts = people created + synthesised guardians − children held back (not a people count)", () => {
    const drafts = parsed.drafts.length;
    expect(drafts).toBe(13); // 9 adults + 3 children + 1 guardian record
    expect(drafts).toBe(parsed.summary.people - parsed.summary.kidsWithoutParent + parsed.summary.parentsSynthesised);
  });

  it("the commit manifest reconciles to the same counts; an existing member is 'existing matched', not created", async () => {
    // Ada is already in the club.
    db.members.push({ id: "m0", tenantId: "t1", name: "Ada Lovelace", email: "ada@example.test", parentMemberId: null, importJobId: null });
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    const res = (await POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: "job1" }) })) as unknown as { status: number; json: () => Promise<{ manifest: Parameters<typeof accounting>[1] }> };
    expect(res.status).toBe(200);
    const { manifest } = await res.json();
    expect(accounting(parsed, manifest)).toEqual({
      sourceRows: 17,
      provisionalPeople: 13,
      memberDrafts: { adult: 9, junior: 0, kids: 3 },
      synthesisedGuardianRecords: 1,
      existingMatched: 1,
      created: 12,
      guardianSuggestions: { sharedEmail: 2, emergencyContact: 1 },
      membershipHistoryRecords: 14,
      duplicates: 1,
      quarantined: 1,
      quarantinedPeople: 1,
      excluded: 1,
      ledgerPersisted: 17,
    });
    expect(manifest.reconciles).toBe(true);
    expect(manifest.created.total + manifest.skippedExisting + manifest.commitErrors).toBe(parsed.drafts.length);
    // The held-back child is a parse error with its line, not a silent drop, and its row is in the ledger.
    expect(parsed.errors).toEqual([expect.objectContaining({ reason: expect.stringMatching(/needs a parent/) })]);
    expect(h.ledger.filter((r) => String(r.disposition).startsWith("quarantined")).map((r) => r.memberId)).toEqual([null]);
  });

  it("the exceptions download lists the held-back child by source row (app/api/admin/import/[id]/exceptions)", () => {
    const refused = buildExceptionRows(parsed.drafts, parsed.errors, new Set()).filter((r) => r.kind === "refused_row");
    expect(refused).toEqual([expect.objectContaining({ name: "Row 18", sourceRows: [18], detail: expect.stringMatching(/needs a parent/) })]);
  });
});
