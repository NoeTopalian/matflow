/**
 * A member's erasure reaches the import data MatFlow now keeps (6 Nov 2026).
 *
 * Since "nothing should be automatically deleted" (Noe, 6 Nov 2026), an
 * uploaded import file stays with its ImportJob and the job's diagnostics
 * (`errorLog`, `dryRunSummary`) are no longer scrubbed after 30 days. Both can
 * carry a member's CSV row — name, email, phone, date of birth — so an erasure
 * (a deliberate action, app/api/admin/dsar/erase) must remove the subject from
 * them, or the "erased" member survives in the files.
 *
 *  - Files: every stored import file of the club is rewritten without the rows
 *    that name the subject: a cell equal to their email (any case) or to their
 *    source record key (Member.externalRef). Every other byte of the file is
 *    kept as it was, header included.
 *  - Diagnostics: every entry of `errorLog` and `dryRunSummary`, in members AND
 *    attendance jobs, that names the subject is removed — by id, by source key,
 *    by email (a string containing it), and by name alone (an exact match, any
 *    case). lib/importers/import-conflicts-scrub.ts deliberately keeps
 *    name-only entries for an ordinary deletion; an erasure does not.
 *
 * Counts only leave this module; never a value from a file.
 */
import type { Prisma } from "@prisma/client";
import { readImportFile, rewriteImportFile } from "@/lib/import-storage";
import { withTenantContext } from "@/lib/prisma-tenant";

export type ErasureSubject = {
  memberId: string;
  /** Member.externalRef before the erasure nulls it. */
  sourceKey: string | null;
  /** The address before the erasure; null when it identifies nobody (a synthesised placeholder). */
  email: string | null;
  /** The name before the erasure. */
  name: string | null;
};

// ─── CSV, byte-preserving ────────────────────────────────────────────────────

type CsvRecord = { start: number; end: number; cells: string[] };

/**
 * Each record of a CSV text with its span (end includes its line break), quoted
 * fields and embedded line breaks handled as lib/importers parseCSV does.
 */
export function csvRecords(text: string): CsvRecord[] {
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { cells.push(cur); cur = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") {
      cells.push(cur);
      out.push({ start, end: i + 1, cells });
      cells = [];
      cur = "";
      start = i + 1;
      continue;
    }
    cur += ch;
  }
  if (cur !== "" || cells.length > 0) {
    cells.push(cur);
    out.push({ start, end: text.length, cells });
  }
  return out;
}

const norm = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase();

/** The text without the rows naming the subject (the first non-empty record, the header, always stays). */
export function removeSubjectRows(text: string, subject: Pick<ErasureSubject, "email" | "sourceKey">): { text: string; removed: number } {
  const needles = new Set([subject.email, subject.sourceKey].filter((v): v is string => !!v && v.trim() !== "").map(norm));
  if (needles.size === 0) return { text, removed: 0 };
  const records = csvRecords(text);
  const header = records.findIndex((r) => r.cells.some((c) => c.trim() !== ""));
  let removed = 0;
  let out = "";
  let at = 0;
  records.forEach((r, i) => {
    if (i <= header) return;
    if (!r.cells.some((c) => needles.has(norm(c)))) return;
    out += text.slice(at, r.start);
    at = r.end;
    removed += 1;
  });
  if (removed === 0) return { text, removed: 0 };
  return { text: out + text.slice(at), removed };
}

// ─── Diagnostics (errorLog, dryRunSummary) ───────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringNames(s: string, subject: ErasureSubject): boolean {
  const v = s.trim().toLowerCase();
  if (!v) return false;
  if (v === subject.memberId.toLowerCase()) return true;
  if (subject.sourceKey && v === subject.sourceKey.trim().toLowerCase()) return true;
  if (subject.email && v.includes(subject.email.trim().toLowerCase())) return true;
  return !!subject.name && subject.name.trim() !== "" && v === subject.name.trim().toLowerCase();
}

function entryNames(entry: Record<string, unknown>, subject: ErasureSubject): boolean {
  if (entry.memberId === subject.memberId) return true;
  if (Array.isArray(entry.memberIds) && entry.memberIds.includes(subject.memberId)) return true;
  return Object.values(entry).some((v) => typeof v === "string" && stringNames(v, subject));
}

function scrub(value: unknown, subject: ErasureSubject): { value: unknown; n: number } {
  if (Array.isArray(value)) {
    let n = 0;
    const out: unknown[] = [];
    for (const el of value) {
      if ((typeof el === "string" && stringNames(el, subject)) || (isObject(el) && entryNames(el, subject))) {
        n += 1;
        continue;
      }
      const r = scrub(el, subject);
      n += r.n;
      out.push(r.value);
    }
    return { value: out, n };
  }
  if (isObject(value)) {
    if (entryNames(value, subject)) return { value: { removed: true }, n: 1 };
    let n = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = scrub(v, subject);
      n += r.n;
      out[k] = r.value;
    }
    return { value: out, n };
  }
  if (typeof value === "string" && stringNames(value, subject)) return { value: "", n: 1 };
  return { value, n: 0 };
}

/** Pure: one stored diagnostics value with every entry naming the subject removed. */
export function scrubSubjectFromDiagnostics(value: unknown, subject: ErasureSubject): { value: unknown; scrubbed: number } {
  const r = scrub(value, subject);
  return { value: r.value, scrubbed: r.n };
}

type DiagTx = Pick<Prisma.TransactionClient, "importJob">;

/**
 * Remove the subject from every job's `errorLog` and `dryRunSummary` in this
 * club. `dryRun` counts without writing (the erasure's fulfilment record is
 * written before the scrub, in the same transaction).
 */
export async function eraseSubjectFromImportDiagnostics(tx: DiagTx, tenantId: string, subject: ErasureSubject, opts: { dryRun?: boolean } = {}): Promise<number> {
  const jobs = await tx.importJob.findMany({ where: { tenantId }, select: { id: true, errorLog: true, dryRunSummary: true } });
  let scrubbed = 0;
  for (const job of jobs) {
    const data: { errorLog?: Prisma.InputJsonValue; dryRunSummary?: Prisma.InputJsonValue } = {};
    for (const field of ["errorLog", "dryRunSummary"] as const) {
      const stored = job[field];
      if (!stored || typeof stored !== "object") continue;
      const r = scrubSubjectFromDiagnostics(stored, subject);
      if (r.scrubbed === 0) continue;
      scrubbed += r.scrubbed;
      data[field] = r.value as Prisma.InputJsonValue;
    }
    if (opts.dryRun || Object.keys(data).length === 0) continue;
    await tx.importJob.updateMany({ where: { id: job.id, tenantId }, data });
  }
  return scrubbed;
}

// ─── Files ───────────────────────────────────────────────────────────────────

/**
 * Rewrite every stored import file of this club without the subject's rows.
 * Runs outside any transaction (a file store call is a network call). Throws if
 * a file that names the subject cannot be rewritten: the erasure must not
 * report success while the rows survive.
 */
export async function eraseSubjectFromImportFiles(tenantId: string, subject: ErasureSubject): Promise<{ files: number; rows: number }> {
  if (!subject.email && !subject.sourceKey) return { files: 0, rows: 0 };
  const jobs = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findMany({ where: { tenantId, NOT: { fileBlobUrl: "" } }, select: { id: true, fileBlobUrl: true } }),
  );
  const byUrl = new Map<string, string[]>();
  for (const j of jobs) byUrl.set(j.fileBlobUrl, [...(byUrl.get(j.fileBlobUrl) ?? []), j.id]);
  let files = 0;
  let rows = 0;
  for (const [url, jobIds] of byUrl) {
    const text = await readImportFile(url, tenantId);
    if (text === null) continue;
    const r = removeSubjectRows(text, subject);
    if (r.removed === 0) continue;
    const next = await rewriteImportFile(url, tenantId, r.text);
    if (next !== url) {
      await withTenantContext(tenantId, (tx) => tx.importJob.updateMany({ where: { tenantId, id: { in: jobIds }, fileBlobUrl: url }, data: { fileBlobUrl: next } }));
    }
    files += 1;
    rows += r.removed;
  }
  return { files, rows };
}
