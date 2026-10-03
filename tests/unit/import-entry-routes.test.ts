/**
 * The import entry point (3 Oct 2026, Total BJJ handover).
 *
 *  - A file meant for another import path is refused by the upload route with
 *    the path to use, and no job is created (lib/importers/sniff.ts).
 *  - The export time carries its provenance: owner_stated or provisional.
 *  - The preview names, before commit, every plan label a LIVE membership
 *    carries that no tier matches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { gateMock, files } = vi.hoisted(() => ({ gateMock: vi.fn(), files: new Map<string, string>() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => gateMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => undefined }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number, e?: unknown) => {
    if (e) console.error(e);
    return { status, json: async () => ({ error: message }) };
  },
}));
vi.mock("@/lib/import-storage", () => ({
  importStorageAvailable: () => true,
  sha256: (b: Uint8Array) => `hash-${Buffer.from(b).toString("base64").slice(-24)}-${b.length}`,
  putImportFile: async (_t: string, b: Uint8Array) => {
    const url = `local-import://f${files.size}`;
    files.set(url, new TextDecoder().decode(b));
    return url;
  },
  readImportFile: async (url: string) => files.get(url) ?? null,
  deleteImportFile: async (url: string) => { files.delete(url); },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx()),
}));

type Job = Record<string, unknown> & { id: string };
let db: { jobs: Job[]; tiers: { id: string; name: string; billingCycle: string }[] };

function makeTx() {
  return {
    tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
    member: { findMany: async () => [] },
    class: { findMany: async () => [] },
    membershipTier: { findMany: async () => db.tiers },
    importJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        db.jobs.find((j) => (where.id ? j.id === where.id : j.fileHash === where.fileHash && j.status === "complete")) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const j = { id: `job_${db.jobs.length + 1}`, createdAt: new Date(), totalRows: 0, processedRows: 0, importedRows: 0, skippedRows: 0, errorRows: 0, startedAt: null, completedAt: null, errorLog: null, manifest: null, rolledBackAt: null, mode: "create", ...data };
        db.jobs.push(j);
        return j;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => x.id === where.id)!;
        Object.assign(j, data);
        return j;
      },
    },
  };
}

import { POST as uploadPOST } from "@/app/api/admin/import/upload/route";
import { POST as attendancePOST } from "@/app/api/admin/import/attendance/route";
import { POST as previewPOST } from "@/app/api/admin/import/[id]/preview/route";

type Res = { status: number; json: () => Promise<Record<string, unknown>> };

const TEAMUP_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
function row(o: { name: string; email: string; plan: string; status: string; start: string; expiry?: string; cancelled?: string; dob?: string }): string {
  return [o.name, o.email, "", o.plan, "recurring", o.status, "Stripe", o.start, o.start, o.expiry ?? "", o.cancelled ?? "", "Yes", "", "", "", "", "", "", "GB", "", "", "", o.dob ?? "", "", "", ""].join(",");
}
const TEAMUP_FILE = "﻿" + [
  TEAMUP_HEADER,
  row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-14", dob: "1990-04-15" }),
  row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Beginners Course 2026", status: "upgraded", start: "2025-11-01", expiry: "2026-01-13" }),
  row({ name: "Hal Hold", email: "hal@example.test", plan: "Beginner Course", status: "hold", start: "2026-03-01", dob: "1991-01-01" }),
  row({ name: "Sid Soon", email: "sid@example.test", plan: "Kids & Beginners Course 2026", status: "active", start: "2026-10-05", dob: "1993-03-03" }),
  row({ name: "Tom Roper", email: "tom@example.test", plan: "Advanced Once Per Week (OLD)", status: "cancelled", start: "2025-02-03", expiry: "2025-12-08", cancelled: "2025-12-08", dob: "1999-06-28" }),
].join("\r\n") + "\r\n";
const ATTENDANCE_FILE = "Attendance ID,Customer Email,Customer Name,Event Name,Start Date,Start Time,Status\nA1,ada@example.test,Ada Lovelace,Fundamentals,2026-09-01,18:00,attended\n";

function upload(fields: Record<string, string>, content = TEAMUP_FILE, name = "teamup.csv"): Promise<Res> {
  const fd = new FormData();
  fd.append("file", new File([content], name, { type: "text/csv" }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return uploadPOST(new Request("http://localhost/api/admin/import/upload", { method: "POST", body: fd })) as unknown as Promise<Res>;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u1" });
  db = { jobs: [], tiers: [] };
});

// ── Entry point ──────────────────────────────────────────────────────────────

describe("the upload route reads the header before trusting the Source", () => {
  for (const source of ["generic", "mindbody", "glofox", "wodify"]) {
    it(`refuses a TeamUp memberships export sent as ${source}, and creates no job`, async () => {
      const res = await upload({ source, sourceExportedAt: "2026-10-02T17:00:00.000Z" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("This is a TeamUp memberships export. Choose Source: TeamUp (Members) and try again.");
      expect(db.jobs).toHaveLength(0);
      expect(files.size).toBe(0);
    });
  }

  it("refuses a TeamUp attendance export on the Members path, pointing at Attendance history", async () => {
    const res = await upload({ source: "teamup", sourceExportedAt: "2026-10-02T17:00:00.000Z" }, ATTENDANCE_FILE);
    expect(res.status).toBe(400);
    expect(String((await res.json()).error)).toMatch(/attendance export.*Attendance history/i);
    expect(db.jobs).toHaveLength(0);
  });

  it("accepts the TeamUp file as TeamUp, and a valid generic file as generic", async () => {
    expect((await upload({ source: "teamup", sourceExportedAt: "2026-10-02T17:00:00.000Z" })).status).toBe(201);
    expect((await upload({ source: "generic" }, "name,email\nAda,ada@example.test\n", "generic.csv")).status).toBe(201);
    expect(db.jobs.map((j) => j.source)).toEqual(["teamup", "generic"]);
  });
});

describe("the attendance route names a memberships export", () => {
  it("refuses it with the Members/TeamUp instruction instead of 'Missing required column(s): class'", async () => {
    const fd = new FormData();
    fd.append("mode", "preview");
    fd.append("file", new File([TEAMUP_FILE], "teamup.csv", { type: "text/csv" }));
    const res = (await attendancePOST(new Request("http://localhost/api/admin/import/attendance", { method: "POST", body: fd }))) as unknown as Res;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This is a TeamUp memberships export, not an attendance export. Import it under Members with Source: TeamUp.");
    expect(db.jobs).toHaveLength(0);
  });
});

// ── Source-time provenance ───────────────────────────────────────────────────

import { clubWallClockToInstant, withoutProvisionalStanding } from "@/lib/importers";
import { asOfDate } from "@/lib/importers/as-of";
import { parseTeamUp } from "@/lib/importers/teamup";
import { planRefresh } from "@/lib/importers/teamup-refresh";

const LONDON = "Europe/London";

describe("the export time is read in the CLUB's timezone, not the laptop's", () => {
  it("BST: a London wall-clock time is one hour ahead of UTC", () => {
    expect(clubWallClockToInstant("2026-10-02T18:00", LONDON)!.toISOString()).toBe("2026-10-02T17:00:00.000Z");
  });

  // Total BJJ has active memberships scheduled to start on 5 and 19 Oct 2026.
  for (const start of ["2026-10-05", "2026-10-19"]) {
    it(`a membership starting ${start} is scheduled until the club's midnight, current after it`, () => {
      const file = [TEAMUP_HEADER, row({ name: "Sid Soon", email: "sid@example.test", plan: "Adults Advanced 2026", status: "active", start, dob: "1993-03-03" })].join("\n");
      const dayBefore = new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      const before = clubWallClockToInstant(`${dayBefore}T23:30`, LONDON)!;
      const after = clubWallClockToInstant(`${start}T00:15`, LONDON)!;
      // 00:15 BST is still the previous day in UTC — the club date is what counts.
      expect(after.toISOString()).toBe(`${dayBefore}T23:15:00.000Z`);
      expect(asOfDate(before, LONDON)).toBe(dayBefore);
      expect(asOfDate(after, LONDON)).toBe(start);
      expect(parseTeamUp(file, { asOf: asOfDate(before, LONDON) }).drafts[0].scheduled?.startDate).toBe(start);
      expect(parseTeamUp(file, { asOf: asOfDate(after, LONDON) }).drafts[0]).toMatchObject({ membershipType: "Adults Advanced 2026" });
      expect(parseTeamUp(file, { asOf: asOfDate(after, LONDON) }).drafts[0].scheduled).toBeUndefined();
      // What the panel used to send from a laptop in Bali (UTC+8): new Date(value) in the laptop's zone.
      const baliLaptop = new Date(`${start}T00:15:00+08:00`);
      expect(asOfDate(baliLaptop, LONDON)).toBe(dayBefore); // the wrong day — the bug this closes
    });
  }

  it("a membership expiring on the export date is live that day, history the next (boundary ending)", () => {
    const file = [TEAMUP_HEADER, row({ name: "Eve End", email: "eve@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-01", expiry: "2026-10-02", dob: "1990-01-01" })].join("\n");
    const lateOn2nd = asOfDate(clubWallClockToInstant("2026-10-02T23:45", LONDON)!, LONDON);
    const earlyOn3rd = asOfDate(clubWallClockToInstant("2026-10-03T00:30", LONDON)!, LONDON);
    expect(lateOn2nd).toBe("2026-10-02");
    expect(earlyOn3rd).toBe("2026-10-03");
    expect(parseTeamUp(file, { asOf: lateOn2nd }).drafts[0].status).toBe("active");
    expect(parseTeamUp(file, { asOf: earlyOn3rd }).drafts[0].status).toBe("cancelled");
  });

  it("across the October changeover (25 Oct 2026): GMT after, and the repeated hour keeps its date", () => {
    expect(clubWallClockToInstant("2026-10-24T12:00", LONDON)!.toISOString()).toBe("2026-10-24T11:00:00.000Z");
    expect(clubWallClockToInstant("2026-10-26T00:30", LONDON)!.toISOString()).toBe("2026-10-26T00:30:00.000Z");
    // 01:30 happens twice on 25 Oct; the second (GMT) occurrence is taken. Same club date either way.
    const repeated = clubWallClockToInstant("2026-10-25T01:30", LONDON)!;
    expect(repeated.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    expect(asOfDate(repeated, LONDON)).toBe("2026-10-25");
    expect(asOfDate(clubWallClockToInstant("2026-10-25T23:59", LONDON)!, LONDON)).toBe("2026-10-25");
  });

  it("the March changeover: a skipped time resolves after the gap, same date", () => {
    const skipped = clubWallClockToInstant("2026-03-29T01:30", LONDON)!;
    expect(skipped.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(asOfDate(skipped, LONDON)).toBe("2026-03-29");
  });

  it("refuses anything that is not a wall-clock value", () => {
    for (const bad of ["", "2026-10-02", "2026-13-01T10:00", "2026-02-30T10:00", "2026-10-02T24:00", "yesterday"]) {
      expect(clubWallClockToInstant(bad, LONDON)).toBeNull();
    }
  });
});

describe("the upload stores how the export time is known", () => {
  it("a club-local time is converted with the tenant timezone and stored as owner_stated", async () => {
    const res = await upload({ source: "teamup", sourceExportedAtLocal: "2026-10-02T18:00" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sourceExportedAtProvenance).toBe("owner_stated");
    expect((db.jobs[0].sourceExportedAt as Date).toISOString()).toBe("2026-10-02T17:00:00.000Z");
    expect(db.jobs[0].sourceExportedAtProvenance).toBe("owner_stated");
  });

  it("an estimate is stored as provisional", async () => {
    const res = await upload({ source: "teamup", sourceExportedAtLocal: "2026-10-02T09:00", sourceExportedAtProvenance: "provisional" });
    expect(res.status).toBe(201);
    expect((await res.json()).sourceExportedAtProvenance).toBe("provisional");
    expect(db.jobs[0].sourceExportedAtProvenance).toBe("provisional");
  });

  it("no time → no provenance (generic); an estimate with no time, or an unknown value, is refused", async () => {
    expect((await upload({ source: "generic" }, "name,email\nAda,ada@example.test\n", "g.csv")).status).toBe(201);
    expect(db.jobs[0].sourceExportedAtProvenance).toBeNull();
    expect((await upload({ source: "generic", sourceExportedAtProvenance: "provisional" }, "name,email\nBo,bo@example.test\n", "g2.csv")).status).toBe(400);
    expect((await upload({ source: "teamup", sourceExportedAtLocal: "2026-10-02T09:00", sourceExportedAtProvenance: "guess" })).status).toBe(400);
    expect((await upload({ source: "teamup", sourceExportedAtLocal: "not-a-time" })).status).toBe(400);
    expect(db.jobs).toHaveLength(1);
  });
});

describe("the preview says when the as-of date is provisional", () => {
  async function previewOf(provenance: string | null) {
    files.set("local-import://p", TEAMUP_FILE);
    db.jobs.push({ id: "job_p", tenantId: "t1", source: "teamup", mode: "create", fileName: "t.csv", fileBlobUrl: "local-import://p", status: "pending", fileHash: "h", sourceExportedAt: new Date("2026-10-02T17:00:00Z"), sourceExportedAtProvenance: provenance, rolledBackAt: null });
    const res = (await previewPOST(new Request("http://localhost/x", { method: "POST" }), params("job_p"))) as unknown as Res;
    expect(res.status).toBe(200);
    return (await res.json()).teamup2 as { asOf: string; asOfIsProvisional: boolean; asOfProvenance: string | null };
  }
  it("provisional → asOfIsProvisional true, provenance named", async () => {
    expect(await previewOf("provisional")).toMatchObject({ asOf: "2026-10-02", asOfIsProvisional: true, asOfProvenance: "provisional" });
  });
  it("owner-stated → not provisional", async () => {
    expect(await previewOf("owner_stated")).toMatchObject({ asOfIsProvisional: false, asOfProvenance: "owner_stated" });
  });
  it("a job from before the column (NULL provenance, time given) reads as owner-stated", async () => {
    expect(await previewOf(null)).toMatchObject({ asOfIsProvisional: false, asOfProvenance: "owner_stated" });
  });
});

describe("a provisional time never blocks the refresh that carries the real one", () => {
  const file = [TEAMUP_HEADER, row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-14", dob: "1990-04-15" })].join("\n");
  const parsed = parseTeamUp(file, { asOf: "2026-10-02" });
  const ESTIMATE = new Date("2026-10-02T20:00:00Z"); // the owner guessed late
  const REAL = new Date("2026-10-02T08:30:00Z");
  const member = { id: "m1", name: "Ada Lovelace", externalRef: parsed.drafts[0].sourceKey!, billedBy: "teamup", status: "active", paymentStatus: "paid", cancelledAt: null, membershipType: "Adults Advanced 2026", membershipTierId: null, billingStatusAsOf: ESTIMATE, billingStatusSource: "job_create" };
  const txWith = (provenance: string) => ({
    importJob: { findMany: async ({ where }: { where: { id: { in: string[] }; sourceExportedAtProvenance: string } }) => (where.id.in.includes("job_create") && where.sourceExportedAtProvenance === provenance ? [{ id: "job_create" }] : []) },
  }) as unknown as Parameters<typeof withoutProvisionalStanding>[0];

  it("owner-stated create time later than the refresh → refused as older (unchanged rule)", async () => {
    const members = await withoutProvisionalStanding(txWith("owner_stated"), "t1", [member]);
    const plan = planRefresh({ drafts: parsed.drafts, errors: [], members: members as never, tiers: [], job: { id: "job_refresh", sourceExportedAt: REAL } });
    expect(plan.olderThanRecorded).toMatchObject({ members: 1 });
  });

  it("provisional create time later than the real one → the refresh goes through and re-dates the standing", async () => {
    const members = await withoutProvisionalStanding(txWith("provisional"), "t1", [member]);
    const plan = planRefresh({ drafts: parsed.drafts, errors: [], members: members as never, tiers: [], job: { id: "job_refresh", sourceExportedAt: REAL } });
    expect(plan.olderThanRecorded).toBeUndefined();
    expect(plan.matched[0].after.billingStatusAsOf).toBe(REAL.toISOString());
  });
});
