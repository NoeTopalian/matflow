/**
 * Which kind of CSV is this, from its header row alone?
 *
 * Two operator failures on 3 Oct 2026 (Total BJJ handover) had one cause: the
 * import route trusts the Source the owner picked and never looks at the file.
 *  - A TeamUp memberships export uploaded under Source "Generic CSV" (the
 *    panel's default) reached the generic parser, which knows "name" / "email"
 *    but not "Customer Name" / "Customer Email", and answered one error —
 *    "Couldn't find name or email columns" — with totalRows 1
 *    (lib/importers/index.ts parseRowsWithMap; preview totalRows =
 *    drafts + errors = 0 + 1).
 *  - The same file uploaded to the attendance import answered "Missing
 *    required column(s): class (e.g. "Event Name")"
 *    (lib/importers/attendance.ts parseAttendanceCsv).
 * Both are true and neither tells the owner what to do. This reads the header
 * and names the file, so the upload routes can refuse the wrong path with the
 * right instruction and the panel can pick the right source for the owner.
 *
 * Deliberately dependency-free: the Import panel runs it in the browser on the
 * first 4 KB of the chosen file. The header names below mirror the parsers'
 * own (lib/importers/teamup.ts `H`, lib/importers/attendance.ts
 * DEFAULT_ATTENDANCE_MAPPING, lib/importers/index.ts HEADER_MAPS);
 * tests/unit/import-sniff.test.ts pins sniff against the parsers so the two
 * cannot drift apart.
 */

export type CsvKind = "teamup_memberships" | "teamup_attendance" | "generic_members" | "unknown";

/** TeamUp memberships export: the three columns lib/importers/teamup.ts refuses to run without. */
const TEAMUP_MEMBERSHIPS_REQUIRED = ["customer name", "membership name", "status"] as const;

/**
 * Attendance export: one header from each group lib/importers/attendance.ts
 * requires. The class group leaves out the bare word "class", which the
 * attendance parser also accepts: a generic member list may well carry a
 * "Class" column, and refusing a valid member file is worse than not
 * recognising an unusual attendance one (it then simply fails the member
 * parser, as before).
 */
const ATTENDANCE_CLASS = ["event name", "class name", "event"];
const ATTENDANCE_START = ["start", "start date time", "start datetime", "starts at", "start date", "date", "event date"];
const ATTENDANCE_STATUS = ["status", "attendance status", "booking status", "attended", "checked in", "attendance"];
const ATTENDANCE_PERSON = ["customer id", "member id", "client id", "customer email", "email", "email address"];

/** Generic / MindBody / Glofox / Wodify: the name or email headers any of their maps accept. */
const MEMBER_NAME_OR_EMAIL = ["name", "full name", "member name", "client name", "athlete name", "email", "email address"];

/**
 * The header row's cells: BOM stripped, trimmed, lower-cased. Reads only the
 * first CSV record (a quoted header cell may contain commas or line breaks),
 * so it can be handed a whole file or just its first few kilobytes.
 */
export function csvHeaderCells(text: string): string[] {
  const s = text.replace(/^﻿/, "");
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { cells.push(cur); cur = ""; continue; }
    if (ch === "\n" || ch === "\r") break;
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.replace(/^﻿/, "").trim().toLowerCase());
}

/** What kind of export the header row says this is. Header only; no data row is read. */
export function sniffCsvKind(firstLine: string): CsvKind {
  const headers = new Set(csvHeaderCells(firstLine).filter(Boolean));
  if (headers.size === 0) return "unknown";
  const any = (names: readonly string[]) => names.some((n) => headers.has(n));
  const hasClass = any(ATTENDANCE_CLASS) || headers.has("class");

  // A memberships export has no class column; an attendance export always has one.
  if (!hasClass && TEAMUP_MEMBERSHIPS_REQUIRED.every((h) => headers.has(h))) return "teamup_memberships";
  if (any(ATTENDANCE_CLASS) && any(ATTENDANCE_START) && any(ATTENDANCE_STATUS) && any(ATTENDANCE_PERSON)) return "teamup_attendance";
  if (any(MEMBER_NAME_OR_EMAIL)) return "generic_members";
  return "unknown";
}

/** The refusal each import path gives a file meant for another path (shared by the routes and the panel). */
export const WRONG_PATH_MESSAGE = {
  membershipsAsOtherSource: "This is a TeamUp memberships export. Choose Source: TeamUp (Members) and try again.",
  attendanceAsMembers: "This is a TeamUp attendance export, not a members file. Import it under Attendance history (the button above), after the members are in.",
  membershipsAsAttendance: "This is a TeamUp memberships export, not an attendance export. Import it under Members with Source: TeamUp.",
} as const;
