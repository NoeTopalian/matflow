/**
 * A member's erasure reaches the kept import data (lib/importers/import-erasure.ts, 6 Nov 2026).
 * Pure parts against literal CSV (real TeamUp headers) and JSON; the file walk against mocked storage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  jobs: [] as Array<{ tenantId: string; fileBlobUrl: string }>,
  uploads: [] as Array<{ tenantId: string; id: string; status?: string; expiresAt?: Date }>,
  rewritten: [] as Array<{ url: string; text: string }>,
  uploadReads: [] as string[][],
}));

vi.mock("@/lib/import-storage", () => ({
  DB_UPLOAD_PREFIX: "db-upload://",
  readImportFileBytes: vi.fn(async (url: string) => h.files.get(url) ?? null),
  // Chunked uploads are read set-based (7 Nov 2026): one call per batch of ids.
  readUploadBytesMany: vi.fn(async (_tenantId: string, ids: string[]) => {
    h.uploadReads.push([...ids]);
    return new Map(ids.flatMap((id) => (h.files.has(`db-upload://${id}`) ? [[id, h.files.get(`db-upload://${id}`)!] as const] : [])));
  }),
  rewriteImportFile: vi.fn(async (url: string, _tenantId: string, bytes: Uint8Array) => {
    h.rewritten.push({ url, text: Buffer.from(bytes).toString("utf8") });
  }),
}));

import { csvRecords, decodeImportBytes, eraseSubjectsFromImportDiagnostics, eraseSubjectsFromImportFiles, importFileUrls, isSubjectsOwnAddress, removeSubjectRows, scrubSubjectFromDiagnostics, scrubSubjectFromManifest, type ErasureSubject } from "@/lib/importers/import-erasure";

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

/** The club's files (as the erase route lists them) walked for one subject. */
const walk = (subject: ErasureSubject, progress?: { files: number; rows: number; cells: number; nameOnly?: number }) =>
  eraseSubjectsFromImportFiles(
    "t1",
    [subject],
    importFileUrls(
      h.jobs.filter((j) => j.tenantId === "t1"),
      h.uploads.filter((u) => u.tenantId === "t1").map((u) => ({ status: "complete", expiresAt: new Date(0), ...u })),
    ),
    progress,
  );

beforeEach(() => {
  h.files.clear();
  h.jobs = [];
  h.uploads = [];
  h.rewritten = [];
  h.uploadReads = [];
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
    expect(r).toMatchObject({ removed: 1, blanked: 0, nameOnly: 0 });
    expect(r.text).toContain("Ada Obi,ada@example.test,07700 900111,Tom Obi,Adult");
    expect(r.text).not.toContain("Zara Obi");
  });

  it("an address changed since the import is still matched through the source key", () => {
    expect(removeSubjectRows(csv, { ...ADA, email: "ada.new@example.test" }).removed).toBe(1);
  });

  it("an address changed since the import, with no source key, is matched through the recorded digest of the old address", () => {
    const digest = (a: string) => `d:${a.trim().toLowerCase()}`;
    const moved: ErasureSubject = { memberId: "m_ada", sourceKey: null, email: "ada.new@example.test", name: "Ada Obi", pastAddressDigests: [digest("ada.old@example.test")], addressDigest: digest };
    const file = "Name,Email,Payer\nAda Obi,ada.old@example.test,\nBen Ray,ben@example.test,ADA.OLD@example.test\n";
    const r = removeSubjectRows(file, moved);
    expect(r).toMatchObject({ removed: 1, blanked: 1 });
    expect(r.text).toBe("Name,Email,Payer\nBen Ray,ben@example.test,\n");
    expect(scrubSubjectFromDiagnostics([{ row: 2, reason: "Duplicate email ada.old@example.test" }], moved).value).toEqual([]);
  });

  it("a name changed since the import is matched through the recorded earlier name, with the old address", () => {
    const digest = (a: string) => `d:${a.trim().toLowerCase()}`;
    const renamed: ErasureSubject = { memberId: "m_ada", sourceKey: null, email: "ada.new@example.test", name: "Ada Obi-Hart", pastNames: ["Ada Obi"], pastAddressDigests: [digest("ada.old@example.test")], addressDigest: digest };
    expect(removeSubjectRows("Name,Email\nAda Obi,ada.old@example.test\nBen Ray,ben@example.test\n", renamed)).toMatchObject({ removed: 1, text: "Name,Email\nBen Ray,ben@example.test\n" });
  });

  it("a junior first recorded under the parent's address: that address marks the junior's own row only, never blanked or treated as theirs", () => {
    const digest = (a: string) => `d:${a.trim().toLowerCase()}`;
    // The parent still holds parent@example.test, so the route passes its digest as SHARED, not own.
    const junior: ErasureSubject = { memberId: "m_jo", sourceKey: null, email: "jo@example.test", name: "Jo Obi", pastSharedAddressDigests: [digest("parent@example.test")], addressDigest: digest };
    const file = "Name,Email,Payer\nJo Obi,parent@example.test,\nPat Obi,parent@example.test,\nZed Ray,zed@example.test,parent@example.test\n";
    const r = removeSubjectRows(file, junior);
    expect(r).toEqual({ removed: 1, blanked: 0, nameOnly: 0, text: "Name,Email,Payer\nPat Obi,parent@example.test,\nZed Ray,zed@example.test,parent@example.test\n" });
    // The parent's diagnostics entries stay: the address is not the junior's alone.
    const diag = [{ row: 3, reason: "Duplicate email parent@example.test" }];
    expect(scrubSubjectFromDiagnostics(diag, junior).value).toEqual(diag);
    expect(isSubjectsOwnAddress(junior, "parent@example.test")).toBe(false);
    // Held by nobody else, the same earlier address IS theirs alone.
    const own: ErasureSubject = { ...junior, pastSharedAddressDigests: [], pastAddressDigests: [digest("parent@example.test")] };
    expect(isSubjectsOwnAddress(own, "Parent@Example.test")).toBe(true);
    expect(removeSubjectRows(file, own).text).toBe("Name,Email,Payer\nPat Obi,,\nZed Ray,zed@example.test,\n");
  });

  it("isSubjectsOwnAddress: the current address counts, another member's does not", () => {
    expect(isSubjectsOwnAddress(ADA, "ADA@example.test")).toBe(true);
    expect(isSubjectsOwnAddress(ADA, "ben@example.test")).toBe(false);
  });

  it("reports a row with the subject's name at another address instead of skipping it silently", () => {
    expect(removeSubjectRows(csv, ADA).nameOnly).toBe(1); // "Ada Obi,other-ada@example.test"
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
    expect(removeSubjectRows(text, ADA)).toEqual({ text, removed: 0, blanked: 0, nameOnly: 0 });
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

  it("a child's entry holding the parent's address has the address blanked, not the entry removed", () => {
    const exceptions = [{ kind: "guardian_suggested", childName: "Zara Obi", detail: "ada@example.test" }];
    expect(scrubSubjectFromDiagnostics(exceptions, ADA).value).toEqual([{ kind: "guardian_suggested", childName: "Zara Obi", detail: "" }]);
  });

  it("a refused row labelled 'Row 12' is the subject's when its detail names them", () => {
    const rows = [{ kind: "refused_row", name: "Row 12", detail: "Zara Obi: a child under 13 needs a parent" }, { kind: "refused_row", name: "Row 13", detail: "Missing name" }];
    expect(scrubSubjectFromDiagnostics(rows, KID).value).toEqual([{ kind: "refused_row", name: "Row 13", detail: "Missing name" }]);
  });

  it("in a child's guardian suggestion, the parent's name in the detail is blanked and the child's entry kept", () => {
    const rows = [{ kind: "guardian_suggested", name: "Zara Obi", email: null, detail: "Ada Obi (shared email)" }];
    expect(scrubSubjectFromDiagnostics(rows, ADA).value).toEqual([{ kind: "guardian_suggested", name: "Zara Obi", email: null, detail: "" }]);
  });

  it("a className or fileName field does not make the subject's own entry someone else's", () => {
    expect(scrubSubjectFromDiagnostics([{ name: "Ada Obi", className: "Adults Gi", fileName: "members.csv" }], ADA).value).toEqual([]);
  });

  it("matches the '<name> (…' form a guardian suggestion writes", () => {
    expect(scrubSubjectFromDiagnostics(["Ada Obi (shared email)", "Ada Obinna (shared email)"], ADA).value).toEqual(["Ada Obinna (shared email)"]);
  });

  it("a shared unverified address (another member's login) finds the subject's rows but is never blanked", () => {
    // The second adult at a TeamUp address keeps the first adult's login as their unverified address.
    const second: ErasureSubject = { memberId: "m_tom", sourceKey: "teamup:ada@example.test|tom obi", email: null, unverifiedEmail: "ada@example.test", unverifiedEmailShared: true, name: "Tom Obi" };
    const file = "Customer Name,Customer Email\r\nAda Obi,ada@example.test\r\nTom Obi,ada@example.test\r\n";
    expect(removeSubjectRows(file, second)).toEqual({ text: "Customer Name,Customer Email\r\nAda Obi,ada@example.test\r\n", removed: 1, blanked: 0, nameOnly: 0 });
    expect(scrubSubjectFromDiagnostics([{ name: "Ada Obi", email: "ada@example.test" }], second).scrubbed).toBe(0);
  });

  it("with no recognised name column, a same-named cell in another person's row is not blanked", () => {
    expect(removeSubjectRows("Who,Contact\nAda Obi,ben@example.test\n", ADA)).toMatchObject({ removed: 0, blanked: 0 });
  });

  it("matches the 'of <name>' form", () => {
    expect(scrubSubjectFromDiagnostics(["Parent/guardian of Zara Obi", "Parent/guardian of Zara Obinna"], KID).value).toEqual(["Parent/guardian of Zara Obinna"]);
  });
});

describe("eraseSubjectsFromImportFiles", () => {
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

    const out = await walk(ADA);
    expect(out).toMatchObject({ files: 3, rows: 3 });
    expect(h.rewritten.map((r) => r.url).sort()).toEqual(["db-upload://stray", "db-upload://up1", "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv"]);
    for (const r of h.rewritten) expect(r.text.toLowerCase()).not.toMatch(/(^|,)ada@example\.test/m);
  });

  it("skips an upload still arriving in chunks; an abandoned (expired) one is rewritten", async () => {
    h.uploads = [
      { tenantId: "t1", id: "arriving", status: "open", expiresAt: new Date(Date.now() + 3_600_000) },
      { tenantId: "t1", id: "abandoned", status: "open", expiresAt: new Date(Date.now() - 3_600_000) },
    ];
    for (const id of ["arriving", "abandoned"]) h.files.set(`db-upload://${id}`, Buffer.from("Name,Email\nAda Obi,ada@example.test\n", "utf8"));
    expect(await walk(ADA)).toMatchObject({ files: 1, rows: 1 });
    expect(h.rewritten.map((r) => r.url)).toEqual(["db-upload://abandoned"]);
  });

  it("reports progress as it goes, so the files already rewritten are known when a later one fails", async () => {
    h.uploads = [{ tenantId: "t1", id: "a" }, { tenantId: "t1", id: "b" }];
    for (const id of ["a", "b"]) h.files.set(`db-upload://${id}`, Buffer.from("Name,Email\nAda Obi,ada@example.test\n", "utf8"));
    const storage = await import("@/lib/import-storage");
    vi.mocked(storage.rewriteImportFile).mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("store down"));
    const progress = { files: 0, rows: 0, cells: 0 };
    await expect(walk(ADA, progress)).rejects.toThrow("store down");
    expect(progress).toEqual({ files: 1, rows: 1, cells: 0, nameOnly: 0 });
  });

  it("several subjects (a guardian and a child erased together): each file is read once and rewritten once, chunked uploads in one read", async () => {
    h.uploads = [{ tenantId: "t1", id: "a" }, { tenantId: "t1", id: "b" }];
    h.files.set("db-upload://a", Buffer.from(csv, "utf8"));
    h.files.set("db-upload://b", Buffer.from("Name,Email\nBen Ray,ben@example.test\n", "utf8"));
    // Children before their guardian (the route's order): her pass blanks her address in Zara's row, which is how
    // Zara's own pass recognises it.
    const out = await eraseSubjectsFromImportFiles("t1", [KID, ADA], importFileUrls([], [{ id: "a", status: "complete", expiresAt: new Date(0) }, { id: "b", status: "complete", expiresAt: new Date(0) }]));
    expect(h.uploadReads).toEqual([["a", "b"]]);
    expect(h.rewritten.map((r) => r.url)).toEqual(["db-upload://a"]);
    // Both of them are out of the one rewrite: Ada's own row and Zara's.
    expect(h.rewritten[0].text).not.toMatch(/^Ada Obi,ada@example\.test/m);
    expect(h.rewritten[0].text).not.toMatch(/^Zara Obi,/m);
    expect(h.rewritten[0].text).toMatch(/^Ben Ray,ben@example\.test/m);
    expect(out).toMatchObject({ files: 1, rows: 2 });
  });

  it("diagnostics for several subjects: the caller's jobs are used (no read), and each changed job is written once", async () => {
    const jobs = [
      { id: "j1", errorLog: [{ row: 2, reason: "Duplicate email ada@example.test" }, { row: 3, reason: "Zara Obi: missing date of birth" }, { row: 4, reason: "Missing plan" }], dryRunSummary: null, manifest: null },
      { id: "j2", errorLog: [{ row: 2, reason: "Missing plan" }], dryRunSummary: null, manifest: null },
    ];
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn(async () => jobs);
    const tx = { importJob: { findMany, updateMany } };
    expect(await eraseSubjectsFromImportDiagnostics(tx as never, "t1", [KID, ADA], { dryRun: true, jobs })).toBe(2);
    expect(findMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(await eraseSubjectsFromImportDiagnostics(tx as never, "t1", [KID, ADA])).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({ where: { id: "j1", tenantId: "t1" }, data: { errorLog: [{ row: 4, reason: "Missing plan" }] } });
  });

  it("a rewrite failure is thrown, so the erasure refuses rather than reporting success", async () => {
    h.jobs = [{ tenantId: "t1", fileBlobUrl: "db-upload://up1" }];
    h.files.set("db-upload://up1", Buffer.from("Name,Email\nAda Obi,ada@example.test\n", "utf8"));
    const storage = await import("@/lib/import-storage");
    vi.mocked(storage.rewriteImportFile).mockRejectedValueOnce(new Error("store down"));
    await expect(walk(ADA)).rejects.toThrow("store down");
  });
});

// Round 5 review L-4: the manifest is scrubbed by name and address in its PERSON lists only. A plan named after the
// subject must survive in the structure (counts, plan maps, a pre-rule refresh's before/after that a rollback replays).
describe("scrubSubjectFromManifest — person lists only", () => {
  const PLAN = "Ada Obi (Privates)"; // a plan named after the coach being erased
  const commit = {
    created: { total: 2, byPlan: { [PLAN]: 1, Adult: 1 } },
    teamup2: {
      asOf: "2026-11-01",
      ledger: { rows: 4, byDisposition: { live: 4 } },
      exceptions: { refusedRows: 1, unmatchedPlanLabels: [PLAN] },
      exceptionRows: [
        { kind: "cancelled_without_date", name: "Ada Obi", email: "ada@example.test", action: "a", detail: "Adult", sourceRows: [2] },
        { kind: "guardian_suggested", name: "Zed Ray", email: null, action: "a", detail: "Ada Obi (shared email)", sourceRows: [3] },
        { kind: "shared_email_adult", name: "Ben Ray", email: "ben@example.test", action: "a", detail: "Shares ben@example.test", sourceRows: [4] },
      ],
      decisions: [{ name: "Ada Obi", sourceKey: "k1", kind: "x", options: ["A"], rows: [2] }, { name: "Ben Ray", sourceKey: "k2", kind: "x", options: ["A", "B"], rows: [4] }],
      scheduled: [],
    },
  };
  const refresh = {
    mode: "refresh",
    refresh: {
      changes: [{ memberId: "m_ben", name: "Ben Ray", before: { status: "active", membershipType: PLAN }, after: { status: "cancelled", membershipType: PLAN } }],
      exceptions: { notInMatFlow: [{ name: "Ada Obi", email: "ada@example.test", sourceKey: "k1", rows: [2] }, { name: "Ben Ray", email: null, sourceKey: "k2", rows: [4] }], refused: [] },
    },
    rollback: { kind: "refresh", kept: [{ memberId: "m_ben", name: "Ben Ray", reasons: ["plan changed since this refresh"] }] },
  };

  it("a commit manifest: her rows leave the person lists; the structure, plan labels and other people stay exactly", () => {
    const { value, scrubbed } = scrubSubjectFromManifest(commit, ADA);
    expect(scrubbed).toBeGreaterThanOrEqual(3);
    const v = value as typeof commit;
    expect(JSON.stringify(v.teamup2.exceptionRows)).not.toContain("ada@example.test");
    expect(v.teamup2.exceptionRows.map((r) => r.name)).toEqual(["Zed Ray", "Ben Ray"]);
    expect(v.teamup2.exceptionRows[0].detail).toBe(""); // her name blanked from the child's row
    expect(v.teamup2.decisions.map((d) => d.name)).toEqual(["Ben Ray"]);
    expect({ ...v, teamup2: { ...v.teamup2, exceptionRows: [], decisions: [] } }).toEqual({ ...commit, teamup2: { ...commit.teamup2, exceptionRows: [], decisions: [] } });
  });

  it("a refresh manifest: a change's before/after carrying a plan named after her is untouched, so the rollback still replays it", () => {
    const { value } = scrubSubjectFromManifest(refresh, ADA);
    const v = value as typeof refresh;
    expect(v.refresh.changes).toEqual(refresh.refresh.changes);
    expect(v.rollback).toEqual(refresh.rollback);
    expect(v.refresh.exceptions.notInMatFlow.map((e) => e.name)).toEqual(["Ben Ray"]);
  });

  it("the review list: her ambiguous entry (no member id) is reduced to its kind; in another member's entry her name is blanked from a compared value, which stays", () => {
    const manifest = {
      conflicts: [
        { kind: "ambiguous", memberIds: [], name: "Ada Obi", sourceKey: "teamup:ada@example.test|ada obi", rows: [2], reason: "Two rows share ada@example.test with different details" },
        { kind: "conflict", memberId: "m_ben", name: "Ben Ray", sourceKey: null, rows: [4], fields: [{ field: "emergencyContactName", upload: "Ada Obi", matflow: "Tom Ray" }, { field: "phone", upload: "07700 900222", matflow: null }] },
      ],
    };
    const { value } = scrubSubjectFromManifest(manifest, ADA);
    const v = value as typeof manifest;
    expect(v.conflicts).toHaveLength(2); // the counts still add up
    expect(v.conflicts[0]).toEqual({ kind: "ambiguous" });
    expect(v.conflicts[1]).toEqual({ ...manifest.conflicts[1], fields: [{ field: "emergencyContactName", upload: "", matflow: "Tom Ray" }, manifest.conflicts[1].fields![1]] });
    expect(JSON.stringify(v)).not.toContain("Ada Obi");
    expect(JSON.stringify(v)).not.toContain("ada@example.test");
  });

  it("the input is not mutated", () => {
    const before = JSON.stringify(commit);
    scrubSubjectFromManifest(commit, ADA);
    expect(JSON.stringify(commit)).toBe(before);
  });
});

