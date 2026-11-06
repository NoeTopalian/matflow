/**
 * A member's erasure reaches the import data MatFlow now keeps (6 Nov 2026).
 *
 * Since "nothing should be automatically deleted" (Noe, 6 Nov 2026), an
 * uploaded import file stays with its ImportJob (or as an upload never used)
 * and the job's diagnostics (`errorLog`, `dryRunSummary`) are no longer
 * scrubbed after 30 days. Both can carry a member's CSV row — name, email,
 * phone, date of birth — so an erasure (a deliberate action,
 * app/api/admin/dsar/erase) must take the subject out of them.
 *
 * Who the subject is, in import terms: their name, their own addresses (the
 * login address unless it is a synthesised placeholder, and an unverified
 * address), and their source record key (Member.externalRef), which for a
 * TeamUp import is `teamup:<email>|<name>` (the email may be a PARENT's: a
 * child's TeamUp row carries the payer's address) or `teamup-payer:<email>`.
 *
 *  - Files: a row is the subject's when its name column is one of their names
 *    AND its email column is one of their addresses (their own, or the one in
 *    their source key). That row is removed. In anyone else's row, a cell that
 *    holds the subject's OWN address, or their name outside the row's name
 *    column (an emergency contact, a payer), is blanked — never a row that is
 *    another person's, and never a parent's address when a child is erased.
 *    Every other byte of the file is kept; the file keeps its encoding.
 *  - Diagnostics: an entry that is the subject's (their id, their key, or
 *    their name or address with no other person's identifier in it) is
 *    removed; in another person's entry, a field holding the subject's address
 *    is blanked. Names are matched whole, as `<name>: …`, `<name> (…` and
 *    `… of <name>`. An entry is another person's when it carries their
 *    address, key, member id, or a name field that is not the subject's.
 *    Residual, accepted: an entry for a DIFFERENT person of the same name
 *    that carries no address, key or id of its own cannot be told apart from
 *    the subject's, and is removed with theirs.
 *  - An unverified address is the subject's own only when no other member of
 *    the club holds it (`unverifiedEmailShared`); a shared one — the second
 *    adult at a TeamUp address keeps the first adult's login there — only
 *    helps find the subject's rows and is never blanked.
 *  - A chunked upload still arriving (open and not yet expired) is skipped.
 *
 * Counts only leave this module; never a value from a file.
 */
import type { Prisma } from "@prisma/client";
import { DB_UPLOAD_PREFIX, readImportFileBytes, rewriteImportFile } from "@/lib/import-storage";
import { withTenantContext } from "@/lib/prisma-tenant";

export type ErasureSubject = {
  memberId: string;
  /** Member.externalRef before the erasure nulls it. */
  sourceKey: string | null;
  /** The login address before the erasure; null when it identifies nobody (a synthesised placeholder). */
  email: string | null;
  /** Member.unverifiedEmail before the erasure. */
  unverifiedEmail?: string | null;
  /** True when another member of the club holds `unverifiedEmail` as their email or unverified address. */
  unverifiedEmailShared?: boolean;
  /** The name before the erasure. */
  name: string | null;
};

const norm = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase();
const nonEmpty = (v: string | null | undefined): v is string => !!v && v.trim() !== "";

type Who = {
  memberId: string;
  /** Exact keys that are the subject's. */
  keys: Set<string>;
  /** The subject's own addresses: blanked wherever they appear. */
  ownAddresses: Set<string>;
  /** Addresses that, WITH a matching name, make a row the subject's (own + the source key's). */
  rowAddresses: Set<string>;
  names: Set<string>;
};

function who(subject: ErasureSubject): Who {
  const keys = new Set<string>();
  const ownAddresses = new Set([subject.email, subject.unverifiedEmailShared ? null : subject.unverifiedEmail].filter(nonEmpty).map(norm));
  const rowAddresses = new Set([...ownAddresses, ...[subject.unverifiedEmail].filter(nonEmpty).map(norm)]);
  const names = new Set([subject.name].filter(nonEmpty).map(norm).filter((n) => n !== "deleted member"));
  if (nonEmpty(subject.sourceKey)) {
    const key = norm(subject.sourceKey);
    keys.add(key);
    const person = key.match(/^teamup:([^|]*)\|(.*)$/);
    if (person) {
      if (person[1]) rowAddresses.add(person[1]);
      if (person[2]) names.add(person[2]);
    }
    const payer = key.match(/^teamup-payer:(.+)$/);
    if (payer) {
      ownAddresses.add(payer[1]);
      rowAddresses.add(payer[1]);
    }
  }
  for (const a of ownAddresses) {
    keys.add(`teamup-payer:${a}`);
    // Their own TeamUp key, even when Member.externalRef was never stamped.
    for (const n of names) keys.add(`teamup:${a}|${n}`);
  }
  return { memberId: subject.memberId, keys, ownAddresses, rowAddresses, names };
}

// ─── Text and encoding ───────────────────────────────────────────────────────

type Decoded = { text: string; encoding: "utf8" | "latin1" };

/** UTF-8 when the bytes are valid UTF-8 (a BOM is kept), otherwise Latin-1, so a rewrite never mangles other rows. */
export function decodeImportBytes(bytes: Uint8Array): Decoded {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), encoding: "utf8" };
  } catch {
    return { text: Buffer.from(bytes).toString("latin1"), encoding: "latin1" };
  }
}

export function encodeImportText(d: Decoded): Uint8Array {
  return Buffer.from(d.text, d.encoding);
}

// ─── CSV, byte-preserving ────────────────────────────────────────────────────

type CsvRecord = { start: number; end: number; cells: string[] };

/** The delimiter of a CSV text, read from its first line: comma unless that line has more semicolons or tabs. */
export function csvDelimiter(text: string): "," | ";" | "\t" {
  const lineEnd = text.search(/\r?\n/);
  const first = lineEnd < 0 ? text : text.slice(0, lineEnd);
  const count = (c: string) => first.split(c).length - 1;
  return ([",", ";", "\t"] as const).reduce((a, b) => (count(b) > count(a) ? b : a));
}

/** Each record of a CSV text with its span (end includes its line break); quoted fields may hold line breaks. */
export function csvRecords(text: string, delimiter = ","): CsvRecord[] {
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
    if (ch === delimiter) { cells.push(cur); cur = ""; continue; }
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

function serialiseRow(cells: string[], delimiter: string, lineEnd: string): string {
  const q = (c: string) => (c.includes(delimiter) || /["\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return cells.map(q).join(delimiter) + lineEnd;
}

const NAME_HEADERS = ["customer name", "name", "full name", "member name", "client name", "athlete name"];
const FIRST_HEADERS = ["first name", "firstname", "given name"];
const LAST_HEADERS = ["last name", "lastname", "surname", "family name"];
const EMAIL_HEADERS = ["customer email", "email", "email address", "e-mail"];

/**
 * The text without the subject's rows, and with the subject's own address and
 * name blanked in other people's rows. The first non-empty record (the header)
 * is never touched.
 */
export function removeSubjectRows(text: string, subject: ErasureSubject): { text: string; removed: number; blanked: number } {
  const w = who(subject);
  if (w.rowAddresses.size === 0 && w.names.size === 0) return { text, removed: 0, blanked: 0 };
  const delimiter = csvDelimiter(text);
  const records = csvRecords(text, delimiter);
  const h = records.findIndex((r) => r.cells.some((c) => c.trim() !== ""));
  if (h < 0) return { text, removed: 0, blanked: 0 };
  const header = records[h].cells.map(norm);
  const col = (names: string[]) => header.findIndex((c) => names.includes(c));
  const nameCol = col(NAME_HEADERS);
  const firstCol = col(FIRST_HEADERS);
  const lastCol = col(LAST_HEADERS);
  const emailCol = col(EMAIL_HEADERS);
  const nameCols = new Set([nameCol, firstCol, lastCol].filter((i) => i >= 0));

  const rowName = (cells: string[]): string | null => {
    if (nameCol >= 0) return norm(cells[nameCol] ?? "");
    if (firstCol >= 0 && lastCol >= 0) return norm(`${cells[firstCol] ?? ""} ${cells[lastCol] ?? ""}`);
    return null;
  };
  const isSubjects = (cells: string[]): boolean => {
    const name = rowName(cells);
    const nameHit = name !== null ? w.names.has(name) : cells.some((c) => w.names.has(norm(c)));
    if (!nameHit) return false;
    if (w.rowAddresses.size === 0) {
      // No address to tell two people of one name apart: only a row with no address at all.
      return emailCol >= 0 ? norm(cells[emailCol] ?? "") === "" : !cells.some((c) => c.includes("@"));
    }
    return emailCol >= 0 ? w.rowAddresses.has(norm(cells[emailCol] ?? "")) : cells.some((c) => w.rowAddresses.has(norm(c)));
  };

  let removed = 0;
  let blanked = 0;
  let out = "";
  let at = 0;
  records.forEach((r, i) => {
    if (i <= h) return;
    if (isSubjects(r.cells)) {
      out += text.slice(at, r.start);
      at = r.end;
      removed += 1;
      return;
    }
    let changed = 0;
    const cells = r.cells.map((c, j) => {
      const v = norm(c);
      // A name is blanked only outside a recognised name column; with no name column there is no telling.
      if (v && (w.ownAddresses.has(v) || (nameCols.size > 0 && !nameCols.has(j) && w.names.has(v)))) { changed += 1; return ""; }
      return c;
    });
    if (changed === 0) return;
    const slice = text.slice(r.start, r.end);
    const lineEnd = slice.endsWith("\r\n") ? "\r\n" : slice.endsWith("\n") ? "\n" : "";
    out += text.slice(at, r.start) + serialiseRow(cells, delimiter, lineEnd);
    at = r.end;
    blanked += changed;
  });
  if (removed === 0 && blanked === 0) return { text, removed: 0, blanked: 0 };
  return { text: out + text.slice(at), removed, blanked };
}

// ─── Diagnostics (errorLog, dryRunSummary) ───────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ADDRESS_CHARS = "a-z0-9._%+@-";

/** The string holds one of the subject's own addresses as a whole address (not inside a longer one, nor inside a key). */
function hasOwnAddress(s: string, w: Who): boolean {
  const v = s.toLowerCase();
  if (/teamup(-payer)?:/.test(v)) return false;
  for (const a of w.ownAddresses) {
    if (new RegExp(`(^|[^${ADDRESS_CHARS}])${escapeRe(a)}($|[^${ADDRESS_CHARS}])`).test(v)) return true;
  }
  return false;
}

/** The string is the subject's name, `<name>: …`, `<name> (…`, or `… of <name>`. */
function hasOwnName(s: string, w: Who): boolean {
  const v = norm(s);
  for (const n of w.names) {
    if (v === n || v.startsWith(`${n}:`) || v.startsWith(`${n} (`)) return true;
    if (new RegExp(`\\bof ${escapeRe(n)}($|[^a-z])`).test(v)) return true;
  }
  return false;
}

const isKey = (s: string) => /^teamup(-payer)?:/i.test(s.trim());
const isAddress = (s: string) => /^[^\s@]+@[^\s@]+$/.test(s.trim());

/** Another person's identifier: an address or key that is not the subject's. */
function otherIdentifier(s: string, w: Who): boolean {
  const v = norm(s);
  if (isKey(v)) return !w.keys.has(v);
  if (isAddress(v)) return !w.ownAddresses.has(v) && !w.rowAddresses.has(v);
  return false;
}

type Verdict = { kind: "remove" } | { kind: "blank"; fields: string[] } | { kind: "keep" };

function verdict(entry: Record<string, unknown>, w: Who): Verdict {
  if (entry.memberId === w.memberId) return { kind: "remove" };
  if (Array.isArray(entry.memberIds) && entry.memberIds.includes(w.memberId)) return { kind: "remove" };
  const strings = Object.entries(entry).filter((e): e is [string, string] => typeof e[1] === "string");
  const otherPerson =
    (typeof entry.memberId === "string" && entry.memberId !== "") ||
    strings.some(([, v]) => otherIdentifier(v, w)) ||
    // A name field naming someone else (a child's entry that carries the parent's address).
    strings.some(([k, v]) => /name$/i.test(k) && v.trim() !== "" && !hasOwnName(v, w));
  if (!otherPerson && strings.some(([, v]) => w.keys.has(norm(v)))) return { kind: "remove" };
  const addressFields = strings.filter(([, v]) => w.ownAddresses.has(norm(v)) || hasOwnAddress(v, w)).map(([k]) => k);
  const nameHit = strings.some(([, v]) => hasOwnName(v, w));
  if (!otherPerson && (nameHit || addressFields.length > 0)) return { kind: "remove" };
  return addressFields.length > 0 ? { kind: "blank", fields: addressFields } : { kind: "keep" };
}

function stringIsSubjects(s: string, w: Who): boolean {
  return w.keys.has(norm(s)) || w.ownAddresses.has(norm(s)) || hasOwnAddress(s, w) || hasOwnName(s, w);
}

function scrub(value: unknown, w: Who, inArray: boolean): { value: unknown; n: number } {
  if (Array.isArray(value)) {
    let n = 0;
    const out: unknown[] = [];
    for (const el of value) {
      if (el === w.memberId || (typeof el === "string" && stringIsSubjects(el, w))) { n += 1; continue; }
      if (isObject(el) && verdict(el, w).kind === "remove") { n += 1; continue; }
      const r = scrub(el, w, true);
      n += r.n;
      out.push(r.value);
    }
    return { value: out, n };
  }
  if (isObject(value)) {
    const v = verdict(value, w);
    if (v.kind === "remove" && !inArray) return { value: { removed: true }, n: 1 };
    let n = 0;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(value)) {
      if (v.kind === "blank" && v.fields.includes(k)) { out[k] = ""; n += 1; continue; }
      const r = scrub(child, w, false);
      n += r.n;
      out[k] = r.value;
    }
    return { value: out, n };
  }
  return { value, n: 0 };
}

/** Pure: one stored diagnostics value with the subject's entries removed and their address blanked elsewhere. */
export function scrubSubjectFromDiagnostics(value: unknown, subject: ErasureSubject): { value: unknown; scrubbed: number } {
  const r = scrub(value, who(subject), false);
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
 * Rewrite every stored import file of this club — each job's file, and every
 * chunked upload, attached to a job or not — without the subject's rows. Runs
 * outside any transaction (a file store call is a network call). Throws if a
 * file that names the subject cannot be rewritten: the erasure must not
 * report success while the rows survive. Each file is rewritten in place
 * (same address), so a failure leaves the old content, never a lost file.
 */
export async function eraseSubjectFromImportFiles(
  tenantId: string,
  subject: ErasureSubject,
  /** Added to as each file is rewritten, so a caller knows what already changed when a later file throws. */
  progress: { files: number; rows: number; cells: number } = { files: 0, rows: 0, cells: 0 },
): Promise<{ files: number; rows: number; cells: number }> {
  const [jobs, uploads] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.importJob.findMany({ where: { tenantId, NOT: { fileBlobUrl: "" } }, select: { fileBlobUrl: true } }),
      tx.importUpload.findMany({ where: { tenantId }, select: { id: true, status: true, expiresAt: true } }),
    ]),
  );
  const urls = new Set(jobs.map((j) => j.fileBlobUrl));
  const now = new Date();
  // An upload still arriving in chunks (open, not yet expired) is not rewritten under the browser's feet.
  for (const u of uploads) if (!(u.status === "open" && u.expiresAt > now)) urls.add(`${DB_UPLOAD_PREFIX}${u.id}`);
  let files = 0;
  let rows = 0;
  let cells = 0;
  for (const url of urls) {
    const bytes = await readImportFileBytes(url, tenantId);
    if (bytes === null) continue;
    const decoded = decodeImportBytes(bytes);
    const r = removeSubjectRows(decoded.text, subject);
    if (r.removed === 0 && r.blanked === 0) continue;
    await rewriteImportFile(url, tenantId, encodeImportText({ text: r.text, encoding: decoded.encoding }));
    files += 1;
    rows += r.removed;
    cells += r.blanked;
    progress.files += 1;
    progress.rows += r.removed;
    progress.cells += r.blanked;
  }
  return { files, rows, cells };
}
