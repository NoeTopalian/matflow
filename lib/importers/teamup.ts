/**
 * TeamUp — "Memberships" report export (mapping teamup-2, 2 Oct 2026).
 *
 * TeamUp's export is one row PER MEMBERSHIP EVER HELD, not one row per person:
 * a member who joined, cancelled and rejoined is three rows; a kid is a row
 * whose email is the parent's; a family is five rows on one address; a few
 * rows have no email at all; "(Deleted Customer)" rows have no name. The
 * generic importer would treat each row as a member, skip every sibling as an
 * "existing email", drop the no-email rows and link no child to a parent
 * (kids need a parent — a database CHECK refuses them otherwise). So this
 * module folds the rows into PEOPLE first, then emits one draft per person
 * with the relationships the commit route needs — and keeps EVERY source row
 * as a membership record, with exactly one disposition per CSV record.
 *
 * Rules, each pinned by tests/unit/import-teamup.test.ts:
 *  - Rows group into a person by (email, name), both lower-cased and trimmed.
 *    Nothing else merges people: same surname, same phone, same address are
 *    NOT identity evidence. The key is persisted as Member.externalRef.
 *  - Exact duplicate rows (every cell equal) are linked to the first copy and
 *    folded once. "(Deleted Customer)" rows are excluded and counted.
 *  - Entitlement is read at an explicit AS-OF date (the export's snapshot
 *    date in the club's timezone), per membership: an `active` row that has
 *    started and not expired is CURRENT; an `active` row whose start is after
 *    the as-of date is SCHEDULED (the started one stays current); a `hold`
 *    row is CURRENT only when it is the person's only live membership,
 *    otherwise it is HELD history. Two started active rows → a DECISION the
 *    owner makes: the person is imported with no current plan and both named.
 *    Nothing picks a winner. `upgraded` / `downgraded` / `completed` /
 *    `cancelled` rows are history, never a lifecycle state.
 *  - A person with only history becomes `status: cancelled` (or `inactive`
 *    when their last row is a completed prepaid course). `cancelledAt` comes
 *    ONLY from the Cancelled Date column; a cancellation without a date stays
 *    undated and is flagged. No end date is ever manufactured.
 *  - Kids: date of birth under 18 on the as-of date (or a plan named "Kids"
 *    with no date of birth). Under 13 → `kids`, 13–17 → `junior`. A kid never
 *    keeps the row's email (it is the payer's). The parent link is SUGGESTED,
 *    never granted: the adult sharing the email (suggestedBy shared_email), or
 *    a non-authenticated guardian draft made from the emergency contact
 *    (suggestedBy emergency_contact) whose LOGIN address is synthesised and
 *    whose real address is kept as `unverifiedEmail` for the owner to confirm.
 *    The commit writes the link with guardianConfirmedAt NULL; the parent
 *    portal acts for a child only once confirmed.
 *  - A person with no email, and a second adult sharing an email already
 *    taken, get a synthesised non-contactable login and a note (the shared
 *    address is kept as `unverifiedEmail`). They are imported; nothing can
 *    email, invite or reset them until someone confirms an address.
 *  - TeamUp's export has no next-payment date, prices or cycles. An estimate
 *    of the next charge is written into the notes as unverified — NEVER to
 *    `nextDueAt`; nothing downstream can charge on it.
 *  - Gender, address and marketing preference are not imported (data
 *    minimisation); a marketing refusal is kept as a note so nobody mails
 *    them by mistake. A blank preference is unknown, not consent.
 */
import { csvRowLine, parseCSV, type MemberDraft, type MembershipRowDraft, type ParseResult, type RowDisposition } from "./index";
import { synthesiseMemberEmail } from "@/lib/synthesise-kid-email";

export type TeamUpSummary = {
  asOf: string;
  sourceRows: number;
  duplicateRows: number;
  deletedRows: number;
  people: number;
  adults: number;
  kids: number;
  /** Guardian drafts made from emergency contacts — non-authenticated, unconfirmed. */
  parentsSynthesised: number;
  /** Kid links suggested from a shared email — unconfirmed. */
  guardiansFromSharedEmail: number;
  kidsWithoutParent: number;
  noEmail: number;
  noEmailActive: number;
  sharedEmailAdults: number;
  /** People with two started active memberships — a decision, no plan chosen. */
  decisionsRequired: number;
  /** People with an active membership that starts after the as-of date. */
  scheduledStarts: number;
  /** People on hold at TeamUp AND with a started active membership (the hold is on another plan). */
  heldAlongsideActive: number;
  multipleLiveMemberships: number;
  cancelledWithoutDate: number;
  emergencyContactConflicts: number;
  currentActive: number;
  currentOnHold: number;
  historicalOnly: number;
  /** Per plan name: how many people are CURRENTLY on it (active + hold), for reconciliation against TeamUp's own counts. */
  planCounts: Record<string, { active: number; hold: number }>;
};

export type TeamUpParseResult = ParseResult & { summary: TeamUpSummary; rows: RowDisposition[] };

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
type SourceRow = Row & { n: number; line: number; fp: string };

const PARENTAL = /\b(mother|father|mum|mom|dad|parent|guardian|carer|grand(mother|father|ma|pa|parent)|step(mum|dad|mother|father))\b/i;

/**
 * A TeamUp person's identity key: email and name, trimmed and lower-cased,
 * WITHOUT the "teamup:" prefix the members import adds when it stores the key
 * as Member.externalRef. TeamUp exports carry no customer id; this is the
 * only identity the source gives. The attendance import derives the same key
 * from its own rows (lib/importers/attendance.ts) so the two always agree.
 */
export function teamupIdentity(name: string, email: string): string {
  return `${email.trim().toLowerCase()}|${name.trim().toLowerCase()}`;
}

/** The stored form: exactly `Member.externalRef` of a TeamUp-imported person. */
export function teamupPersonKey(name: string, email: string): string {
  return `teamup:${teamupIdentity(name, email)}`;
}

function cell(v: string | undefined): string {
  return (v ?? "").trim();
}

/** Date-only columns stay date-only: no Date() round-trip, no timezone shift. */
function isoDate(v: string): string | undefined {
  const t = cell(v);
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return undefined;
}

/** The one timestamp column (with offset) — kept as an instant. */
function isoInstant(v: string): string | undefined {
  const t = cell(v);
  if (!t) return undefined;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function ageOn(dobIso: string, todayIso: string): number {
  const dob = new Date(`${dobIso}T00:00:00Z`);
  const today = new Date(`${todayIso}T00:00:00Z`);
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** Stable, non-cryptographic fingerprint of a row's cells (FNV-1a, two seeds) — for duplicate detection and the row ledger. */
export function rowFingerprint(cells: string[]): string {
  const s = cells.map((c) => (c ?? "").trim()).join("\u0001");
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x9747b28c);
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
  rows: SourceRow[];
};

type Entitlement = MembershipRowDraft["entitlement"];

/** What one row is, read at the as-of date, before the person-level rules. */
function classify(r: SourceRow, asOf: string): "current" | "scheduled" | "held" | "history" {
  const s = r.status.toLowerCase();
  if (s !== "active" && s !== "hold") return "history";
  const start = isoDate(r.start);
  const exp = isoDate(r.expiry);
  const started = !start || start <= asOf;
  const live = !exp || exp >= asOf;
  if (!live) return "history";
  if (s === "active") return started ? "current" : "scheduled";
  return started ? "held" : "history";
}

function toMembershipRow(r: SourceRow, entitlement: Entitlement): MembershipRowDraft {
  const first = r.first.toLowerCase();
  return {
    sourceRow: r.n,
    sourceFingerprint: r.fp,
    planLabel: r.plan,
    type: r.type.toLowerCase() || "recurring",
    status: r.status.toLowerCase(),
    processor: r.processor || undefined,
    purchaseDate: isoDate(r.purchase),
    startDate: isoDate(r.start),
    expiryDate: isoDate(r.expiry),
    cancelledDate: isoDate(r.cancelled),
    completedAt: isoInstant(r.completedAt),
    isFirst: first ? first === "yes" || first === "true" : undefined,
    otherActive: r.otherActive || undefined,
    entitlement,
  };
}

export function parseTeamUp(csvText: string, opts: { today?: string; asOf?: string } = {}): TeamUpParseResult {
  const asOf = opts.asOf ?? opts.today ?? new Date().toISOString().slice(0, 10);
  const parsed = parseCSV(csvText);
  const empty: TeamUpSummary = {
    asOf, sourceRows: 0, duplicateRows: 0, deletedRows: 0, people: 0, adults: 0, kids: 0, parentsSynthesised: 0, guardiansFromSharedEmail: 0,
    kidsWithoutParent: 0, noEmail: 0, noEmailActive: 0, sharedEmailAdults: 0, decisionsRequired: 0, scheduledStarts: 0, heldAlongsideActive: 0,
    multipleLiveMemberships: 0, cancelledWithoutDate: 0, emergencyContactConflicts: 0, currentActive: 0, currentOnHold: 0, historicalOnly: 0, planCounts: {},
  };
  if (parsed.length < 2) return { drafts: [], errors: [{ row: 0, reason: "CSV is empty or has no data rows." }], summary: empty, rows: [] };

  const headers = parsed[0].map((h) => h.trim().toLowerCase());
  const idx: Record<keyof typeof H, number> = {} as never;
  for (const k of Object.keys(H) as (keyof typeof H)[]) idx[k] = headers.indexOf(H[k]);
  if (idx.name === -1 || idx.plan === -1 || idx.status === -1) {
    return { drafts: [], errors: [{ row: 0, reason: "This does not look like a TeamUp memberships export (missing Customer Name / Membership Name / Status)." }], summary: empty, rows: [] };
  }

  const summary: TeamUpSummary = { ...empty, sourceRows: parsed.length - 1 };
  const errors: ParseResult["errors"] = [];
  const rows: RowDisposition[] = [];
  const people = new Map<string, Person>();
  const byFingerprint = new Map<string, number>();

  for (let r = 1; r < parsed.length; r += 1) {
    const raw = parsed[r];
    const row = {} as SourceRow;
    for (const k of Object.keys(H) as (keyof typeof H)[]) (row as Record<string, string | number>)[k] = idx[k] === -1 ? "" : cell(raw[idx[k]]);
    // Record ordinal (header = 1): what the reconciliation ledger cites.
    row.n = r + 1;
    // File line, for error messages that a person reads against the file.
    row.line = csvRowLine(raw, r);
    row.fp = rowFingerprint(raw);

    const firstCopy = byFingerprint.get(row.fp);
    if (firstCopy !== undefined) {
      summary.duplicateRows += 1;
      rows.push({ sourceRow: row.n, sourceFingerprint: row.fp, disposition: `duplicate_of:${firstCopy}`, membership: toMembershipRow(row, "duplicate") });
      continue;
    }
    byFingerprint.set(row.fp, row.n);

    if (!row.name || /^\(deleted customer\)$/i.test(row.name)) {
      summary.deletedRows += 1;
      rows.push({ sourceRow: row.n, sourceFingerprint: row.fp, disposition: "excluded:deleted_customer", membership: toMembershipRow(row, "excluded") });
      continue;
    }
    const email = row.email.toLowerCase();
    const key = teamupIdentity(row.name, row.email);
    const p = people.get(key) ?? { key, name: row.name, email, rows: [] };
    p.rows.push(row);
    people.set(key, p);
  }

  // ── Fold each person's rows into one current state ────────────────────────
  type Folded = {
    person: Person;
    current: SourceRow | null;
    decision: MemberDraft["decision"];
    scheduled: SourceRow | null;
    memberships: MembershipRowDraft[];
    isKid: boolean;
    accountType: "adult" | "junior" | "kids";
    dob?: string;
    notes: string[];
  };
  const folded: Folded[] = [];
  const byStart = (a: SourceRow, b: SourceRow) => (isoDate(a.start) ?? "").localeCompare(isoDate(b.start) ?? "");

  for (const person of people.values()) {
    const sorted = [...person.rows].sort(byStart);
    const kinds = new Map<number, Entitlement>(sorted.map((r) => [r.n, classify(r, asOf)]));
    const currents = sorted.filter((r) => kinds.get(r.n) === "current");
    const helds = sorted.filter((r) => kinds.get(r.n) === "held");
    const scheduledRows = sorted.filter((r) => kinds.get(r.n) === "scheduled");
    const notes: string[] = [];
    let current: SourceRow | null = null;
    let decision: MemberDraft["decision"];

    if (currents.length === 1) {
      current = currents[0];
      if (helds.length > 0) {
        // The hold is on another membership; the started active plan stands.
        summary.heldAlongsideActive += 1;
        notes.push(`Also on hold at TeamUp: ${helds.map((h) => h.plan).join(", ")} — the hold is not applied; ${current.plan} is current.`);
      }
    } else if (currents.length === 0 && helds.length > 0) {
      // On hold: the latest-started held membership is the current one.
      current = [...helds].sort(byStart).at(-1)!;
      for (const h of helds) if (h !== current) kinds.set(h.n, "held");
      if (helds.length > 1) notes.push(`TeamUp shows ${helds.length} memberships on hold (${helds.map((h) => h.plan).join("; ")}) — ${current.plan} is treated as the current one.`);
    } else if (currents.length >= 2) {
      // Two started active memberships: no automatic winner.
      decision = { kind: "concurrent_memberships", options: currents.map((c) => c.plan), rows: currents.map((c) => c.n) };
      summary.decisionsRequired += 1;
      notes.push(`DECISION NEEDED — TeamUp shows ${currents.length} active memberships that have both started (${currents.map((c) => `${c.plan} from ${isoDate(c.start) ?? "?"}`).join("; ")}). No plan was chosen; choose one on the profile.`);
    }
    if (currents.length + helds.length > 1) summary.multipleLiveMemberships += 1;

    const scheduled = scheduledRows.length ? [...scheduledRows].sort(byStart)[0] : null;
    if (scheduled) {
      summary.scheduledStarts += 1;
      notes.push(`Scheduled at TeamUp: ${scheduled.plan} starts ${isoDate(scheduled.start)} — ${current ? `${current.plan} stays current until then` : "no plan is current before that date"}; the next status refresh after the start date moves them.`);
    }

    const dob = sorted.map((r) => isoDate(r.dob)).find(Boolean);
    const anyKidsPlan = sorted.some((r) => /\bkids?\b/i.test(r.plan));
    let accountType: Folded["accountType"] = "adult";
    if (dob) {
      const age = ageOn(dob, asOf);
      if (age < 13) accountType = "kids";
      else if (age < 18) accountType = "junior";
    } else if (anyKidsPlan) {
      accountType = "kids";
    }
    if (dob && accountType === "adult" && anyKidsPlan && ageOn(dob, asOf) >= 18) {
      notes.push(`Date of birth ${dob} makes this an adult but a Kids plan is on file — check the date of birth.`);
    }

    const ecNames = new Set(sorted.map((r) => r.ecName.toLowerCase()).filter(Boolean));
    if (ecNames.size > 1) {
      summary.emergencyContactConflicts += 1;
      notes.push(`Emergency contact differs between TeamUp rows (${ecNames.size} names) — the current membership's contact was kept; check it.`);
    }

    const memberships = sorted.map((r) => toMembershipRow(r, r === current ? "current" : (kinds.get(r.n) === "current" ? "current" : kinds.get(r.n)!)));
    folded.push({ person, current, decision, scheduled, memberships, isKid: accountType === "kids" || accountType === "junior", accountType, dob, notes });
  }

  // ── Emails: who is contactable, who shares, who needs a parent ────────────
  const byEmail = new Map<string, Folded[]>();
  for (const f of folded) if (f.person.email) byEmail.set(f.person.email, [...(byEmail.get(f.person.email) ?? []), f]);

  const drafts: MemberDraft[] = [];
  const parentDraftByEmail = new Map<string, MemberDraft>();
  const emailClaimed = new Set<string>();

  /** The parent a kid is SUGGESTED to hang off. Never a grant: the commit writes guardianConfirmedAt NULL. */
  function parentFor(kid: Folded): { email: string; suggestedBy: "shared_email" | "emergency_contact"; note?: string } | null {
    const email = kid.person.email;
    if (!email) return null;
    const adults = (byEmail.get(email) ?? []).filter((f) => !f.isKid);
    const src = kid.current ?? kid.person.rows[kid.person.rows.length - 1];
    if (adults.length > 0) {
      const ec = src.ecName;
      const match = adults.find((a) => ec && a.person.name.toLowerCase() === ec.toLowerCase()) ?? adults[0];
      const note = adults.length > 1 && !(ec && match.person.name.toLowerCase() === ec.toLowerCase())
        ? `${adults.length} adults share this address — the guardian suggestion is the first; confirm which is right.`
        : undefined;
      // The adult keeps the real address as their login; the kid points at it.
      return { email: match.person.email, suggestedBy: "shared_email", note };
    }
    if (parentDraftByEmail.has(email)) return { email, suggestedBy: "emergency_contact" };
    // No adult row shares the payer's address: a NON-AUTHENTICATED guardian
    // draft from the emergency contact. Its login is synthesised; the payer's
    // real address is kept as unverifiedEmail for the owner to confirm.
    const rel = src.ecRel;
    const ecName = src.ecName;
    const name = ecName && PARENTAL.test(rel || "parent") ? ecName : `Parent/guardian of ${kid.person.name}`;
    const parent: MemberDraft = {
      name,
      // Resolved to a synthesised address below, once per payer email.
      email,
      phone: src.ecPhone || src.phone || undefined,
      accountType: "parent",
      status: "active",
      paymentStatus: "paid",
      notes: `Guardian draft created from TeamUp export (emergency contact ${ecName || "not given"}${rel ? `, ${rel}` : ""}; payer address kept unverified) — NOT CONFIRMED: no portal access to the child and no invitations until confirmed on the Family card.`,
      unverified: true,
      nonContactable: true,
      unverifiedEmail: email,
      // A guardian draft has no TeamUp row of its own.
      sourceKey: `teamup-payer:${email}`,
      memberships: [],
    };
    parentDraftByEmail.set(email, parent);
    summary.parentsSynthesised += 1;
    return { email, suggestedBy: "emergency_contact" };
  }

  function draftFor(f: Folded): MemberDraft {
    const cur = f.current;
    const last = f.person.rows.slice().sort(byStart).at(-1)!;
    const src = cur ?? f.scheduled ?? last;
    const joined = f.person.rows.map((r) => isoDate(r.start)).filter((d): d is string => !!d).sort()[0];
    const notes = [...f.notes];
    let status = "active";
    let paymentStatus = "paid";
    let cancelledAt: string | undefined;
    let membershipType: string | undefined = cur?.plan || undefined;
    if (cur) {
      if (cur.status.toLowerCase() === "hold") { paymentStatus = "paused"; notes.push("On hold at TeamUp — resume date not in the export."); }
      if (!cur.processor) notes.push("No payment processor recorded at TeamUp for this membership.");
      const cycle = cycleForPlan(cur.plan);
      const start = isoDate(cur.start);
      const est = start ? estimateNextCharge(start, cycle, asOf) : undefined;
      if (est) notes.push(`Estimated next charge ${est} (from TeamUp start ${start}, ${cycle === "monthly" ? "monthly" : "every 4 weeks"}) — UNVERIFIED, set the due date on the profile after checking TeamUp.`);
    } else if (f.decision || f.scheduled) {
      // Active at TeamUp, but with no single current plan MatFlow may state.
      membershipType = undefined;
    } else {
      const lastStatus = last.status.toLowerCase();
      // The last plan's label is kept for the record; it is history, not entitlement.
      membershipType = last.plan || undefined;
      status = lastStatus === "completed" && last.type.toLowerCase() === "prepaid" ? "inactive" : "cancelled";
      paymentStatus = "cancelled";
      cancelledAt = isoDate(last.cancelled);
      const ended = cancelledAt ?? (lastStatus === "completed" ? isoInstant(last.completedAt)?.slice(0, 10) : undefined);
      if (status === "cancelled" && !cancelledAt) {
        summary.cancelledWithoutDate += 1;
        notes.push(`No live membership at TeamUp — last was ${last.plan} (${last.status}); cancellation date not in the export.`);
      } else {
        notes.push(`No live membership at TeamUp — last was ${last.plan} (${last.status}${ended ? `, ${ended}` : ""}).`);
      }
      summary.historicalOnly += 1;
    }
    if (/^no\b/i.test(src.marketing)) notes.push("Marketing: declined at TeamUp — do not send marketing.");

    return {
      name: f.person.name,
      email: f.person.email,
      phone: src.phone || undefined,
      dateOfBirth: f.dob,
      membershipType,
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
      sourceKey: `teamup:${f.person.key}`,
      memberships: f.memberships,
      ...(f.decision ? { decision: f.decision } : {}),
      ...(f.scheduled ? { scheduled: { planLabel: f.scheduled.plan, startDate: isoDate(f.scheduled.start)!, sourceRow: f.scheduled.n } } : {}),
    };
  }

  // Adults first (they claim emails), then kids (they point at a parent).
  const adults = folded.filter((f) => !f.isKid);
  const kids = folded.filter((f) => f.isKid);

  for (const f of adults) {
    const d = draftFor(f);
    const live = !!f.current || !!f.decision || !!f.scheduled;
    if (!d.email) {
      d.email = synthesiseMemberEmail("adult");
      d.nonContactable = true;
      d.notes = [d.notes, "No email at TeamUp — non-contactable until an address is added."].filter(Boolean).join(" | ");
      summary.noEmail += 1;
      if (live) summary.noEmailActive += 1;
    } else if (emailClaimed.has(d.email)) {
      d.notes = [d.notes, `Shares ${d.email} with another adult at TeamUp — imported as non-contactable; confirm their own address.`].filter(Boolean).join(" | ");
      d.unverifiedEmail = d.email;
      d.email = synthesiseMemberEmail("adult");
      d.nonContactable = true;
      summary.sharedEmailAdults += 1;
    } else {
      emailClaimed.add(d.email);
    }
    drafts.push(d);
    summary.adults += 1;
    for (const m of f.memberships) rows.push({ sourceRow: m.sourceRow, sourceFingerprint: m.sourceFingerprint, disposition: "member_history", sourceKey: d.sourceKey, membership: m });
  }

  const kidDrafts: MemberDraft[] = [];
  for (const f of kids) {
    const d = draftFor(f);
    const parent = parentFor(f);
    if (!parent) {
      // No email at all: nothing to hang a payer on. Still a person; the
      // owner links a parent by hand. Junior can stand alone; kids cannot.
      if (f.accountType === "kids") {
        errors.push({ row: f.person.rows[0].line, reason: `${f.person.name}: a child under 13 needs a parent and this row has no email to find one — add the parent first, then re-import.` });
        summary.kidsWithoutParent += 1;
        for (const r of f.person.rows) rows.push({ sourceRow: r.n, sourceFingerprint: r.fp, disposition: "quarantined:kid_without_parent", sourceKey: d.sourceKey, membership: toMembershipRow(r, "quarantined") });
        continue;
      }
      d.notes = [d.notes, "No email at TeamUp — non-contactable until a parent is linked."].filter(Boolean).join(" | ");
      summary.noEmail += 1;
      if (f.current || f.decision || f.scheduled) summary.noEmailActive += 1;
    } else {
      d.parentEmail = parent.email;
      d.guardianSuggestedBy = parent.suggestedBy;
      if (parent.suggestedBy === "shared_email") summary.guardiansFromSharedEmail += 1;
      if (parent.note) d.notes = [d.notes, parent.note].filter(Boolean).join(" | ");
    }
    d.email = synthesiseMemberEmail("kid");
    d.nonContactable = true;
    kidDrafts.push(d);
    summary.kids += 1;
    for (const m of f.memberships) rows.push({ sourceRow: m.sourceRow, sourceFingerprint: m.sourceFingerprint, disposition: "member_history", sourceKey: d.sourceKey, membership: m });
  }

  // Guardian drafts: the kid's parentEmail must find them, so each draft keeps
  // the payer email as its lookup key while the LOGIN written is synthesised.
  // The commit resolves `parentEmail` against both the real address (an adult
  // member) and `unverifiedEmail` (a guardian draft).
  for (const p of parentDraftByEmail.values()) {
    // A guardian draft must not collide with an adult already using the address.
    if (emailClaimed.has(p.email)) continue;
    p.email = synthesiseMemberEmail("adult");
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

  rows.sort((a, b) => a.sourceRow - b.sourceRow);
  return { drafts, errors, summary, rows };
}
