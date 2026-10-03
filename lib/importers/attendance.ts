/**
 * Attendance history — a club's attendance export (TeamUp "attendance" report
 * and similar), parsed and PLANNED into a source-booking ledger. Pure: no
 * database, no network; the clock is passed in. The commit route
 * (app/api/admin/import/attendance) writes the plan.
 *
 * Contract (3 Oct 2026, from the real Total BJJ export — 26 columns, one row
 * per booking, every start instant carrying its offset):
 *  - EVERY booking is a source fact and is kept in the ledger
 *    (`ImportedBooking`) whatever its state: attended, registered, late
 *    cancelled, no show (and cancelled / waitlisted for other exports). Only an
 *    ATTENDED booking of a resolved person in a session that has started
 *    becomes attendance. Registered never proves attendance; a no-show or late
 *    cancel never becomes a payment or a penalty.
 *  - Times: an instant with an offset ("2025-10-04T09:00:00+01:00") is read as
 *    that exact instant and the raw cell is kept; the club calendar date and
 *    wall clock come from the club's IANA timezone, never the machine's. An
 *    export without offsets is read as club wall clock (DST-aware; a time that
 *    does not exist locally is rejected, never shifted). There is no
 *    `new Date(string)` fallback.
 *  - A person is identified by the source's own key: TeamUp exports carry no
 *    customer id, so the key is `teamup:<email>|<name>` — the derivation the
 *    members import stored as `Member.externalRef` (lib/importers/teamup.ts
 *    `teamupPersonKey`). Matching order: the owner's saved decision; the
 *    member whose externalRef is that key (or the export's customer id); one
 *    member whose name AND email both equal the row's. Name alone, email
 *    alone, a shared address, a date of birth or an emergency contact never
 *    identify anyone — they are offered as candidates only.
 *  - A session is (absolute start, offering mapping, venue mapping). Offerings
 *    sharing a start are different sessions unless the owner maps them to the
 *    same class. Nothing is deduplicated by start time alone.
 *  - A booking key is (person key, start instant, offering, venue) — never the
 *    status — so a later export that turns "registered" into "attended"
 *    updates the same booking. The row fingerprint is kept separately.
 *  - One visit per person per start instant: a second ATTENDED booking of the
 *    same person at the same instant (TeamUp lets a member book two offerings
 *    that run together) is kept as a booking and linked to the first visit,
 *    never counted twice.
 *  - Every input row lands in exactly one of: a planned booking, a duplicate
 *    of a booking earlier in the file, or a rejected row with its reason.
 *  - Nothing in the plan consumes a class credit, creates a payment, sends a
 *    message, changes a rank or touches a waiver: the plan types carry no field
 *    for any of those (tests/unit/import-attendance.test.ts).
 */
import { createHash } from "node:crypto";
import { parseCSV } from "./index";
import { teamupPersonKey } from "./teamup";
import { dayMarkerUtc, parseTime, zoneOffsetMs } from "@/lib/class-time";

// ── Parse ──────────────────────────────────────────────────────────────────

export type AttendanceField =
  | "sourceRowId"
  | "personId"
  | "email"
  | "name"
  | "className"
  | "venue"
  | "startDateTime"
  | "startDate"
  | "startTime"
  | "endTime"
  | "status"
  | "attended"
  | "instructors"
  | "bookingMethod"
  | "bookingSource"
  | "customerMembershipId"
  | "membershipId"
  | "membershipName"
  | "checkinAt";

/** Per field, the header names that may carry it (case-insensitive, exact, first match wins). */
export type AttendanceMapping = Record<AttendanceField, string[]>;

export const DEFAULT_ATTENDANCE_MAPPING: AttendanceMapping = {
  sourceRowId: ["attendance id", "booking id", "registration id", "id"],
  personId: ["customer id", "member id", "client id"],
  email: ["customer email", "email", "email address"],
  name: ["customer name", "name", "member name"],
  // "Offering Type Name" is TeamUp's attendance export (3 Oct 2026).
  className: ["offering type name", "event name", "class", "class name", "event", "offering"],
  venue: ["venue name", "venue", "location"],
  startDateTime: ["event starts at", "start", "start date time", "start datetime", "starts at"],
  startDate: ["start date", "date", "event date"],
  startTime: ["start time", "time"],
  endTime: ["end time"],
  status: ["status", "attendance status", "booking status"],
  attended: ["attended", "checked in", "attendance"],
  instructors: ["instructors", "instructor"],
  bookingMethod: ["booking method"],
  bookingSource: ["booking source"],
  customerMembershipId: ["customer membership id"],
  membershipId: ["membership id"],
  membershipName: ["membership name"],
  checkinAt: ["checkin timestamp", "check-in timestamp", "checked in at"],
};

/**
 * Profile columns an attendance export repeats on every row. Known, and
 * deliberately NOT imported: a member's profile is owned by the members
 * import and by the member; an attendance file never overwrites it, infers
 * consent from it, or makes a guardian from it. Reported as such, not as
 * "unmapped".
 */
export const PROFILE_COLUMNS = [
  "address line 1", "address line 2", "city", "region", "postcode", "country", "marketing preference",
  "phone", "gender", "date of birth", "emergency contact name", "emergency contact phone", "emergency contact relationship",
] as const;

/** The states a booking can be in. The first four are TeamUp's attendance vocabulary. */
export type BookingStatus = "attended" | "registered" | "late_cancelled" | "no_show" | "cancelled" | "waitlisted" | "not_attended";
export type AttendanceStatus = BookingStatus | "missing" | "unknown" | "conflict";

export type DateIssue = "missing_date" | "missing_time" | "malformed_date";

export type AttendanceRow = {
  /** The export's own row id when it has one, else `row:<record>`. */
  sourceRowId: string;
  /** CSV record ordinal, header = 1 (records, not physical lines). */
  record: number;
  /** Physical line the record starts on, header = 1. */
  line: number;
  /** sha256 of the record's cells (trimmed, joined) — provenance, not identity. */
  fingerprint: string;
  /** The source's person key: `teamup:<email>|<name>`, or `id:<customer id>` when the export has one. */
  personKey: string;
  personId: string;
  email: string;
  personName: string;
  className: string;
  venue: string;
  /** The start cell exactly as exported. */
  startRaw: string;
  /** UTC ISO instant when the cell carried an offset (or once resolved by the planner). */
  startInstant: string | null;
  /** "YYYY-MM-DD HH:mm" club wall clock, for exports without offsets. */
  startLocal: string | null;
  endLocalTime: string | null;
  dateIssue?: DateIssue;
  /** The record has a different number of cells from the header (a stray comma or an unterminated quote): never read. */
  malformed?: { cells: number; expected: number };
  status: AttendanceStatus;
  rawStatus: string;
  instructors: string;
  bookingMethod: string;
  bookingSource: string;
  customerMembershipRef: string;
  membershipRef: string;
  membershipName: string;
  /** Check-in timestamp cell; "" = not known. Never replaced by the session start. */
  checkinRaw: string;
};

export type AttendanceParseResult = {
  rows: AttendanceRow[];
  /** Fatal problems with the file as a whole (no rows are returned when present). */
  errors: string[];
  /** Which header each field was read from; null = not present. */
  mappedColumns: Record<AttendanceField, string | null>;
  /** Known profile columns present in the file, deliberately not imported. */
  notImportedColumns: string[];
  /** Headers present in the file that nothing reads — disclosed, never guessed at. */
  unmappedColumns: string[];
  /** Mapped headers that are blank on every data row, and header cells that are themselves blank (as `#<n>`). */
  blankColumns: string[];
};

const ATTENDED = new Set(["attended", "checked in", "checked-in", "present", "completed", "visited", "signed in"]);
const REGISTERED = new Set(["registered", "booked", "reserved", "confirmed", "booking"]);
const CANCELLED = new Set(["cancelled", "canceled", "cancelled by customer", "cancelled by staff"]);
const LATE_CANCEL = new Set(["late cancel", "late cancelled", "late canceled", "late-cancel", "late cancellation", "late_cancel"]);
const NO_SHOW = new Set(["no show", "no-show", "noshow", "no_show", "absent", "missed"]);
const WAITLIST = new Set(["waitlist", "waitlisted", "wait list", "waiting list"]);
const YES = new Set(["yes", "y", "true", "1", "attended", "checked in"]);
const NO = new Set(["no", "n", "false", "0"]);

export function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function statusWord(raw: string): AttendanceStatus | null {
  const t = norm(raw);
  if (!t) return null;
  if (ATTENDED.has(t)) return "attended";
  if (REGISTERED.has(t)) return "registered";
  if (CANCELLED.has(t)) return "cancelled";
  if (LATE_CANCEL.has(t)) return "late_cancelled";
  if (NO_SHOW.has(t)) return "no_show";
  if (WAITLIST.has(t)) return "waitlisted";
  return "unknown";
}

/**
 * Status column and attended flag together. A cancellation always stands; an
 * attended flag of "yes" upgrades a booking (some exports keep the booking
 * status and tick a flag); a status of attended with a flag of "no" is a
 * contradiction and is not resolved here.
 */
function resolveStatus(rawStatus: string, rawFlag: string): AttendanceStatus {
  const s = statusWord(rawStatus);
  const f = norm(rawFlag);
  const flag = !f ? null : YES.has(f) ? true : NO.has(f) ? false : undefined;
  if (flag === undefined) return "unknown";
  if (s === "cancelled" || s === "late_cancelled" || s === "waitlisted") return s;
  if (s === "unknown") return "unknown";
  if (s === "attended") return flag === false ? "conflict" : "attended";
  if (s === "no_show") return flag === true ? "conflict" : "no_show";
  if (s === "registered") return flag === true ? "attended" : "registered";
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

/**
 * An ISO-8601 instant WITH an explicit offset, e.g. "2025-10-04T09:00:00+01:00"
 * or "…Z". Returns the exact UTC instant, or null when the text is not one
 * (including impossible dates, hours, minutes or offsets). Never consults the
 * machine's timezone.
 */
export function parseOffsetInstant(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (!validYmd(y, mo, d) || h > 23 || mi > 59 || sec > 59) return null;
  const ms = m[7] ? Math.round(Number(m[7]) * 1000) : 0;
  let offsetMin = 0;
  if (m[8].toUpperCase() !== "Z") {
    const om = m[8].match(/^([+-])(\d{2}):?(\d{2})?$/)!;
    const oh = Number(om[2]);
    const omin = Number(om[3] ?? 0);
    if (oh > 14 || omin > 59) return null;
    offsetMin = (om[1] === "-" ? -1 : 1) * (oh * 60 + omin);
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offsetMin * 60_000);
}

type StartRead = { instant: string } | { local: string } | { issue: DateIssue };

function readStart(dateTimeCell: string, dateCell: string, timeCell: string): StartRead {
  const combined = dateTimeCell.trim() || dateCell.trim();
  if (!combined) return { issue: "missing_date" };
  // An instant with an offset is read as that instant.
  if (/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(combined) && /\d[T ]\d/.test(combined)) {
    const at = parseOffsetInstant(combined);
    return at ? { instant: at.toISOString() } : { issue: "malformed_date" };
  }
  const [datePart, ...rest] = combined.split(/[T\s]+/);
  const inlineTime = rest.join(" ");
  const date = readDate(datePart);
  if (!date) return { issue: "malformed_date" };
  const timeRaw = timeCell.trim() || inlineTime;
  if (!timeRaw) return { issue: "missing_time" };
  const time = readTime(timeRaw);
  if (!time) return { issue: "malformed_date" };
  return { local: `${date} ${time}` };
}

function fingerprintOf(cells: string[]): string {
  return createHash("sha256").update(cells.map((c) => (c ?? "").trim()).join("\u0001")).digest("hex");
}

export function parseAttendanceCsv(
  text: string,
  opts: { mapping?: Partial<AttendanceMapping> } = {},
): AttendanceParseResult {
  const mapping: AttendanceMapping = { ...DEFAULT_ATTENDANCE_MAPPING, ...opts.mapping };
  const fields = Object.keys(mapping) as AttendanceField[];
  const mappedColumns = Object.fromEntries(fields.map((k) => [k, null])) as Record<AttendanceField, string | null>;
  const empty: AttendanceParseResult = { rows: [], errors: [], mappedColumns, notImportedColumns: [], unmappedColumns: [], blankColumns: [] };

  const table = parseCSV(text.replace(/^﻿/, ""));
  if (table.length < 2) return { ...empty, errors: ["The file is empty or has no data rows."] };

  const headers = table[0].map((h) => h.replace(/^﻿/, "").trim());
  const lower = headers.map((h) => h.toLowerCase());
  const idx = {} as Record<AttendanceField, number>;
  const used = new Set<number>();
  // Specific fields claim their headers before generic ones ("start date" is a
  // startDate, not a startDateTime; "customer membership id" before "membership id").
  const order: AttendanceField[] = [
    "sourceRowId", "personId", "email", "name", "className", "venue", "customerMembershipId", "membershipId", "membershipName",
    "startDate", "startTime", "endTime", "startDateTime", "status", "attended", "instructors", "bookingMethod", "bookingSource", "checkinAt",
  ];
  for (const f of order) {
    idx[f] = -1;
    for (const c of mapping[f] ?? []) {
      const i = lower.indexOf(c.toLowerCase());
      if (i !== -1 && !used.has(i)) { idx[f] = i; used.add(i); break; }
    }
    mappedColumns[f] = idx[f] === -1 ? null : headers[idx[f]];
  }

  // A header that appears twice: which copy holds the data is unknowable.
  const seen = new Map<string, number>();
  for (const h of lower) if (h) seen.set(h, (seen.get(h) ?? 0) + 1);
  const repeated = [...seen.entries()].filter(([h, n]) => n > 1 && fields.some((f) => idx[f] !== -1 && lower[idx[f]] === h)).map(([h]) => headers[lower.indexOf(h)]);
  if (repeated.length) {
    return { ...empty, mappedColumns, errors: [`These columns appear more than once, so MatFlow cannot tell which copy to read: ${repeated.map((h) => `"${h}"`).join(", ")}. Export the report again without the duplicate columns.`] };
  }

  const profile = new Set<string>(PROFILE_COLUMNS);
  const notImportedColumns = headers.filter((h, i) => h !== "" && !used.has(i) && profile.has(lower[i]));
  const unmappedColumns = headers.filter((h, i) => h !== "" && !used.has(i) && !profile.has(lower[i]));
  const blankColumns: string[] = headers.flatMap((h, i) => (h === "" ? [`#${i + 1}`] : []));
  const data = table.slice(1);
  for (const f of order) {
    const i = idx[f];
    if (i !== -1 && data.every((r) => !(r[i] ?? "").trim())) blankColumns.push(headers[i]);
  }

  const missing: string[] = [];
  if (idx.className === -1) missing.push("class or offering (e.g. \"Offering Type Name\" or \"Event Name\")");
  if (idx.startDateTime === -1 && idx.startDate === -1) missing.push("start (e.g. \"Event Starts At\" or \"Start Date\")");
  if (idx.status === -1 && idx.attended === -1) missing.push("status or attended (e.g. \"Status\")");
  if (idx.personId === -1 && idx.email === -1 && idx.name === -1) missing.push("customer name, email or id (e.g. \"Customer Name\")");
  if (missing.length) {
    return { ...empty, mappedColumns, notImportedColumns, unmappedColumns, blankColumns, errors: [`Missing required column(s): ${missing.join("; ")}.`] };
  }

  const cell = (r: string[], f: AttendanceField) => (idx[f] === -1 ? "" : (r[idx[f]] ?? "").trim());
  const rows: AttendanceRow[] = data.map((r, n) => {
    const record = n + 2;
    const personId = cell(r, "personId");
    const email = cell(r, "email");
    const personName = cell(r, "name");
    const start = readStart(cell(r, "startDateTime"), cell(r, "startDate"), cell(r, "startTime"));
    const endRaw = cell(r, "endTime");
    const rawStatus = cell(r, "status");
    const row: AttendanceRow = {
      sourceRowId: cell(r, "sourceRowId") || `row:${record}`,
      record,
      line: (r as unknown as { line?: number }).line ?? record,
      fingerprint: fingerprintOf(r),
      personKey: personId ? `id:${personId.toLowerCase()}` : personName || email ? teamupPersonKey(personName, email) : "",
      personId,
      email: email.toLowerCase(),
      personName,
      className: cell(r, "className"),
      venue: cell(r, "venue"),
      startRaw: cell(r, "startDateTime") || [cell(r, "startDate"), cell(r, "startTime")].filter(Boolean).join(" "),
      startInstant: "instant" in start ? start.instant : null,
      startLocal: "local" in start ? start.local : null,
      endLocalTime: endRaw ? readTime(endRaw) : null,
      status: resolveStatus(rawStatus, cell(r, "attended")),
      rawStatus,
      instructors: cell(r, "instructors"),
      bookingMethod: cell(r, "bookingMethod"),
      bookingSource: cell(r, "bookingSource"),
      customerMembershipRef: cell(r, "customerMembershipId"),
      membershipRef: cell(r, "membershipId"),
      membershipName: cell(r, "membershipName"),
      checkinRaw: cell(r, "checkinAt"),
    };
    if ("issue" in start) row.dateIssue = start.issue;
    if (r.length !== headers.length) row.malformed = { cells: r.length, expected: headers.length };
    return row;
  });

  return { rows, errors: [], mappedColumns, notImportedColumns, unmappedColumns, blankColumns };
}

// ── Time ───────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD HH:mm" — an instant on the club's wall clock. */
export function localWallClock(instant: Date, timeZone: string): string {
  const l = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${l.getUTCFullYear()}-${p(l.getUTCMonth() + 1)}-${p(l.getUTCDate())} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
}

/**
 * Club wall clock → UTC. Returns null for a time that does not exist locally
 * (the spring-forward hour). In the autumn repeated hour the wall clock is
 * ambiguous; `parseTime` resolves it deterministically.
 */
export function localToUtc(local: string, timeZone: string): Date | null {
  const [date, time] = local.split(" ");
  const [y, m, d] = date.split("-").map(Number);
  const instant = parseTime(time, new Date(Date.UTC(y, m - 1, d)), timeZone);
  return localWallClock(instant, timeZone) === local ? instant : null;
}

export function assertTimezone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone }).format(new Date(0));
  } catch {
    // Never fall back to a default here: a wrong zone shifts every imported session.
    throw new Error(`attendance import: "${timeZone}" is not a valid IANA timezone.`);
  }
}

/** `ClassInstance.date` for a club calendar date — the one spelling of its day. */
export function dayMarkerFor(localDate: string): Date {
  return dayMarkerUtc(new Date(`${localDate}T00:00:00Z`));
}

// ── Plan ───────────────────────────────────────────────────────────────────

export type RosterMember = { id: string; name: string; email: string; externalRef: string | null; noLogin?: boolean };
export type RosterClass = { id: string; name: string; isActive: boolean; historical: boolean; locationId: string | null };
export type RosterLocation = { id: string; name: string };

export type PersonDecision = { action: "member"; targetId: string } | { action: "pending" };
export type OfferingDecision = { action: "class"; targetId: string } | { action: "new_class"; targetId?: string | null } | { action: "pending" };
export type VenueDecision = { action: "location"; targetId: string } | { action: "club" } | { action: "pending" };

export type PlanDecisions = {
  person: Record<string, PersonDecision>;
  offering: Record<string, OfferingDecision>;
  venue: Record<string, VenueDecision>;
};

export type MatchMethod = "decision" | "external_ref" | "name_and_email";

/** What a booking will become if committed now. */
export type BookingIntent =
  | "attendance"
  | "same_start_visit"
  | "booking_only"
  | "future"
  | "pending_person"
  | "pending_offering"
  | "pending_venue"
  | "venue_conflict"
  /** The source contradicts itself: one booking with two statuses in one file, or two different instants that the club's wall clock (and so a session slot) cannot tell apart — the autumn repeated hour. Held, never guessed. */
  | "source_conflict";

export type PlannedBooking = {
  bookingKey: string;
  personKey: string;
  record: number;
  line: number;
  fingerprint: string;
  sourceName: string;
  sourceEmail: string;
  startUtc: string;
  startRaw: string;
  localDate: string;
  localTime: string;
  offeringLabel: string;
  venueLabel: string;
  status: BookingStatus;
  rawStatus: string;
  instructors: string;
  bookingMethod: string;
  bookingSource: string;
  customerMembershipRef: string;
  membershipRef: string;
  membershipName: string;
  checkinRaw: string;
  memberId: string | null;
  matchMethod: MatchMethod | null;
  /** Class this booking's session sits in: an existing class id, or `new:<offering>|<venue>` for one the commit creates. */
  classKey: string | null;
  /** `<classKey>@<localDate> <localTime>` — one session. */
  sessionKey: string | null;
  intent: BookingIntent;
  /** For `source_conflict`: why. */
  conflict?: "status" | "repeated_local_time";
  /** For `same_start_visit`: the booking whose visit this one is. */
  visitOf?: string;
};

export type RejectReason = DateIssue | "malformed_row" | "nonexistent_local_time" | "missing_status" | "unknown_status" | "conflicting_status" | "no_person" | "missing_class";

export type PlanPerson = {
  personKey: string;
  name: string;
  email: string;
  bookings: number;
  attended: number;
  memberId: string | null;
  matchMethod: MatchMethod | null;
  /** Decision recorded as "keep pending". */
  decidedPending: boolean;
  /** Suggestions only — never applied without an owner's decision. */
  candidates: { memberId: string; reason: "same_name" | "same_email" }[];
  sharedEmail: boolean;
  missingEmail: boolean;
};

export type PlanOffering = {
  label: string;
  bookings: number;
  attended: number;
  decision: OfferingDecision | null;
  /** An active class with exactly this name (suggestion). */
  suggestedClassId: string | null;
};

export type PlanVenue = { label: string; bookings: number; decision: VenueDecision | null; suggestedLocationId: string | null };

export type PlanSession = {
  /** Provisional source session: start instant + offering + venue. */
  sourceKey: string;
  sessionKey: string | null;
  startUtc: string;
  offeringLabel: string;
  venueLabel: string;
  bookings: number;
  attended: number;
  /** resolved = will hold attendance; pending = offering / venue not mapped; future = not started; no_attendance = nobody attended who resolves. */
  state: "resolved" | "pending" | "future" | "no_attendance";
};

export type AttendancePlan = {
  bookings: PlannedBooking[];
  duplicates: { record: number; line: number; bookingKey: string; duplicateOf: number }[];
  rejected: { record: number; line: number; reason: RejectReason; detail?: string }[];
  people: PlanPerson[];
  offerings: PlanOffering[];
  venues: PlanVenue[];
  sessions: PlanSession[];
  totals: {
    inputRows: number;
    byStatus: Record<string, number>;
    byIntent: Record<string, number>;
    reconciles: boolean;
  };
};

export function bookingKeyOf(personKey: string, startUtc: string, offering: string, venue: string): string {
  return createHash("sha256").update(["booking", personKey, startUtc, norm(offering), norm(venue)].join("\u0001")).digest("hex");
}

export function planAttendanceImport(
  rows: AttendanceRow[],
  opts: {
    timezone: string;
    now: Date;
    members: RosterMember[];
    classes: RosterClass[];
    locations: RosterLocation[];
    decisions: PlanDecisions;
    /** True when a member's email is a synthesised no-login address (lib/synthesise-kid-email): never matched on. */
    isSynthesisedEmail: (email: string) => boolean;
    /** Classes a commit already created for `new:` class keys (classKey -> class id), so every step resolves them alike. */
    createdClasses?: Record<string, string>;
  },
): AttendancePlan {
  const { timezone, decisions } = opts;
  assertTimezone(timezone);
  const synthetic = opts.isSynthesisedEmail;

  const memberById = new Map(opts.members.map((m) => [m.id, m]));
  const byRef = new Map<string, RosterMember[]>();
  const byNameEmail = new Map<string, RosterMember[]>();
  const byName = new Map<string, RosterMember[]>();
  const byEmail = new Map<string, RosterMember[]>();
  const push = <K,>(m: Map<K, RosterMember[]>, k: K, v: RosterMember) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const m of opts.members) {
    if (m.externalRef) push(byRef, m.externalRef.trim().toLowerCase(), m);
    const email = synthetic(m.email) ? "" : m.email.trim().toLowerCase();
    push(byName, norm(m.name), m);
    if (email) { push(byEmail, email, m); push(byNameEmail, `${norm(m.name)}|${email}`, m); }
  }
  const classById = new Map(opts.classes.map((c) => [c.id, c]));
  const locationIds = new Set(opts.locations.map((l) => l.id));

  // Who is each person? Resolved once per person key.
  type Resolved = { memberId: string | null; method: MatchMethod | null; decidedPending: boolean };
  const resolved = new Map<string, Resolved>();
  const resolvePerson = (r: AttendanceRow): Resolved => {
    const hit = resolved.get(r.personKey);
    if (hit) return hit;
    let out: Resolved = { memberId: null, method: null, decidedPending: false };
    const d = decisions.person[r.personKey];
    if (d?.action === "member" && memberById.has(d.targetId)) out = { memberId: d.targetId, method: "decision", decidedPending: false };
    // A decision whose member no longer exists, or "keep pending": pending — never re-matched behind the owner's back.
    else if (d) out = { memberId: null, method: null, decidedPending: true };
    else {
      const refHits = [
        ...(byRef.get(r.personKey) ?? []),
        ...(r.personId ? byRef.get(r.personId.toLowerCase()) ?? [] : []),
      ];
      const uniq = [...new Map(refHits.map((m) => [m.id, m])).values()];
      if (uniq.length === 1) out = { memberId: uniq[0].id, method: "external_ref", decidedPending: false };
      else if (uniq.length === 0 && r.email && r.personName) {
        const ne = byNameEmail.get(`${norm(r.personName)}|${r.email}`) ?? [];
        if (ne.length === 1) out = { memberId: ne[0].id, method: "name_and_email", decidedPending: false };
      }
    }
    resolved.set(r.personKey, out);
    return out;
  };

  const plan: AttendancePlan = {
    bookings: [], duplicates: [], rejected: [], people: [], offerings: [], venues: [], sessions: [],
    totals: { inputRows: rows.length, byStatus: {}, byIntent: {}, reconciles: false },
  };
  const bump = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };

  const byKey = new Map<string, PlannedBooking>();
  const people = new Map<string, PlanPerson>();
  const offerings = new Map<string, PlanOffering>();
  const venues = new Map<string, PlanVenue>();
  const sessions = new Map<string, PlanSession>();

  for (const r of rows) {
    bump(plan.totals.byStatus, r.rawStatus || "(blank)");
    const reject = (reason: RejectReason, detail?: string) => plan.rejected.push({ record: r.record, line: r.line, reason, ...(detail ? { detail } : {}) });
    if (r.malformed) { reject("malformed_row", `${r.malformed.cells} cells, header has ${r.malformed.expected}`); continue; }
    if (r.status === "missing") { reject("missing_status"); continue; }
    if (r.status === "unknown") { reject("unknown_status", r.rawStatus); continue; }
    if (r.status === "conflict") { reject("conflicting_status", r.rawStatus); continue; }
    if (r.dateIssue) { reject(r.dateIssue, r.startRaw); continue; }
    let start: Date | null = r.startInstant ? new Date(r.startInstant) : null;
    if (!start && r.startLocal) {
      start = localToUtc(r.startLocal, timezone);
      if (!start) { reject("nonexistent_local_time", `${r.startLocal} does not exist in ${timezone}`); continue; }
    }
    if (!start) { reject("malformed_date", r.startRaw); continue; }
    if (!r.personKey) { reject("no_person"); continue; }
    if (!r.className) { reject("missing_class"); continue; }

    const startUtc = start.toISOString();
    const [localDate, localTime] = localWallClock(start, timezone).split(" ");
    const bookingKey = bookingKeyOf(r.personKey, startUtc, r.className, r.venue);
    const first = byKey.get(bookingKey);
    if (first) {
      plan.duplicates.push({ record: r.record, line: r.line, bookingKey, duplicateOf: first.record });
      // The same booking twice with different statuses: which is true is unknowable from the file.
      if (first.status !== r.status) { first.intent = "source_conflict"; first.conflict = "status"; }
      continue;
    }

    const who = resolvePerson(r);
    const status = r.status as BookingStatus;

    // Offering and venue as the owner mapped them.
    const od = decisions.offering[r.className] ?? null;
    const vd = decisions.venue[r.venue] ?? null;
    const venueKey = vd?.action === "location" && locationIds.has(vd.targetId) ? `loc:${vd.targetId}` : vd?.action === "club" ? "club" : null;
    let classKey: string | null = null;
    let venueConflict = false;
    if (od?.action === "class" && classById.has(od.targetId)) {
      classKey = od.targetId;
      const cls = classById.get(od.targetId)!;
      // A class that runs at one venue cannot hold a session the export places at another.
      if (venueKey?.startsWith("loc:") && cls.locationId && `loc:${cls.locationId}` !== venueKey) venueConflict = true;
    } else if (od?.action === "new_class") {
      classKey = od.targetId && classById.has(od.targetId) ? od.targetId : venueKey ? `new:${norm(r.className)}|${venueKey}` : null;
      if (classKey && opts.createdClasses?.[classKey]) classKey = opts.createdClasses[classKey];
    }

    let intent: BookingIntent;
    if (!od || od.action === "pending" || (od.action === "class" && !classById.has(od.targetId))) intent = "pending_offering";
    else if (!venueKey) intent = "pending_venue";
    else if (venueConflict) intent = "venue_conflict";
    else if (start.getTime() > opts.now.getTime()) intent = "future";
    else if (!who.memberId) intent = "pending_person";
    else intent = status === "attended" ? "attendance" : "booking_only";
    const sessionKey = classKey && intent !== "pending_offering" && intent !== "pending_venue" && intent !== "venue_conflict" ? `${classKey}@${localDate} ${localTime}` : null;

    const b: PlannedBooking = {
      bookingKey, personKey: r.personKey, record: r.record, line: r.line, fingerprint: r.fingerprint,
      sourceName: r.personName, sourceEmail: r.email, startUtc, startRaw: r.startRaw, localDate, localTime,
      offeringLabel: r.className, venueLabel: r.venue, status, rawStatus: r.rawStatus,
      instructors: r.instructors, bookingMethod: r.bookingMethod, bookingSource: r.bookingSource,
      customerMembershipRef: r.customerMembershipRef, membershipRef: r.membershipRef, membershipName: r.membershipName,
      checkinRaw: r.checkinRaw, memberId: who.memberId, matchMethod: who.method, classKey, sessionKey, intent,
    };
    byKey.set(bookingKey, b);

    // Rollups.
    const p = people.get(r.personKey) ?? {
      personKey: r.personKey, name: r.personName, email: r.email, bookings: 0, attended: 0,
      memberId: who.memberId, matchMethod: who.method, decidedPending: who.decidedPending, candidates: [], sharedEmail: false, missingEmail: !r.email,
    };
    p.bookings += 1;
    if (status === "attended") p.attended += 1;
    people.set(r.personKey, p);
    const o = offerings.get(r.className) ?? { label: r.className, bookings: 0, attended: 0, decision: od, suggestedClassId: null };
    o.bookings += 1;
    if (status === "attended") o.attended += 1;
    offerings.set(r.className, o);
    const v = venues.get(r.venue) ?? { label: r.venue, bookings: 0, decision: vd, suggestedLocationId: null };
    v.bookings += 1;
    venues.set(r.venue, v);
    const sk = `${startUtc}|${norm(r.className)}|${norm(r.venue)}`;
    const s = sessions.get(sk) ?? { sourceKey: sk, sessionKey, startUtc, offeringLabel: r.className, venueLabel: r.venue, bookings: 0, attended: 0, state: "no_attendance" as PlanSession["state"] };
    s.bookings += 1;
    if (status === "attended") s.attended += 1;
    sessions.set(sk, s);
  }

  // Two different instants in one session slot (class + club date + wall
  // clock): only the autumn repeated hour can do it. A session slot cannot
  // hold both, so neither is attached to a session.
  const instantsBySlot = new Map<string, Set<string>>();
  for (const b of byKey.values()) if (b.sessionKey) instantsBySlot.set(b.sessionKey, (instantsBySlot.get(b.sessionKey) ?? new Set()).add(b.startUtc));
  for (const b of byKey.values()) {
    if (b.sessionKey && (instantsBySlot.get(b.sessionKey)?.size ?? 0) > 1 && b.intent !== "source_conflict") { b.intent = "source_conflict"; b.conflict = "repeated_local_time"; }
  }

  // One visit per person per start instant. Deterministic: the booking whose
  // key sorts first keeps the visit; the others link to it.
  const bookings = [...byKey.values()].sort((a, b) => (a.bookingKey < b.bookingKey ? -1 : a.bookingKey > b.bookingKey ? 1 : 0));
  const visitAt = new Map<string, string>();
  for (const b of bookings) {
    if (b.intent !== "attendance" || !b.memberId) continue;
    const k = `${b.memberId}@${b.startUtc}`;
    const owner = visitAt.get(k);
    if (owner) { b.intent = "same_start_visit"; b.visitOf = owner; }
    else visitAt.set(k, b.bookingKey);
  }
  plan.bookings = bookings;

  // Session states, from the bookings in them.
  const sessionState = new Map<string, PlanSession["state"]>();
  for (const b of bookings) {
    const sk = `${b.startUtc}|${norm(b.offeringLabel)}|${norm(b.venueLabel)}`;
    const cur = sessionState.get(sk);
    const next: PlanSession["state"] =
      b.intent === "pending_offering" || b.intent === "pending_venue" || b.intent === "venue_conflict" || b.intent === "source_conflict" ? "pending"
      : b.intent === "future" ? "future"
      : b.intent === "attendance" ? "resolved"
      : "no_attendance";
    const rank = { resolved: 3, pending: 2, future: 1, no_attendance: 0 } as const;
    if (!cur || rank[next] > rank[cur]) sessionState.set(sk, next);
  }
  for (const s of sessions.values()) s.state = sessionState.get(s.sourceKey) ?? "no_attendance";

  // Suggestions for people nobody has decided about. Never applied.
  const emailHolders = new Map<string, number>();
  for (const p of people.values()) if (p.email) emailHolders.set(p.email, (emailHolders.get(p.email) ?? 0) + 1);
  for (const p of people.values()) {
    p.sharedEmail = !!p.email && (emailHolders.get(p.email) ?? 0) > 1;
    if (p.memberId) continue;
    const cands = new Map<string, "same_name" | "same_email">();
    for (const m of byName.get(norm(p.name)) ?? []) cands.set(m.id, "same_name");
    if (p.email) for (const m of byEmail.get(p.email) ?? []) if (!cands.has(m.id)) cands.set(m.id, "same_email");
    p.candidates = [...cands.entries()].slice(0, 5).map(([memberId, reason]) => ({ memberId, reason }));
  }
  for (const o of offerings.values()) {
    const hits = opts.classes.filter((c) => c.isActive && !c.historical && norm(c.name) === norm(o.label));
    o.suggestedClassId = hits.length === 1 ? hits[0].id : null;
  }
  for (const v of venues.values()) {
    const hits = opts.locations.filter((l) => norm(l.name) === norm(v.label));
    v.suggestedLocationId = hits.length === 1 ? hits[0].id : null;
  }

  const byLabel = <T extends { label: string }>(a: T, b: T) => a.label.localeCompare(b.label);
  plan.people = [...people.values()].sort((a, b) => (a.personKey < b.personKey ? -1 : 1));
  plan.offerings = [...offerings.values()].sort(byLabel);
  plan.venues = [...venues.values()].sort(byLabel);
  plan.sessions = [...sessions.values()].sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1));
  for (const b of bookings) bump(plan.totals.byIntent, b.intent);
  plan.totals.reconciles = bookings.length + plan.duplicates.length + plan.rejected.length === rows.length;
  return plan;
}

/**
 * The source controls of a parsed file, counted from the rows alone — the
 * figures an owner (or an independent script) checks against the export.
 */
export function attendanceControls(rows: AttendanceRow[]) {
  const count = (f: (r: AttendanceRow) => string) => {
    const m: Record<string, number> = {};
    for (const r of rows) { const k = f(r); m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  const emailOf = new Map<string, string>();
  for (const r of rows) if (r.personKey && !emailOf.has(r.personKey)) emailOf.set(r.personKey, r.email);
  const identities = new Set(emailOf.keys());
  const emailsByIdentity = new Map<string, number>();
  for (const e of emailOf.values()) if (e) emailsByIdentity.set(e, (emailsByIdentity.get(e) ?? 0) + 1);
  const instants = rows.map((r) => r.startInstant).filter((x): x is string => !!x).sort();
  const offsetOf = (raw: string) => raw.match(/(Z|[+-]\d{2}:?\d{2})$/i)?.[1] ?? "none";
  return {
    rows: rows.length,
    byStatus: count((r) => r.rawStatus || "(blank)"),
    identities: identities.size,
    distinctEmails: emailsByIdentity.size,
    sharedEmails: [...emailsByIdentity.values()].filter((n) => n > 1).length,
    missingEmailRows: rows.filter((r) => !r.email).length,
    missingEmailIdentities: new Set(rows.filter((r) => !r.email).map((r) => r.personKey)).size,
    offerings: Object.keys(count((r) => r.className)).length,
    venues: Object.keys(count((r) => r.venue)).length,
    distinctStarts: new Set(rows.map((r) => r.startInstant ?? r.startLocal ?? "")).size,
    provisionalSessions: new Set(rows.map((r) => `${r.startInstant ?? r.startLocal}|${norm(r.className)}|${norm(r.venue)}`)).size,
    byBookingMethod: count((r) => r.bookingMethod || "(blank)"),
    byBookingSource: count((r) => r.bookingSource || "(blank)"),
    customerMembershipRefs: new Set(rows.map((r) => r.customerMembershipRef).filter(Boolean)).size,
    membershipRefs: new Set(rows.map((r) => r.membershipRef).filter(Boolean)).size,
    instructorsBlankRows: rows.filter((r) => !r.instructors).length,
    checkinBlankRows: rows.filter((r) => !r.checkinRaw).length,
    byOffset: count((r) => offsetOf(r.startRaw)),
    firstStart: instants[0] ?? null,
    lastStart: instants[instants.length - 1] ?? null,
  };
}
