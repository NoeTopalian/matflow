/**
 * A member's erasure reaches the kept import data (lib/importers/import-erasure.ts, 6 Nov 2026).
 * Pure parts against literal CSV and JSON; the file walk against mocked storage and a fake club.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  jobs: [] as Array<{ id: string; tenantId: string; fileBlobUrl: string }>,
  rewritten: [] as Array<{ url: string; text: string }>,
  updates: [] as unknown[],
}));

vi.mock("@/lib/import-storage", () => ({
  readImportFile: vi.fn(async (url: string) => h.files.get(url) ?? null),
  rewriteImportFile: vi.fn(async (url: string, _tenantId: string, text: string) => {
    h.rewritten.push({ url, text });
    // A Blob file gets a new address; the other schemes keep theirs.
    return url.startsWith("https://") ? `${url}-v2` : url;
  }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) =>
    fn({
      importJob: {
        findMany: async ({ where }: { where: { tenantId: string } }) => h.jobs.filter((j) => j.tenantId === where.tenantId && j.fileBlobUrl !== ""),
        updateMany: async (args: unknown) => { h.updates.push(args); return { count: 1 }; },
      },
    }),
}));

import { csvRecords, eraseSubjectFromImportFiles, removeSubjectRows, scrubSubjectFromDiagnostics, type ErasureSubject } from "@/lib/importers/import-erasure";

const ADA: ErasureSubject = { memberId: "m_ada", sourceKey: "teamup:ada@example.test|ada obi", email: "Ada@Example.test", name: "Ada Obi" };

beforeEach(() => {
  h.files.clear();
  h.jobs = [];
  h.rewritten = [];
  h.updates = [];
});

describe("removeSubjectRows", () => {
  it("removes every row with the subject's email in any column, any case, and keeps every other byte", () => {
    const csv = "﻿Name,Email,Phone\r\nAda Obi,ada@example.test,07700 900111\r\nBen Ray,ben@example.test,07700 900222\r\n\"Obi, Ada\",ADA@EXAMPLE.TEST ,07700\r\nCara Lee,cara@example.test,\r\n";
    const r = removeSubjectRows(csv, ADA);
    expect(r.removed).toBe(2);
    expect(r.text).toBe("﻿Name,Email,Phone\r\nBen Ray,ben@example.test,07700 900222\r\nCara Lee,cara@example.test,\r\n");
    expect(r.text.toLowerCase()).not.toContain("ada");
  });

  it("matches the source record key as a cell, and handles a quoted field with a line break", () => {
    const csv = 'Key,Notes\nteamup:ada@example.test|ada obi,"line one\nline two"\nother-key,"kept\nkept too"\n';
    const r = removeSubjectRows(csv, { email: null, sourceKey: ADA.sourceKey });
    expect(r.removed).toBe(1);
    expect(r.text).toBe('Key,Notes\nother-key,"kept\nkept too"\n');
  });

  it("never removes the header, and returns the text untouched when nothing names the subject", () => {
    const csv = "ada@example.test,Name\nBen,ben@example.test";
    expect(removeSubjectRows(csv, ADA)).toEqual({ text: csv, removed: 0 });
    expect(removeSubjectRows("Name,Email\nBen,ben@example.test", { email: null, sourceKey: null }).removed).toBe(0);
  });

  it("does not match an address that only contains the subject's (a cell must be the address)", () => {
    const csv = "Name,Email\nBen,notada@example.test\n";
    expect(removeSubjectRows(csv, ADA).removed).toBe(0);
  });

  it("splits records at line breaks outside quotes only", () => {
    expect(csvRecords('a,b\n"x\ny",z\n').map((r) => r.cells)).toEqual([["a", "b"], ["x\ny", "z"]]);
  });
});

describe("scrubSubjectFromDiagnostics", () => {
  it("removes entries naming the subject by id, source key, email inside a string, and by name alone", () => {
    const errorLog = [
      { row: 2, reason: "Duplicate email ada@example.test" },
      { row: 3, reason: "Missing plan" },
      { row: 4, name: "ada obi" },
      { row: 5, memberId: "m_ada" },
      { row: 6, sourceKey: "teamup:ada@example.test|ada obi" },
    ];
    const r = scrubSubjectFromDiagnostics(errorLog, ADA);
    expect(r.scrubbed).toBe(4);
    expect(r.value).toEqual([{ row: 3, reason: "Missing plan" }]);
  });

  it("removes name-only drafts from a stored preview and keeps everyone else's", () => {
    const dryRunSummary = { total: 3, drafts: [{ name: "Ada Obi", phone: "07700 900111" }, { name: "Ben Ray", email: "ben@example.test" }], unmatched: ["Ada Obi", "Cara Lee"] };
    const r = scrubSubjectFromDiagnostics(dryRunSummary, ADA);
    expect(r.scrubbed).toBe(2);
    expect(r.value).toEqual({ total: 3, drafts: [{ name: "Ben Ray", email: "ben@example.test" }], unmatched: ["Cara Lee"] });
    expect(JSON.stringify(r.value)).not.toMatch(/ada/i);
  });

  it("an empty name never matches everything", () => {
    const r = scrubSubjectFromDiagnostics([{ name: "" }, { name: "Ben" }], { ...ADA, name: "", email: null, sourceKey: null });
    expect(r.scrubbed).toBe(0);
  });
});

describe("eraseSubjectFromImportFiles", () => {
  it("rewrites only the club's files that name the subject, and repoints a job whose Blob file got a new address", async () => {
    h.jobs = [
      { id: "j1", tenantId: "t1", fileBlobUrl: "db-upload://up1" },
      { id: "j2", tenantId: "t1", fileBlobUrl: "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv" },
      { id: "j3", tenantId: "t1", fileBlobUrl: "db-upload://up3" },
      { id: "j4", tenantId: "t2", fileBlobUrl: "db-upload://other" },
    ];
    h.files.set("db-upload://up1", "Name,Email\nAda Obi,ada@example.test\nBen,ben@example.test\n");
    h.files.set("https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv", "Email\nada@example.test\nada@example.test\n");
    h.files.set("db-upload://up3", "Name,Email\nBen,ben@example.test\n");
    h.files.set("db-upload://other", "Email\nada@example.test\n");

    const out = await eraseSubjectFromImportFiles("t1", ADA);
    expect(out).toEqual({ files: 2, rows: 3 });
    expect(h.rewritten.map((r) => r.url).sort()).toEqual(["db-upload://up1", "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv"]);
    for (const r of h.rewritten) expect(r.text).not.toMatch(/ada@example/i);
    // The Blob file was written anew, so its job now points at the new address.
    expect(h.updates).toEqual([{ where: { tenantId: "t1", id: { in: ["j2"] }, fileBlobUrl: "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv" }, data: { fileBlobUrl: "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv-v2" } }]);
  });

  it("a rewrite failure is thrown, so the erasure refuses rather than reporting success", async () => {
    h.jobs = [{ id: "j1", tenantId: "t1", fileBlobUrl: "db-upload://up1" }];
    h.files.set("db-upload://up1", "Email\nada@example.test\n");
    const storage = await import("@/lib/import-storage");
    vi.mocked(storage.rewriteImportFile).mockRejectedValueOnce(new Error("store down"));
    await expect(eraseSubjectFromImportFiles("t1", ADA)).rejects.toThrow("store down");
  });

  it("does nothing for a subject with no address and no source key", async () => {
    h.jobs = [{ id: "j1", tenantId: "t1", fileBlobUrl: "db-upload://up1" }];
    h.files.set("db-upload://up1", "Name\nAda Obi\n");
    expect(await eraseSubjectFromImportFiles("t1", { ...ADA, email: null, sourceKey: null })).toEqual({ files: 0, rows: 0 });
    expect(h.rewritten).toEqual([]);
  });
});
