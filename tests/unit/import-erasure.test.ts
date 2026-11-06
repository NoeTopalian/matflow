/**
 * A member's erasure reaches the kept import data (lib/importers/import-erasure.ts, 6 Nov 2026).
 * Pure parts against literal CSV (real TeamUp headers) and JSON; the file walk against mocked storage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  jobs: [] as Array<{ tenantId: string; fileBlobUrl: string }>,
  uploads: [] as Array<{ tenantId: string; id: string }>,
  rewritten: [] as Array<{ url: string; text: string }>,
}));

vi.mock("@/lib/import-storage", () => ({
  DB_UPLOAD_PREFIX: "db-upload://",
  readImportFileBytes: vi.fn(async (url: string) => h.files.get(url) ?? null),
  rewriteImportFile: vi.fn(async (url: string, _tenantId: string, bytes: Uint8Array) => {
    h.rewritten.push({ url, text: Buffer.from(bytes).toString("utf8") });
  }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) =>
    fn({
      importJob: { findMany: async ({ where }: { where: { tenantId: string } }) => h.jobs.filter((j) => j.tenantId === where.tenantId && j.fileBlobUrl !== "") },
      importUpload: { findMany: async ({ where }: { where: { tenantId: string } }) => h.uploads.filter((u) => u.tenantId === where.tenantId) },
    }),
}));

import { csvRecords, decodeImportBytes, eraseSubjectFromImportFiles, removeSubjectRows, scrubSubjectFromDiagnostics, type ErasureSubject } from "@/lib/importers/import-erasure";

const TEAMUP = "Customer Name,Customer Email,Phone,Emergency Contact Name,Membership";
// An adult whose own address is in the file, and her child, whose TeamUp row carries her address.
const ADA: ErasureSubject = { memberId: "m_ada", sourceKey: "teamup:ada@example.test|ada obi", email: "Ada@Example.test", name: "Ada Obi" };
const KID: ErasureSubject = { memberId: "m_kid", sourceKey: "teamup:ada@example.test|zara obi", email: null, name: "Zara Obi" };
const csv = [
  TEAMUP,
  "Ada Obi,ada@example.test,07700 900111,Tom Obi,Adult",
  "Zara Obi,ada@example.test,,Ada Obi,Kids",
  "Ben Ray,ben@example.test,07700 900222,Ada Obi,Adult",
  "Ada Obi,other-ada@example.test,07700 900999,,Adult",
  "",
].join("\r\n");

beforeEach(() => {
  h.files.clear();
  h.jobs = [];
  h.uploads = [];
  h.rewritten = [];
});

describe("removeSubjectRows — a row is the subject's only by name AND address", () => {
  it("erasing the parent removes her own row only; the child's row stays, with her address and name blanked", () => {
    const r = removeSubjectRows(csv, ADA);
    expect(r.removed).toBe(1);
    expect(r.text).toBe([
      TEAMUP,
      "Zara Obi,,,,Kids",
      "Ben Ray,ben@example.test,07700 900222,,Adult",
      // Another person called Ada Obi, at another address, is not the subject.
      "Ada Obi,other-ada@example.test,07700 900999,,Adult",
      "",
    ].join("\r\n"));
  });

  it("erasing the child removes the child's row only; the parent's row and address stay", () => {
    const r = removeSubjectRows(csv, KID);
    expect(r).toMatchObject({ removed: 1, blanked: 0 });
    expect(r.text).toContain("Ada Obi,ada@example.test,07700 900111,Tom Obi,Adult");
    expect(r.text).not.toContain("Zara Obi");
  });

  it("an address changed since the import is still matched through the source key", () => {
    expect(removeSubjectRows(csv, { ...ADA, email: "ada.new@example.test" }).removed).toBe(1);
  });

  it("a guardian draft (teamup-payer key, synthesised login) has its payer address blanked in the child's row", () => {
    const guardian: ErasureSubject = { memberId: "m_g", sourceKey: "teamup-payer:ada@example.test", email: null, unverifiedEmail: "ada@example.test", name: "Parent/guardian of Zara Obi" };
    const r = removeSubjectRows(csv, guardian);
    expect(r.removed).toBe(0);
    expect(r.text).toContain("Zara Obi,,,Ada Obi,Kids");
  });

  it("keeps a semicolon file's shape, quoted fields, line breaks inside quotes and the BOM", () => {
    const semi = '﻿Name;Email;Notes\nAda Obi;ada@example.test;"likes; commas\nand lines"\nBen Ray;ben@example.test;"x"\n';
    const r = removeSubjectRows(semi, ADA);
    expect(r.removed).toBe(1);
    expect(r.text).toBe('﻿Name;Email;Notes\nBen Ray;ben@example.test;"x"\n');
  });

  it("never touches the header, and returns the text unchanged when nothing names the subject", () => {
    const text = "Name,Email\nBen Ray,ben@example.test\n";
    expect(removeSubjectRows(text, ADA)).toEqual({ text, removed: 0, blanked: 0 });
  });

  it("splits records at line breaks outside quotes only", () => {
    expect(csvRecords('a,b\n"x\ny",z\n').map((r) => r.cells)).toEqual([["a", "b"], ["x\ny", "z"]]);
  });

  it("decodes Latin-1 bytes as Latin-1 and keeps a UTF-8 BOM, so a rewrite never mangles other members' rows", () => {
    const latin = Buffer.from("Name,Email\nZo\xe9 Lee,zoe@example.test\n", "latin1");
    expect(decodeImportBytes(latin)).toEqual({ encoding: "latin1", text: "Name,Email\nZoé Lee,zoe@example.test\n" });
    expect(decodeImportBytes(Buffer.from("﻿Name\n", "utf8"))).toEqual({ encoding: "utf8", text: "﻿Name\n" });
  });
});

describe("scrubSubjectFromDiagnostics", () => {
  it("removes the subject's entries by id, key, whole address and name forms; keeps everyone else's", () => {
    const errorLog = [
      { row: 2, reason: "Duplicate email ada@example.test" },
      { row: 3, reason: "Missing plan" },
      { row: 4, name: "ada obi" },
      { row: 5, memberId: "m_ada" },
      { row: 6, sourceKey: "teamup:ada@example.test|ada obi" },
      { row: 7, reason: "Ada Obi: a child under 13 needs a parent" },
      { row: 8, reason: "Duplicate email bojo-ada@example.test" },
    ];
    const r = scrubSubjectFromDiagnostics(errorLog, ADA);
    expect(r.value).toEqual([{ row: 3, reason: "Missing plan" }, { row: 8, reason: "Duplicate email bojo-ada@example.test" }]);
    expect(r.scrubbed).toBe(5);
  });

  it("in another person's entry, blanks the subject's address and keeps the entry", () => {
    const summary = { drafts: [{ name: "Zara Obi", email: "ada@example.test", sourceKey: "teamup:ada@example.test|zara obi" }, { name: "Ada Obi", phone: "07700 900111" }] };
    expect(scrubSubjectFromDiagnostics(summary, ADA).value).toEqual({ drafts: [{ name: "Zara Obi", email: "", sourceKey: "teamup:ada@example.test|zara obi" }] });
  });

  it("does not remove another person of the same name who carries their own identifier", () => {
    const entries = [{ name: "Ada Obi", email: "other-ada@example.test" }, { name: "Ada Obi", memberId: "m_other" }];
    expect(scrubSubjectFromDiagnostics(entries, ADA)).toEqual({ value: entries, scrubbed: 0 });
  });

  it("matches the 'of <name>' form", () => {
    expect(scrubSubjectFromDiagnostics(["Parent/guardian of Zara Obi", "Parent/guardian of Zara Obinna"], KID).value).toEqual(["Parent/guardian of Zara Obinna"]);
  });
});

describe("eraseSubjectFromImportFiles", () => {
  it("rewrites every file of the club that names the subject — job files and never-used uploads — in place", async () => {
    h.jobs = [
      { tenantId: "t1", fileBlobUrl: "db-upload://up1" },
      { tenantId: "t1", fileBlobUrl: "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv" },
      { tenantId: "t2", fileBlobUrl: "db-upload://other" },
    ];
    h.uploads = [{ tenantId: "t1", id: "up1" }, { tenantId: "t1", id: "stray" }, { tenantId: "t1", id: "clean" }];
    h.files.set("db-upload://up1", Buffer.from(csv, "utf8"));
    h.files.set("https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv", Buffer.from("Name,Email\nAda Obi,ada@example.test\n", "utf8"));
    h.files.set("db-upload://stray", Buffer.from("Name,Email\nAda Obi,ada@example.test\n", "utf8"));
    h.files.set("db-upload://clean", Buffer.from("Name,Email\nBen Ray,ben@example.test\n", "utf8"));
    h.files.set("db-upload://other", Buffer.from(csv, "utf8"));

    const out = await eraseSubjectFromImportFiles("t1", ADA);
    expect(out).toMatchObject({ files: 3, rows: 3 });
    expect(h.rewritten.map((r) => r.url).sort()).toEqual(["db-upload://stray", "db-upload://up1", "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv"]);
    for (const r of h.rewritten) expect(r.text.toLowerCase()).not.toMatch(/(^|,)ada@example\.test/m);
  });

  it("a rewrite failure is thrown, so the erasure refuses rather than reporting success", async () => {
    h.jobs = [{ tenantId: "t1", fileBlobUrl: "db-upload://up1" }];
    h.files.set("db-upload://up1", Buffer.from("Name,Email\nAda Obi,ada@example.test\n", "utf8"));
    const storage = await import("@/lib/import-storage");
    vi.mocked(storage.rewriteImportFile).mockRejectedValueOnce(new Error("store down"));
    await expect(eraseSubjectFromImportFiles("t1", ADA)).rejects.toThrow("store down");
  });
});
