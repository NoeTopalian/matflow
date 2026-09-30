/**
 * Attendance history — a club's historical attendance export, turned into a
 * PLAN of rows. Pure: no database, no clock, no network. A commit route (not
 * written yet) turns the plan into `ClassInstance` + `AttendanceRecord` rows.
 *
 * WHAT THE PLAN NEVER DOES. An imported attendance is history, not an event.
 * Nothing in the plan consumes a class credit or a pack, creates a payment or
 * an invoice, sends an invitation, fires a notification, or touches a waiver.
 * The plan types below carry no field for any of those, and
 * tests/unit/import-attendance.test.ts asserts it at the type level and at
 * runtime. The commit route must write the plan with plain inserts — never
 * through the check-in route, whose side-effects (credit burn, streaks,
 * notifications) are exactly what an import must not trigger.
 *
 * Rules, each pinned by tests/unit/import-attendance.test.ts and written up
 * for clubs in docs/runbooks/ATTENDANCE-IMPORT.md:
 *  - Only ATTENDED rows become records. booked / cancelled / late cancel /
 *    no-show / waitlisted / not-attended rows are EXCLUDED, each with its
 *    reason. An unrecognised or missing status is QUARANTINED — never guessed.
 *  - A person is matched by the source's customer id first (against ids the
 *    caller supplies per member), then by email — exact, lower-cased, and only
 *    when exactly one member holds it. Never by name alone. When the email
 *    matches but the row's name is not that member's, the row is quarantined
 *    (`email_name_mismatch`): that is a child booked on a parent's address.
 *    Unresolved → quarantined.
 *  - A class name matches one of the club's classes by name (trimmed,
 *    case-insensitive, whitespace collapsed) or by a caller-supplied alias. An
 *    unknown name still yields a session, with `classId: null`, and the rows in
 *    it are quarantined `unknown_class`: a class is never invented.
 *  - Local wall-clock time → UTC through the club's IANA timezone, DST
 *    included (lib/class-time.ts `parseTime`). A time that does not exist
 *    locally (the spring-forward gap) is quarantined; nothing is shifted.
 *    Dates are ISO or UK DD/MM/YYYY; anything else is malformed — there is no
 *    `new Date(string)` fallback, which would silently read 03/04 as 4 March.
 *  - The same person twice in the same session collapses to one record; the
 *    extra rows are excluded as `duplicate` and counted.
 *  - Deterministic and idempotent: keys derive only from the class id (or the
 *    normalised name of an unmatched class), the UTC start and the member id,
 *    so a re-run (or a re-ordered file) produces
 *    identical keys. Sessions and records are returned sorted by key.
 *  - Every input row lands in exactly one of records (as the kept row),
 *    excluded, or quarantined: records + excluded + quarantined = input rows.
 */
import { parseCSV } from "./index";
import { dayMarkerUtc, parseTime, zoneOffsetMs } from "@/lib/class-time";

// ── Parse ──────────────────────────────────────────────────────────────────

export type AttendanceField =
  | "sourceRowId"
  | "personId"
  | "email"
  | "name"
  | "className"
  | "startDateTime"
  | "startDate"
  | "startTime"
  | "endTime"
  | "status"
  | "attended";

/** Per field, the header names that may carry it (case-insensitive, first match wins). */
export type AttendanceMapping = Record<AttendanceField, string[]>;

/**
 * A TeamUp-style attendance export. UNVERIFIED against a real file: format
 * acceptance is blocked until a club's actual export has been inspected (see
 * the runbook). Supply a `mapping` to override any field.
 */
export const DEFAULT_ATTENDANCE_MAPPING: AttendanceMapping = {
  sourceRowId: ["attendance id", "booking id", "registration id", "id"],
  personId: ["customer id", "member id", "client id"],
  email: ["customer email", "email", "email address"],
  name: ["customer name", "name", "member name"],
  className: ["event name", "class", "class name", "event"],
  startDateTime: ["start", "start date time", "start datetime", "starts at"],
  startDate: ["start date", "date", "event date"],
  startTime: ["start time", "time"],
  endTime: ["end time"],
  status: ["status", "attendance status", "booking status"],
  attended: ["attended", "checked in", "attendance"],
};

export type AttendanceStatus =
  | "attended"
  | "booked"
  | "cancelled"
  | "late_cancel"
  | "no_show"
  | "waitlisted"
  | "not_attended"
  | "missing"
  | "unknown"
  | "conflict";

export type DateIssue = "missing_date" | "missing_time" | "malformed_date" | "offset_not_supported";

export type AttendanceRow = {
  /** The export's own row id when it has one, else `row:<line>` (header = line 1). */
  sourceRowId: string;
  /** 1-based line in the file, header = 1. */
  line: number;
  /** Source customer id when present, else email — lower-cased. "" when neither. */
  personKey: string;
  personId: string;
  email: string;
  personName: string;
  className: string;
  /** "YYYY-MM-DD HH:mm", club wall clock. null when the cell could not be read — see `dateIssue`. */
  startLocal: string | null;
  endLocalTime: string | null;
  dateIssue?: DateIssue;
  status: AttendanceStatus;
  rawStatus: string;
};

export type AttendanceParseResult = {
  rows: AttendanceRow[];
  /** Fatal problems with the file as a whole (no rows are returned when present). */
  errors: string[];
  /** Which header each field was read from; null = not present. */
  mappedColumns: Record<AttendanceField, string | null>;
  /** Headers present in the file that no field uses — reported, never guessed at. */
  unmappedColumns: string[];
  /** Mapped headers that are blank on every data row, and header cells that are themselves blank (as `#<n>`). */
  blankColumns: string[];
};

const ATTENDED = new Set(["attended", "checked in", "checked-in", "present", "completed", "visited", "signed in"]);
const BOOKED = new Set(["booked", "reserved", "confirmed", "registered", "booking"]);
const CANCELLED = new Set(["cancelled", "canceled", "cancelled by customer", "cancelled by staff"]);
const LATE_CANCEL = new Set(["late cancel", "late cancelled", "late canceled", "late-cancel", "late cancellation", "late_cancel"]);
const NO_SHOW = new Set(["no show", "no-show", "noshow", "no_show", "absent", "missed"]);
const WAITLIST = new Set(["waitlist", "waitlisted", "wait list", "waiting list"]);
const YES = new Set(["yes", "y", "true", "1", "attended", "checked in"]);
const NO = new Set(["no", "n", "false", "0"]);

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function statusWord(raw: string): AttendanceStatus | null {
  const t = norm(raw);
  if (!t) return null;
  if (ATTENDED.has(t)) return "attended";
  if (BOOKED.has(t)) return "booked";
  if (CANCELLED.has(t)) return "cancelled";
  if (LATE_CANCEL.has(t)) return "late_cancel";
  if (NO_SHOW.has(t)) return "no_show";
  if (WAITLIST.has(t)) return "waitlisted";
  return "unknown";
}

/**
 * Status column and attended flag together. A cancellation always stands; an
 * attended flag of "yes" upgrades a booking (exports often keep the booking
 * status and tick a flag); a status of attended with a flag of "no" is a
 * contradiction and is not resolved here.
 */
function resolveStatus(rawStatus: string, rawFlag: string): AttendanceStatus {
  const s = statusWord(rawStatus);
  const f = norm(rawFlag);
  const flag = !f ? null : YES.has(f) ? true : NO.has(f) ? false : undefined;
  if (flag === undefined) return "unknown";
  if (s === "cancelled" || s === "late_cancel" || s === "waitlisted") return s;
  if (s === "unknown") return "unknown";
  if (s === "attended") return flag === false ? "conflict" : "attended";
  if (s === "no_show") return flag === true ? "conflict" : "no_show";
  if (s === "booked") return flag === true ? "attended" : "booked";
  // No status word.
  if (flag === true) return "attended";
  if (flag === false) return "not_attended";
  return "missing";
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function readDate(s: string): string | null {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
  }
  // UK order only. A US-ordered export must be declared, not detected.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
  }
  return null;
}

function readTime(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[4].toLowerCase() === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function readStart(dateTimeCell: string, dateCell: string, timeCell: string): { local: string } | { issue: DateIssue } {
  const combined = dateTimeCell.trim() || dateCell.trim();
  if (!combined) return { issue: "missing_date" };
  const [datePart, ...rest] = combined.split(/[T\s]+/);
  const inlineTime = rest.join(" ");
  // An instant with an offset is a different contract (UTC, not wall clock); refuse rather than guess.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(inlineTime) && !/\s(am|pm)$/i.test(inlineTime)) return { issue: "offset_not_supported" };
  const date = readDate(datePart);
  if (!date) return { issue: "malformed_date" };
  const timeRaw = timeCell.trim() || inlineTime;
  if (!timeRaw) return { issue: "missing_time" };
  const time = readTime(timeRaw);
  if (!time) return { issue: "malformed_date" };
  return { local: `${date} ${time}` };
}

export function parseAttendanceCsv(
  text: string,
  opts: { mapping?: Partial<AttendanceMapping> } = {},
): AttendanceParseResult {
  const mapping: AttendanceMapping = { ...DEFAULT_ATTENDANCE_MAPPING, ...opts.mapping };
  const mappedColumns = Object.fromEntries(
    (Object.keys(mapping) as AttendanceField[]).map((k) => [k, null]),
  ) as Record<AttendanceField, string | null>;
  const empty: AttendanceParseResult = { rows: [], errors: [], mappedColumns, unmappedColumns: [], blankColumns: [] };

  const table = parseCSV(text.replace(/^﻿/, ""));
  if (table.length < 2) return { ...empty, errors: ["The file is empty or has no data rows."] };

  const headers = table[0].map((h) => h.trim());
  const lower = headers.map((h) => h.toLowerCase());
  const idx = {} as Record<AttendanceField, number>;
  const used = new Set<number>();
  // Specific fields claim their headers before generic ones ("start date" is a
  // startDate, not a startDateTime; "customer email" before "email").
  const order: AttendanceField[] = ["sourceRowId", "personId", "email", "name", "className", "startDate", "startTime", "endTime", "startDateTime", "status", "attended"];
  for (const f of order) {
    idx[f] = -1;
    for (const c of mapping[f] ?? []) {
      const i = lower.indexOf(c.toLowerCase());
      if (i !== -1 && !used.has(i)) { idx[f] = i; used.add(i); break; }
    }
    mappedColumns[f] = idx[f] === -1 ? null : headers[idx[f]];
  }

  const unmappedColumns = headers.filter((h, i) => h !== "" && !used.has(i));
  const blankColumns: string[] = headers.flatMap((h, i) => (h === "" ? [`#${i + 1}`] : []));
  const data = table.slice(1);
  for (const f of order) {
    const i = idx[f];
    if (i !== -1 && data.every((r) => !(r[i] ?? "").trim())) blankColumns.push(headers[i]);
  }

  const missing: string[] = [];
  if (idx.className === -1) missing.push("class (e.g. \"Event Name\")");
  if (idx.startDateTime === -1 && idx.startDate === -1) missing.push("start date (e.g. \"Start Date\")");
  if (idx.status === -1 && idx.attended === -1) missing.push("status or attended (e.g. \"Status\")");
  if (idx.personId === -1 && idx.email === -1) missing.push("customer id or email (e.g. \"Customer Email\")");
  if (missing.length) {
    return { ...empty, mappedColumns, unmappedColumns, blankColumns, errors: [`Missing required column(s): ${missing.join("; ")}.`] };
  }

  const cell = (r: string[], f: AttendanceField) => (idx[f] === -1 ? "" : (r[idx[f]] ?? "").trim());
  const rows: AttendanceRow[] = data.map((r, n) => {
    const line = n + 2;
    const personId = cell(r, "personId").toLowerCase();
    const email = cell(r, "email").toLowerCase();
    const start = readStart(cell(r, "startDateTime"), cell(r, "startDate"), cell(r, "startTime"));
    const endRaw = cell(r, "endTime");
    const rawStatus = cell(r, "status");
    const row: AttendanceRow = {
      sourceRowId: cell(r, "sourceRowId") || `row:${line}`,
      line,
      personKey: personId || email,
      personId,
      email,
      personName: cell(r, "name"),
      className: cell(r, "className"),
      startLocal: "local" in start ? start.local : null,
      endLocalTime: endRaw ? readTime(endRaw) : null,
      status: resolveStatus(rawStatus, cell(r, "attended")),
      rawStatus,
    };
    if ("issue" in start) row.dateIssue = start.issue;
    return row;
  });

  return { rows, errors: [], mappedColumns, unmappedColumns, blankColumns };
}

// ── Plan ───────────────────────────────────────────────────────────────────

export type PlanMember = {
  id: string;
  email: string;
  name: string;
  /** The previous platform's customer ids for this member (lower-cased on compare). Supplied by the caller — MatFlow has no column for it yet. */
  sourceIds?: string[];
};

export type PlanClass = {
  id: string;
  name: string;
  /** Minutes; gives the session an end when the export has no end time. */
  duration?: number;
  /** Other names the export uses for this class. */
  aliases?: string[];
};

export type PlannedSession = {
  /** `class:<classId>@<UTC ISO start>`, or `name:<normalised name>@<UTC ISO start>` for an unmatched class — stable across runs. */
  key: string;
  classId: string | null;
  className: string;
  startUtc: string;
  endUtc?: string;
  /** Club calendar date, for `ClassInstance.date` (via dayMarkerUtc). */
  localDate: string;
  /** Club wall clock "HH:mm", for `ClassInstance.startTime`. */
  startTime: string;
  endTime?: string;
};

export type PlannedRecord = {
  /** `<sessionKey>#<memberId>` — the same pair as `AttendanceRecord @@unique([memberId, classInstanceId])`. */
  key: string;
  memberId: string;
  sessionKey: string;
  /** The session's start: the export carries no actual check-in instant. */
  checkInTimeUtc: string;
  checkInMethod: "import";
  /** Provenance: the kept row first, then any duplicates collapsed into it. */
  sourceRowIds: string[];
};

export type QuarantineReason =
  | "missing_date"
  | "missing_time"
  | "malformed_date"
  | "offset_not_supported"
  | "nonexistent_local_time"
  | "missing_status"
  | "unknown_status"
  | "conflicting_status"
  | "no_person_key"
  | "unresolved_person"
  | "ambiguous_email"
  | "email_name_mismatch"
  | "missing_class"
  | "unknown_class"
  | "ambiguous_class";

export type ExclusionReason =
  | "booked"
  | "cancelled"
  | "late_cancel"
  | "no_show"
  | "waitlisted"
  | "not_attended"
  | "duplicate";

export type MonthTotals = { records: number; excluded: number; quarantined: number };

export type AttendancePlan = {
  sessions: PlannedSession[];
  records: PlannedRecord[];
  quarantined: { sourceRowId: string; line: number; reason: QuarantineReason; detail?: string }[];
  excluded: { sourceRowId: string; line: number; reason: ExclusionReason; detail?: string }[];
  totals: {
    inputRows: number;
    /** Records per club-local month "YYYY-MM" ("unknown" when the date could not be read). */
    byMonth: Record<string, MonthTotals>;
    byPerson: Record<string, number>;
    bySession: Record<string, number>;
    attended: number;
    excluded: number;
    quarantined: number;
    duplicates: number;
  };
};

function localWallClock(instant: Date, timeZone: string): string {
  const l = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${l.getUTCFullYear()}-${p(l.getUTCMonth() + 1)}-${p(l.getUTCDate())} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
}

/**
 * Club wall clock → UTC. Returns null for a time that does not exist locally
 * (the spring-forward hour). In the autumn repeated hour the wall clock is
 * ambiguous; `parseTime` resolves it deterministically (see the tests for
 * which instant) — the runbook asks clubs to confirm any session in that hour.
 */
export function localToUtc(local: string, timeZone: string): Date | null {
  const [date, time] = local.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const instant = parseTime(time, new Date(Date.UTC(y, m - 1, d)), timeZone);
  return localWallClock(instant, timeZone) === local ? instant : null;
}

function assertTimezone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date(0));
  } catch {
    // Never fall back to a default here: a wrong zone shifts every imported session.
    throw new Error(`planAttendanceImport: "${timeZone}" is not a valid IANA timezone.`);
  }
}

export function planAttendanceImport(
  rows: AttendanceRow[],
  opts: { members: PlanMember[]; classes: PlanClass[]; timezone: string },
): AttendancePlan {
  const { timezone } = opts;
  assertTimezone(timezone);

  const bySourceId = new Map<string, PlanMember[]>();
  const byEmail = new Map<string, PlanMember[]>();
  for (const m of opts.members) {
    for (const s of m.sourceIds ?? []) {
      const k = s.trim().toLowerCase();
      if (k) bySourceId.set(k, [...(bySourceId.get(k) ?? []), m]);
    }
    const e = m.email.trim().toLowerCase();
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), m]);
  }
  const byClassName = new Map<string, PlanClass[]>();
  for (const c of opts.classes) {
    for (const n of new Set([c.name, ...(c.aliases ?? [])].map(norm))) {
      if (n) byClassName.set(n, [...(byClassName.get(n) ?? []), c]);
    }
  }

  const sessions = new Map<string, PlannedSession>();
  const records = new Map<string, PlannedRecord>();
  const plan: AttendancePlan = {
    sessions: [],
    records: [],
    quarantined: [],
    excluded: [],
    totals: { inputRows: rows.length, byMonth: {}, byPerson: {}, bySession: {}, attended: 0, excluded: 0, quarantined: 0, duplicates: 0 },
  };
  const month = (local: string | null) => {
    const k = local ? local.slice(0, 7) : "unknown";
    return (plan.totals.byMonth[k] ??= { records: 0, excluded: 0, quarantined: 0 });
  };
  const quarantine = (r: AttendanceRow, reason: QuarantineReason, detail?: string) => {
    plan.quarantined.push({ sourceRowId: r.sourceRowId, line: r.line, reason, ...(detail ? { detail } : {}) });
    month(r.startLocal).quarantined += 1;
  };
  const exclude = (r: AttendanceRow, reason: ExclusionReason, detail?: string) => {
    plan.excluded.push({ sourceRowId: r.sourceRowId, line: r.line, reason, ...(detail ? { detail } : {}) });
    month(r.startLocal).excluded += 1;
  };

  for (const r of rows) {
    // 1. Status first: a cancelled row needs nothing else resolved.
    switch (r.status) {
      case "booked": case "cancelled": case "late_cancel": case "no_show": case "waitlisted": case "not_attended":
        exclude(r, r.status, r.rawStatus || undefined);
        continue;
      case "missing": quarantine(r, "missing_status"); continue;
      case "unknown": quarantine(r, "unknown_status", r.rawStatus || undefined); continue;
      case "conflict": quarantine(r, "conflicting_status", r.rawStatus || undefined); continue;
      case "attended": break;
    }

    // 2. When.
    if (r.dateIssue || !r.startLocal) { quarantine(r, r.dateIssue ?? "malformed_date"); continue; }
    const start = localToUtc(r.startLocal, timezone);
    if (!start) { quarantine(r, "nonexistent_local_time", `${r.startLocal} does not exist in ${timezone}`); continue; }

    // 3. Who. Source id, then email; never name.
    let member: PlanMember | undefined;
    if (!r.personId && !r.email) { quarantine(r, "no_person_key"); continue; }
    const idHits = r.personId ? bySourceId.get(r.personId) ?? [] : [];
    if (idHits.length === 1) member = idHits[0];
    else if (r.email) {
      const hits = byEmail.get(r.email) ?? [];
      if (hits.length > 1) { quarantine(r, "ambiguous_email", r.email); continue; }
      if (hits.length === 1) {
        if (r.personName && norm(r.personName) !== norm(hits[0].name)) {
          quarantine(r, "email_name_mismatch", `${r.personName} ≠ ${hits[0].name}`);
          continue;
        }
        member = hits[0];
      }
    }
    if (!member) { quarantine(r, "unresolved_person", r.personKey); continue; }

    // 4. Which class. The session exists even when the class does not.
    if (!r.className) { quarantine(r, "missing_class"); continue; }
    const classHits = byClassName.get(norm(r.className)) ?? [];
    const cls = classHits.length === 1 ? classHits[0] : null;
    const startUtc = start.toISOString();
    // Keyed on the class, not the spelling, so an alias and the class's own
    // name at the same instant are one session (one ClassInstance slot).
    const sessionKey = cls ? `class:${cls.id}@${startUtc}` : `name:${norm(r.className)}@${startUtc}`;
    let session = sessions.get(sessionKey);
    if (!session) {
      const [localDate, startTime] = r.startLocal.split(" ");
      session = { key: sessionKey, classId: cls?.id ?? null, className: cls?.name ?? r.className, startUtc, localDate, startTime };
      if (r.endLocalTime) {
        const end = localToUtc(`${localDate} ${r.endLocalTime}`, timezone);
        if (end && end > start) { session.endUtc = end.toISOString(); session.endTime = r.endLocalTime; }
      } else if (cls?.duration) {
        const end = new Date(start.getTime() + cls.duration * 60_000);
        session.endUtc = end.toISOString();
        session.endTime = localWallClock(end, timezone).slice(11);
      }
      sessions.set(sessionKey, session);
    }
    if (!cls) { quarantine(r, classHits.length > 1 ? "ambiguous_class" : "unknown_class", r.className); continue; }

    // 5. Once per person per session.
    const key = `${sessionKey}#${member.id}`;
    const existing = records.get(key);
    if (existing) {
      existing.sourceRowIds.push(r.sourceRowId);
      plan.totals.duplicates += 1;
      exclude(r, "duplicate", key);
      continue;
    }
    records.set(key, { key, memberId: member.id, sessionKey, checkInTimeUtc: startUtc, checkInMethod: "import", sourceRowIds: [r.sourceRowId] });
    month(r.startLocal).records += 1;
    plan.totals.byPerson[member.id] = (plan.totals.byPerson[member.id] ?? 0) + 1;
    plan.totals.bySession[sessionKey] = (plan.totals.bySession[sessionKey] ?? 0) + 1;
  }

  const byKey = <T extends { key: string }>(a: T, b: T) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  plan.sessions = [...sessions.values()].sort(byKey);
  plan.records = [...records.values()].sort(byKey);
  plan.totals.attended = plan.records.length;
  plan.totals.excluded = plan.excluded.length;
  plan.totals.quarantined = plan.quarantined.length;
  return plan;
}

/** `ClassInstance.date` for a planned session — the one spelling of its calendar day. */
export function sessionDayMarker(session: Pick<PlannedSession, "localDate">): Date {
  return dayMarkerUtc(new Date(`${session.localDate}T00:00:00Z`));
}
