/**
 * CSV importers — common shape and dispatcher.
 * Each vendor module exports `parse(csvText)` that returns MemberDraft[] + per-row errors.
 */
import { parseTeamUp } from "./teamup";
import { parseTime } from "@/lib/class-time";
import type { Prisma } from "@prisma/client";
export type ImportSource = "generic" | "mindbody" | "glofox" | "wodify" | "teamup";

/**
 * Which mapping parsed a file, recorded on every ImportJob so a reconciliation
 * can say exactly which rules produced its rows. Bump a source's version when
 * its header map or folding rules change.
 */
export const MAPPING_VERSION: Record<ImportSource, string> = {
  generic: "generic@2026-09-30",
  mindbody: "mindbody@2026-09-30",
  glofox: "glofox@2026-09-30",
  wodify: "wodify@2026-09-30",
  // teamup-2 (2 Oct 2026): as-of entitlement, per-row memberships and
  // dispositions, guardianship suggested not granted, source-only dates.
  teamup: "teamup-2@2026-10-02",
};

/** One source membership row, kept whole (ImportedMembership). Dates are ISO date-only strings; completedAt is an instant. */
export type MembershipRowDraft = {
  sourceRow: number;
  sourceFingerprint: string;
  planLabel: string;
  type: string;
  status: string;
  processor?: string;
  purchaseDate?: string;
  startDate?: string;
  expiryDate?: string;
  cancelledDate?: string;
  completedAt?: string;
  isFirst?: boolean;
  otherActive?: string;
  /** current | scheduled | held | history — or, for a row that became no member: duplicate | quarantined | excluded */
  entitlement: "current" | "scheduled" | "held" | "history" | "duplicate" | "quarantined" | "excluded";
};

/** Every CSV record (header = 1) ends up as exactly one of these, with the row's own facts kept whole. */
export type RowDisposition = {
  sourceRow: number;
  sourceFingerprint: string;
  /** member_history | duplicate_of:<row> | quarantined:<reason> | excluded:deleted_customer */
  disposition: string;
  /** The person key the row belongs to, when it belongs to one. */
  sourceKey?: string;
  /** The membership facts on the row (plan, status, dates…) — what ImportedMembership stores. */
  membership: MembershipRowDraft;
};

/** How an import's export time is known (ImportJob.sourceExportedAtProvenance). */
export type ExportTimeProvenance = "owner_stated" | "provisional";
export const EXPORT_TIME_PROVENANCES: readonly ExportTimeProvenance[] = ["owner_stated", "provisional"];

/**
 * The instant a club wall-clock time names: "YYYY-MM-DDTHH:mm" (an HTML
 * datetime-local value) read in the CLUB's timezone, not the browser's.
 *
 * The Import panel used to send `new Date(value).toISOString()`, which reads
 * the typed time in the zone of whatever laptop the owner is on: typed in Bali
 * (UTC+8) a London export time of 00:15 on 5 Oct became 16:15Z on 4 Oct, the
 * as-of date fell on the 4th, and a membership starting on the 5th was
 * imported as not yet started. Returns null for anything that is not a
 * wall-clock value. A time the clocks skip (spring forward) resolves to the
 * equivalent instant after the gap; a time that happens twice (the October
 * changeover) resolves to the second, GMT, occurrence (lib/class-time.ts
 * parseTime) — either way the club calendar date, which is all an import
 * reads, is the one typed.
 */
export function clubWallClockToInstant(value: string, timeZone: string): Date | null {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d) || Number(hh) > 23 || Number(mm) > 59) return null;
  return parseTime(`${hh}:${mm}`, day, timeZone);
}

/**
 * A refresh refuses a file exported before the standing already recorded
 * (lib/importers/teamup-refresh planRefresh, "olderThanRecorded"). A standing
 * dated by a PROVISIONAL export time is an estimate, not a record: if the
 * owner guessed late, the refresh that carries the real (earlier) time is the
 * correction and must not be refused by the guess (3 Oct 2026). Members whose
 * standing came from a provisional job are passed to the plan with no
 * recorded date, so only owner-stated times order refreshes.
 */
export async function withoutProvisionalStanding<M extends { billingStatusSource: string | null; billingStatusAsOf: Date | null }>(
  tx: Pick<Prisma.TransactionClient, "importJob">,
  tenantId: string,
  members: M[],
): Promise<M[]> {
  const sources = [...new Set(members.map((m) => m.billingStatusSource).filter((s): s is string => !!s))];
  if (sources.length === 0) return members;
  const provisional = new Set(
    (await tx.importJob.findMany({ where: { tenantId, id: { in: sources }, sourceExportedAtProvenance: "provisional" }, select: { id: true } })).map((j) => j.id),
  );
  if (provisional.size === 0) return members;
  return members.map((m) => (m.billingStatusSource && provisional.has(m.billingStatusSource) ? { ...m, billingStatusAsOf: null } : m));
}

export const IMPORT_SOURCES: readonly ImportSource[] = ["generic", "mindbody", "glofox", "wodify", "teamup"];

export type MemberDraft = {
  name: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;        // ISO date
  membershipType?: string;
  status?: string;             // active | inactive | cancelled | taster
  accountType?: string;        // adult | junior | kids | parent
  notes?: string;
  joinedAt?: string;           // ISO datetime
  nextDueAt?: string;          // ISO date — when this member's membership is next due
  paymentStatus?: string;      // paid | overdue | paused | free | pending | cancelled
  cancelledAt?: string;        // ISO date — when a cancelled member left
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  /** Kids only: the email of the parent draft/member this child hangs off. */
  parentEmail?: string;
  /** The email is synthesised (no real address) — never invite, never match to a payment provider. */
  nonContactable?: boolean;
  /** A record the importer had to create (a payer/guardian) rather than read — review before trusting. */
  unverified?: boolean;
  /** Source row numbers (1-based, header = 1) this draft was folded from. */
  sourceRows?: number[];
  /**
   * Stable identity of this person in the source system, stored as
   * Member.externalRef. TeamUp exports carry no customer id, so it is the
   * person key the parser folds rows by ("teamup:<email>|<name>"). A status
   * refresh matches on it; a changed name or email is an exception, never a guess.
   */
  sourceKey?: string;
  /** TeamUp: every source row this person folded from, kept whole. */
  memberships?: MembershipRowDraft[];
  /** TeamUp: a decision the owner must make before this person has a current plan (e.g. two started active memberships). */
  decision?: { kind: "concurrent_memberships"; options: string[]; rows: number[] };
  /** TeamUp: an active membership whose start is after the as-of date. */
  scheduled?: { planLabel: string; startDate: string; sourceRow: number };
  /** How the parent link was suggested: shared_email | emergency_contact. The link is NOT confirmed by an import. */
  guardianSuggestedBy?: "shared_email" | "emergency_contact";
  /** A contact address seen in the source but not verified — never a login (Member.unverifiedEmail). */
  unverifiedEmail?: string;
};

export type ParseResult = {
  drafts: MemberDraft[];
  errors: { row: number; reason: string }[];
  /** Source-specific reconciliation figures (TeamUp today). */
  summary?: Record<string, unknown>;
  /** TeamUp: one disposition per CSV record; sums to the record count. */
  rows?: RowDisposition[];
};

/**
 * The line of the file each row started on (1 = the header). Blank lines are
 * dropped from the rows, so a row's index is not its line: error messages must
 * cite this, or every error after a blank line pointed one line too high.
 */
export function csvRowLine(row: string[], fallbackIndex: number): number {
  return (row as string[] & { line?: number }).line ?? fallbackIndex + 1;
}

export function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;
  const finishRow = () => {
    Object.defineProperty(row, "line", { value: rowStart, enumerable: false });
    rows.push(row);
    row = [];
    rowStart = line;
  };
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      if (ch === "\n") line++;
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(cur); cur = ""; continue; }
    if (ch === "\n") { row.push(cur); cur = ""; line++; finishRow(); continue; }
    if (ch === "\r") continue;
    cur += ch;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    finishRow();
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function findHeader(headers: string[], candidates: string[]): number {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function trimOrUndef(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function parseISODate(s: string | undefined): string | undefined {
  const t = trimOrUndef(s);
  if (!t) return undefined;
  // Accept YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY (UK preferred)
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t);
  if (iso) return t;
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, a, b, y] = slash;
    // Default to UK DD/MM/YYYY
    const dd = a.padStart(2, "0");
    const mm = b.padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  const d = new Date(t);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

function normaliseStatus(s: string | undefined): string | undefined {
  const t = trimOrUndef(s)?.toLowerCase();
  if (!t) return undefined;
  if (["active", "current", "live"].includes(t)) return "active";
  if (["inactive", "lapsed", "frozen", "paused"].includes(t)) return "inactive";
  if (["cancelled", "canceled", "ended", "terminated"].includes(t)) return "cancelled";
  if (["taster", "trial", "free trial", "drop-in"].includes(t)) return "taster";
  return undefined;
}

function normaliseAccountType(s: string | undefined): string | undefined {
  const t = trimOrUndef(s)?.toLowerCase();
  if (!t) return undefined;
  if (["kid", "kids", "child", "children"].includes(t)) return "kids";
  if (["junior", "teen", "youth"].includes(t)) return "junior";
  if (["adult", "senior", "adult member"].includes(t)) return "adult";
  return undefined;
}

/**
 * Parse a billing "next due" cell. Reuses `parseISODate`'s common-format
 * handling (ISO, UK dd/mm/yyyy, then a permissive `Date` fallback) so it
 * stays in sync with the dateOfBirth column rather than drifting.
 *
 * Non-fatal by design: a blank cell is silently tolerated (no note — most
 * vendor exports simply won't have this column yet), an unparseable one
 * returns no value plus a note so the row still imports on names+phone
 * rather than being dropped.
 */
function parseDueDate(s: string | undefined): { value?: string; note?: string } {
  const t = trimOrUndef(s);
  if (!t) return {};
  const parsed = parseISODate(t);
  if (parsed) return { value: parsed };
  return { note: `Import: unrecognised next-due date "${t}" — left blank, check manually.` };
}

/**
 * Normalise a vendor's free-text billing/payment status cell onto the
 * `Member.paymentStatus` CHECK vocabulary (migration 20260430000001): paid |
 * overdue | paused | free | pending | cancelled.
 *
 * Always resolves to a value — an unrecognised word defaults to "paid"
 * (the column's own DB default) rather than blocking the row, with a note so
 * the owner can spot and correct it after import. A blank cell defaults
 * silently, same tolerance as a blank status/account-type cell elsewhere in
 * this file.
 */
function normalisePaymentStatus(s: string | undefined): { value: string; note?: string } {
  const t = trimOrUndef(s)?.toLowerCase();
  if (!t) return { value: "paid" };
  if (["paid", "active", "current"].includes(t)) return { value: "paid" };
  if (["overdue", "past due", "late"].includes(t)) return { value: "overdue" };
  if (["paused", "hold", "frozen"].includes(t)) return { value: "paused" };
  if (["free", "comp", "complimentary"].includes(t)) return { value: "free" };
  if (["pending"].includes(t)) return { value: "pending" };
  if (["cancelled", "canceled", "inactive"].includes(t)) return { value: "cancelled" };
  return { value: "paid", note: `Import: unrecognised payment status "${t}" — defaulted to paid, check manually.` };
}

function parseRowsWithMap(rows: string[][], headerMap: Record<MappedField, string[]>): ParseResult {
  if (rows.length < 2) return { drafts: [], errors: [{ row: 0, reason: "CSV is empty or has no data rows." }] };
  const headers = rows[0];
  const idx = {} as Record<MappedField, number>;
  for (const k of Object.keys(headerMap) as MappedField[]) {
    idx[k] = findHeader(headers, headerMap[k]);
  }

  if (idx.name === -1 && idx.email === -1) {
    return { drafts: [], errors: [{ row: 0, reason: "Couldn't find name or email columns." }] };
  }

  const drafts: MemberDraft[] = [];
  const errors: { row: number; reason: string }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const email = trimOrUndef(row[idx.email]);
    const name = trimOrUndef(row[idx.name]);
    if (!email || !isValidEmail(email)) {
      errors.push({ row: csvRowLine(row, r), reason: !email ? "Missing email" : `Invalid email: ${email}` });
      continue;
    }
    if (!name) {
      errors.push({ row: csvRowLine(row, r), reason: "Missing name" });
      continue;
    }

    const dueDate = parseDueDate(row[idx.nextDueAt]);
    const paymentStatus = normalisePaymentStatus(row[idx.paymentStatus]);
    // Billing-field warnings ride along in `notes` rather than the row-level
    // `errors` array: `errors` rows are dropped from the import entirely
    // (see the email/name checks above), and a garbled billing cell must
    // never cost the member their names+phone import — see brief guard.
    const noteParts = [trimOrUndef(row[idx.notes]), dueDate.note, paymentStatus.note].filter(
      (p): p is string => Boolean(p),
    );

    drafts.push({
      name,
      email: email.toLowerCase(),
      phone: trimOrUndef(row[idx.phone]),
      dateOfBirth: parseISODate(row[idx.dateOfBirth]),
      membershipType: trimOrUndef(row[idx.membershipType]),
      status: normaliseStatus(row[idx.status]) ?? "active",
      accountType: normaliseAccountType(row[idx.accountType]) ?? "adult",
      notes: noteParts.length ? noteParts.join(" | ") : undefined,
      joinedAt: parseISODate(row[idx.joinedAt]),
      nextDueAt: dueDate.value,
      paymentStatus: paymentStatus.value,
    });
  }

  return { drafts, errors };
}

type MappedField =
  | "name" | "email" | "phone" | "dateOfBirth" | "membershipType" | "status"
  | "accountType" | "notes" | "joinedAt" | "nextDueAt" | "paymentStatus";

const HEADER_MAPS: Record<Exclude<ImportSource, "teamup">, Record<MappedField, string[]>> = {
  generic: {
    name: ["name", "full name", "member name"],
    email: ["email", "email address"],
    phone: ["phone", "mobile", "telephone"],
    dateOfBirth: ["dob", "date of birth", "birthday"],
    membershipType: ["membership", "membership type", "plan"],
    status: ["status", "member status"],
    accountType: ["account type", "type", "category"],
    notes: ["notes", "comments"],
    joinedAt: ["joined", "join date", "joined at", "signup date"],
    nextDueAt: ["next due", "next due date", "due date", "next payment date"],
    paymentStatus: ["payment status", "billing status"],
  },
  mindbody: {
    name: ["client name", "name"],
    email: ["email"],
    phone: ["mobile phone", "home phone", "phone"],
    dateOfBirth: ["birth date", "date of birth"],
    membershipType: ["membership", "active membership"],
    status: ["client status", "status"],
    accountType: ["age category", "account type"],
    notes: ["notes"],
    joinedAt: ["client since", "first visit"],
    nextDueAt: ["next auto-pay date", "next payment date", "autopay date"],
    paymentStatus: ["autopay status", "payment status", "account balance status"],
  },
  glofox: {
    name: ["name", "full name"],
    email: ["email"],
    phone: ["phone number", "phone"],
    dateOfBirth: ["dob"],
    membershipType: ["membership name", "current membership"],
    status: ["status"],
    accountType: ["category"],
    notes: ["notes"],
    joinedAt: ["sign up date", "joined"],
    nextDueAt: ["next payment date", "next billing date"],
    paymentStatus: ["payment status", "billing status"],
  },
  wodify: {
    name: ["athlete name", "name"],
    email: ["email"],
    phone: ["phone", "mobile"],
    dateOfBirth: ["dob", "date of birth"],
    membershipType: ["membership", "active membership"],
    status: ["status"],
    accountType: ["age group"],
    notes: ["notes"],
    joinedAt: ["start date", "joined"],
    nextDueAt: ["next billing date", "next payment date"],
    paymentStatus: ["billing status", "payment status"],
  },
};

export function parseImport(source: ImportSource, csvText: string, opts: { asOf?: string } = {}): ParseResult {
  if (source === "teamup") {
    // Folds membership-history rows into people; see ./teamup.ts. Entitlement
    // is read at the export's snapshot date in the club's timezone (`asOf`).
    return parseTeamUp(csvText, opts);
  }
  const rows = parseCSV(csvText);
  return parseRowsWithMap(rows, HEADER_MAPS[source]);
}
