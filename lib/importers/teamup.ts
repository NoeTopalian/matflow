/**
 * TeamUp — "Memberships" report export.
 *
 * TeamUp's export is one row PER MEMBERSHIP EVER HELD, not one row per person:
 * a member who joined, cancelled and rejoined is three rows; a kid is a row
 * whose email is the parent's; a family is five rows on one address; a few
 * rows have no email at all; "(Deleted Customer)" rows have no name. The
 * generic importer would treat each row as a member, skip every sibling as an
 * "existing email", drop the no-email rows and link no child to a parent
 * (kids need a parent — a database CHECK refuses them otherwise). So this
 * module folds the rows into PEOPLE first, then emits one draft per person
 * with the relationships the commit route needs.
 *
 * Rules, each pinned by tests/unit/import-teamup.test.ts:
 *  - Rows group into a person by (email, name), both lower-cased and trimmed.
 *    Nothing else merges people: same surname, same phone, same address are
 *    NOT identity evidence.
 *  - "(Deleted Customer)" rows are dropped and counted.
 *  - A person's CURRENT membership is the row with status `active` or `hold`
 *    whose expiry is blank or in the future; `active` beats `hold`; the latest
 *    start date breaks ties. `upgraded` / `downgraded` / `completed` /
 *    `cancelled` rows are history. Two live rows → the person is imported on
 *    the first and flagged for review; nothing is guessed.
 *  - A person with only history becomes `status: cancelled` (or `inactive`
 *    when their last row is a completed prepaid course), with the last plan's
 *    name and the last cancellation date kept.
 *  - Kids: date of birth under 18 on the import date (or a plan named "Kids"
 *    with no date of birth). Under 13 → `kids`, 13–17 → `junior`. A kid never
 *    keeps the row's email: it belongs to whoever pays, so it becomes the
 *    parent's. The parent is the adult sharing that email; when no adult row
 *    shares it, a parent draft is created from the emergency contact — marked
 *    UNVERIFIED, never invited by this import, shown in the preview.
 *  - A person with no email, and a second adult sharing an email already
 *    taken, get a synthesised non-contactable address and a note. They are
 *    imported; they can't be emailed until someone adds an address.
 *  - TeamUp's export has no next-payment date. One is ESTIMATED from the
 *    start date and the plan's cycle and written into the notes as
 *    unverified — it is NEVER written to `nextDueAt`, so nothing downstream
 *    can charge on it until a person confirms it on the profile.
 *  - Gender, address and marketing preference are not imported (data
 *    minimisation); a marketing refusal is kept as a note so nobody mails
 *    them by mistake.
 */
import { csvRowLine, parseCSV, type MemberDraft, type ParseResult } from "./index";
import { synthesiseMemberEmail } from "@/lib/synthesise-kid-email";

export type TeamUpSummary = {
  sourceRows: number;
  deletedRows: number;
  people: number;
  adults: number;
  kids: number;
  parentsSynthesised: number;
  kidsWithoutParent: number;
  noEmail: number;
  sharedEmailAdults: number;
  multipleLiveMemberships: number;
  currentActive: number;
  currentOnHold: number;
  historicalOnly: number;
  /** Per plan name: how many people are CURRENTLY on it (active + hold), for reconciliation against TeamUp's own counts. */
  planCounts: Record<string, { active: number; hold: number }>;
};

export type TeamUpParseResult = ParseResult & { summary: TeamUpSummary };

const H = {
  name: "customer name",
  email: "customer email",
  otherActive: "other active",
  plan: "membership name",
  type: "type",
  status: "status",
  processor: "payment processor",
  purchase: "purchase date",
  start: "start date",
  expiry: "expiration date",
  cancelled: "cancelled date",
  first: "is first membership",
  completedAt: "completed at",
  marketing: "marketing preference",
  phone: "phone",
  dob: "date of birth",
  ecName: "emergency contact name",
  ecPhone: "emergency contact phone",
  ecRel: "emergency contact relationship",
} as const;

type Row = Record<keyof typeof H, string>;

const PARENTAL = /\b(mother|father|mum|mom|dad|parent|guardian|carer|grand(mother|father|ma|pa|parent)|step(mum|dad|mother|father))\b/i;

function cell(v: string | undefined): string {
  return (v ?? "").trim();
}

function isoDate(v: string): string | undefined {
  const t = cell(v);
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

function ageOn(dobIso: string, todayIso: string): number {
  const dob = new Date(`${dobIso}T00:00:00Z`);
  const today = new Date(`${todayIso}T00:00:00Z`);
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** TeamUp cycle from the plan's own wording; the catalogue is the source of truth, this is only for the estimate. */
export function cycleForPlan(plan: string): "four_weekly" | "monthly" | "none" {
  // The only prepaid plan in the catalogue is the "8 Week Beginners Course";
  // "Beginner Course" and "Beginners Course 2026" are recurring every 4 weeks.
  if (/^8 week/i.test(plan)) return "none";
  if (/\(old\)/i.test(plan)) return "monthly";
  return "four_weekly";
}

/** First cycle boundary strictly after `today`, stepping from `startIso`. Estimate only — never executable. */
export function estimateNextCharge(startIso: string, cycle: "four_weekly" | "monthly" | "none", todayIso: string): string | undefined {
  if (cycle === "none") return undefined;
  const today = new Date(`${todayIso}T00:00:00Z`).getTime();
  const d = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < 400 && d.getTime() <= today; i += 1) {
    if (cycle === "four_weekly") d.setUTCDate(d.getUTCDate() + 28);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.getTime() > today ? d.toISOString().slice(0, 10) : undefined;
}

type Person = {
  key: string;
  name: string;
  email: string; // "" when the row had none
  rows: Array<Row & { n: number }>;
};

function isLive(r: Row, todayIso: string): boolean {
  const s = r.status.toLowerCase();
  if (s !== "active" && s !== "hold") return false;
  const exp = isoDate(r.expiry);
  return !exp || exp >= todayIso;
}

export function parseTeamUp(csvText: string, opts: { today?: string } = {}): TeamUpParseResult {
  const todayIso = opts.today ?? new Date().toISOString().slice(0, 10);
  const rows = parseCSV(csvText);
  const empty: TeamUpSummary = {
    sourceRows: 0, deletedRows: 0, people: 0, adults: 0, kids: 0, parentsSynthesised: 0, kidsWithoutParent: 0,
    noEmail: 0, sharedEmailAdults: 0, multipleLiveMemberships: 0, currentActive: 0, currentOnHold: 0, historicalOnly: 0, planCounts: {},
  };
  if (rows.length < 2) return { drafts: [], errors: [{ row: 0, reason: "CSV is empty or has no data rows." }], summary: empty };

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const idx: Record<keyof typeof H, number> = {} as never;
  for (const k of Object.keys(H) as (keyof typeof H)[]) idx[k] = headers.indexOf(H[k]);
  if (idx.name === -1 || idx.plan === -1 || idx.status === -1) {
    return { drafts: [], errors: [{ row: 0, reason: "This does not look like a TeamUp memberships export (missing Customer Name / Membership Name / Status)." }], summary: empty };
  }

  const summary: TeamUpSummary = { ...empty, sourceRows: rows.length - 1 };
  const errors: ParseResult["errors"] = [];
  const people = new Map<string, Person>();

  for (let r = 1; r < rows.length; r += 1) {
    const raw = rows[r];
    const row = {} as Row & { n: number };
    for (const k of Object.keys(H) as (keyof typeof H)[]) (row as Record<string, string | number>)[k] = idx[k] === -1 ? "" : cell(raw[idx[k]]);
    row.n = csvRowLine(raw, r);
    if (!row.name || /^\(deleted customer\)$/i.test(row.name)) { summary.deletedRows += 1; continue; }
    const email = row.email.toLowerCase();
    const key = `${email}|${row.name.toLowerCase()}`;
    const p = people.get(key) ?? { key, name: row.name, email, rows: [] };
    p.rows.push(row);
    people.set(key, p);
  }

  // ── Fold each person's rows into one current state ────────────────────────
  type Folded = {
    person: Person;
    current: (Row & { n: number }) | null;
    live: Array<Row & { n: number }>;
    isKid: boolean;
    accountType: "adult" | "junior" | "kids";
    dob?: string;
    notes: string[];
  };
  const folded: Folded[] = [];
  for (const person of people.values()) {
    const sorted = [...person.rows].sort((a, b) => (isoDate(a.start) ?? "").localeCompare(isoDate(b.start) ?? ""));
    const live = sorted.filter((r) => isLive(r, todayIso));
    live.sort((a, b) => {
      const sa = a.status.toLowerCase() === "active" ? 0 : 1;
      const sb = b.status.toLowerCase() === "active" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return (isoDate(b.start) ?? "").localeCompare(isoDate(a.start) ?? "");
    });
    const current = live[0] ?? null;
    const dob = sorted.map((r) => isoDate(r.dob)).find(Boolean);
    const anyKidsPlan = sorted.some((r) => /\bkids?\b/i.test(r.plan));
    let accountType: Folded["accountType"] = "adult";
    if (dob) {
      const age = ageOn(dob, todayIso);
      if (age < 13) accountType = "kids";
      else if (age < 18) accountType = "junior";
    } else if (anyKidsPlan) {
      accountType = "kids";
    }
    const notes: string[] = [];
    if (live.length > 1) {
      summary.multipleLiveMemberships += 1;
      notes.push(`TeamUp shows ${live.length} live memberships (${live.map((r) => `${r.plan} · ${r.status}`).join("; ")}) — imported on the first, review which applies.`);
    }
    if (dob && accountType === "adult" && anyKidsPlan && ageOn(dob, todayIso) >= 18) {
      notes.push(`Date of birth ${dob} makes this an adult but a Kids plan is on file — check the date of birth.`);
    }
    folded.push({ person, current, live, isKid: accountType === "kids" || accountType === "junior", accountType, dob, notes });
  }

  // ── Emails: who is contactable, who shares, who needs a parent ────────────
  const byEmail = new Map<string, Folded[]>();
  for (const f of folded) if (f.person.email) byEmail.set(f.person.email, [...(byEmail.get(f.person.email) ?? []), f]);

  const drafts: MemberDraft[] = [];
  const parentDraftByEmail = new Map<string, MemberDraft>();
  const emailClaimed = new Set<string>();

  function parentFor(kid: Folded): { email: string; created: boolean } | null {
    const email = kid.person.email;
    if (!email) return null;
    const adults = (byEmail.get(email) ?? []).filter((f) => !f.isKid);
    if (adults.length > 0) {
      const ec = kid.current?.ecName ?? kid.person.rows[0].ecName;
      const match = adults.find((a) => ec && a.person.name.toLowerCase() === ec.toLowerCase()) ?? adults[0];
      return { email: match.person.email, created: false };
    }
    if (parentDraftByEmail.has(email)) return { email, created: false };
    // No adult row shares the payer's address: create the payer/guardian
    // from the emergency contact, marked unverified.
    const src = kid.current ?? kid.person.rows[kid.person.rows.length - 1];
    const rel = src.ecRel;
    const ecName = src.ecName;
    const name = ecName && PARENTAL.test(rel || "parent") ? ecName : `Parent of ${kid.person.name}`;
    const parent: MemberDraft = {
      name,
      email,
      phone: src.ecPhone || src.phone || undefined,
      accountType: "parent",
      status: "active",
      paymentStatus: "paid",
      notes: `Payer/guardian record created from TeamUp export (emergency contact ${ecName || "not given"}${rel ? `, ${rel}` : ""}) — UNVERIFIED: confirm before inviting.`,
      unverified: true,
    };
    parentDraftByEmail.set(email, parent);
    summary.parentsSynthesised += 1;
    return { email, created: true };
  }

  function draftFor(f: Folded): MemberDraft {
    const cur = f.current;
    const last = f.person.rows.slice().sort((a, b) => (isoDate(a.start) ?? "").localeCompare(isoDate(b.start) ?? "")).at(-1)!;
    const src = cur ?? last;
    const joined = f.person.rows.map((r) => isoDate(r.start)).filter((d): d is string => !!d).sort()[0];
    const notes = [...f.notes];
    let status = "active";
    let paymentStatus = "paid";
    let cancelledAt: string | undefined;
    if (cur) {
      if (cur.status.toLowerCase() === "hold") { paymentStatus = "paused"; notes.push("On hold at TeamUp — resume date not in the export."); }
      if (!cur.processor) notes.push("No payment processor recorded at TeamUp for this membership.");
      const cycle = cycleForPlan(cur.plan);
      const start = isoDate(cur.start);
      const est = start ? estimateNextCharge(start, cycle, todayIso) : undefined;
      if (est) notes.push(`Estimated next charge ${est} (from TeamUp start ${start}, ${cycle === "monthly" ? "monthly" : "every 4 weeks"}) — UNVERIFIED, set the due date on the profile after checking TeamUp.`);
    } else {
      const lastStatus = last.status.toLowerCase();
      status = lastStatus === "completed" && last.type.toLowerCase() === "prepaid" ? "inactive" : "cancelled";
      paymentStatus = "cancelled";
      cancelledAt = isoDate(last.cancelled) ?? isoDate(last.expiry) ?? isoDate(last.completedAt);
      notes.push(`No live membership at TeamUp — last was ${last.plan} (${last.status}${cancelledAt ? `, ${cancelledAt}` : ""}).`);
      summary.historicalOnly += 1;
    }
    if (/^no\b/i.test(src.marketing)) notes.push("Marketing: declined at TeamUp — do not send marketing.");

    return {
      name: f.person.name,
      email: f.person.email,
      phone: src.phone || undefined,
      dateOfBirth: f.dob,
      membershipType: src.plan || undefined,
      status,
      accountType: f.accountType,
      notes: notes.length ? notes.join(" | ") : undefined,
      joinedAt: joined,
      paymentStatus,
      cancelledAt,
      emergencyContactName: src.ecName || undefined,
      emergencyContactPhone: src.ecPhone || undefined,
      emergencyContactRelation: src.ecRel || undefined,
      sourceRows: f.person.rows.map((r) => r.n),
    };
  }

  // Adults first (they claim emails), then kids (they point at a parent).
  const adults = folded.filter((f) => !f.isKid);
  const kids = folded.filter((f) => f.isKid);

  for (const f of adults) {
    const d = draftFor(f);
    if (!d.email) {
      d.email = synthesiseMemberEmail("adult");
      d.nonContactable = true;
      d.notes = [d.notes, "No email at TeamUp — non-contactable until an address is added."].filter(Boolean).join(" | ");
      summary.noEmail += 1;
    } else if (emailClaimed.has(d.email)) {
      d.notes = [d.notes, `Shares ${d.email} with another adult at TeamUp — imported as non-contactable; add their own address.`].filter(Boolean).join(" | ");
      d.email = synthesiseMemberEmail("adult");
      d.nonContactable = true;
      summary.sharedEmailAdults += 1;
    } else {
      emailClaimed.add(d.email);
    }
    drafts.push(d);
    summary.adults += 1;
  }

  const kidDrafts: MemberDraft[] = [];
  for (const f of kids) {
    const d = draftFor(f);
    const parent = parentFor(f);
    if (!parent) {
      // No email at all: nothing to hang a payer on. Still a person; the
      // owner links a parent by hand. Junior can stand alone; kids cannot.
      if (f.accountType === "kids") {
        errors.push({ row: f.person.rows[0].n, reason: `${f.person.name}: a child under 13 needs a parent and this row has no email to find one — add the parent first, then re-import.` });
        summary.kidsWithoutParent += 1;
        continue;
      }
      d.notes = [d.notes, "No email at TeamUp — non-contactable until a parent is linked."].filter(Boolean).join(" | ");
      summary.noEmail += 1;
    } else {
      d.parentEmail = parent.email;
    }
    d.email = synthesiseMemberEmail("kid");
    d.nonContactable = true;
    kidDrafts.push(d);
    summary.kids += 1;
  }

  for (const p of parentDraftByEmail.values()) {
    // A synthesised parent must not collide with an adult already using the address.
    if (emailClaimed.has(p.email)) continue;
    emailClaimed.add(p.email);
    drafts.push(p);
  }
  drafts.push(...kidDrafts);

  for (const f of folded) {
    if (!f.current) continue;
    const plan = f.current.plan;
    const pc = summary.planCounts[plan] ?? { active: 0, hold: 0 };
    if (f.current.status.toLowerCase() === "hold") { pc.hold += 1; summary.currentOnHold += 1; } else { pc.active += 1; summary.currentActive += 1; }
    summary.planCounts[plan] = pc;
  }
  summary.people = folded.length;

  return { drafts, errors, summary };
}
