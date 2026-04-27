/**
 * CSV importers — common shape and dispatcher.
 * Each vendor module exports `parse(csvText)` that returns MemberDraft[] + per-row errors.
 */
export type ImportSource = "generic" | "mindbody" | "glofox" | "wodify";

export type MemberDraft = {
  name: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;        // ISO date
  membershipType?: string;
  status?: string;             // active | inactive | cancelled | taster
  accountType?: string;        // adult | junior | kids
  notes?: string;
  joinedAt?: string;           // ISO datetime
};

export type ParseResult = {
  drafts: MemberDraft[];
  errors: { row: number; reason: string }[];
};

export function parseCSV(csvText: string): string[][] {
  const rows: string[][] = [];
  let cur = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(cur); cur = ""; continue; }
    if (ch === "\n") { row.push(cur); cur = ""; rows.push(row); row = []; continue; }
    if (ch === "\r") continue;
    cur += ch;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    rows.push(row);
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

function parseRowsWithMap(rows: string[][], headerMap: Record<keyof MemberDraft, string[]>): ParseResult {
  if (rows.length < 2) return { drafts: [], errors: [{ row: 0, reason: "CSV is empty or has no data rows." }] };
  const headers = rows[0];
  const idx = {} as Record<keyof MemberDraft, number>;
  for (const k of Object.keys(headerMap) as (keyof MemberDraft)[]) {
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
      errors.push({ row: r + 1, reason: !email ? "Missing email" : `Invalid email: ${email}` });
      continue;
    }
    if (!name) {
      errors.push({ row: r + 1, reason: "Missing name" });
      continue;
    }

    drafts.push({
      name,
      email: email.toLowerCase(),
      phone: trimOrUndef(row[idx.phone]),
      dateOfBirth: parseISODate(row[idx.dateOfBirth]),
      membershipType: trimOrUndef(row[idx.membershipType]),
      status: normaliseStatus(row[idx.status]) ?? "active",
      accountType: normaliseAccountType(row[idx.accountType]) ?? "adult",
      notes: trimOrUndef(row[idx.notes]),
      joinedAt: parseISODate(row[idx.joinedAt]),
    });
  }

  return { drafts, errors };
}

const HEADER_MAPS: Record<ImportSource, Record<keyof MemberDraft, string[]>> = {
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
  },
};

export function parseImport(source: ImportSource, csvText: string): ParseResult {
  const rows = parseCSV(csvText);
  return parseRowsWithMap(rows, HEADER_MAPS[source]);
}
