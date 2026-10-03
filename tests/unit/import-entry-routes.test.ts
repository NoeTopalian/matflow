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
