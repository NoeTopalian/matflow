/**
 * Attendance-history import — the database side (3 Oct 2026).
 *
 * lib/importers/attendance.ts turns a file into a PLAN; this module previews
 * it against the club, records the owner's decisions, commits it in bounded
 * resumable steps, and rolls a commit back conservatively. The route
 * (app/api/admin/import/attendance) only authenticates and dispatches.
 *
 * Writes are history, never events: plain inserts into ImportedBooking,
 * ClassInstance (past sessions only) and AttendanceRecord. Nothing here goes
 * near lib/checkin.ts, so no class credit, visit allowance, payment, streak
 * reward, rank change, membership change, email, push or webhook can follow
 * from an import.
 *
 * Integrity:
 *  - ImportedBooking is unique per (tenant, source, bookingKey); the key
 *    excludes the status. A replay of the same or a re-ordered file finds
 *    every booking already there; a later export changes a status only when
 *    its export time is newer than the snapshot that set it.
 *  - The commit is a sequence of steps. A step holds the job's lease, works
 *    through bookings in key order from the job's checkpoint, and writes each
 *    batch AND the advanced checkpoint in one transaction — a step that dies
 *    leaves the checkpoint at the last committed batch, and the next step
 *    resumes there. Two tabs cannot hold the lease at once.
 *  - One visit per person per start instant: a member who already has an
 *    attendance at that instant (live check-in, an earlier import, or a
 *    second offering in the same file) is linked to it, never counted twice.
 *  - Rollback removes only what this job created and nothing has touched
 *    since; rows a later import changed are kept and counted with the reason.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantContext } from "@/lib/prisma-tenant";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";
import { usableTimezone } from "@/lib/class-time";
import {
  attendanceControls,
  dayMarkerFor,
  parseAttendanceCsv,
  planAttendanceImport,
  type AttendanceParseResult,
  type AttendancePlan,
  type OfferingDecision,
  type PersonDecision,
  type PlanDecisions,
  type PlannedBooking,
  type RosterClass,
  type RosterLocation,
  type RosterMember,
  type VenueDecision,
} from "@/lib/importers/attendance";

type Tx = Prisma.TransactionClient;

/** ImportJob.source for this import. */
export const JOB_SOURCE = "teamup-attendance";
/** ImportedBooking.source / ImportSourceMapping.source. */
export const LEDGER_SOURCE = "teamup";
export const MAPPING_VERSION = "attendance@2026-10-03";
/** Bookings per transaction. */
const BATCH = 400;
/** A step stops starting new batches after this long (host function limits). */
const STEP_BUDGET_MS = 20_000;
/** How long a step's lease lasts; a step that dies frees the job after this. */
const LEASE_MS = 120_000;
/** Pending-people rows embedded in a preview; the rest are paged. */
const PREVIEW_PEOPLE_CAP = 200;

export type Disposition =
  | "attendance_created"
  | "attendance_existing"
  | "booking_only"
  | "future"
  | "pending_person"
  | "pending_offering"
  | "pending_venue"
  | "venue_conflict"
  | "pending_conflict"
  | "staff_removed";

/** What one run did to one booking. */
export type Outcome = "created" | "updated" | "unchanged" | "stale" | "protected";

// ── Inputs ───────────────────────────────────────────────────────────────────

export type ClubInputs = {
  timezone: string;
  members: RosterMember[];
  classes: RosterClass[];
  locations: RosterLocation[];
  decisions: PlanDecisions;
};

export async function loadClubInputs(tx: Tx, tenantId: string): Promise<ClubInputs> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  // Every member, whatever their status: a cancelled member's history is still history.
  const members = await tx.member.findMany({ where: { tenantId }, select: { id: true, name: true, email: true, externalRef: true } });
  const classes = await tx.class.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, name: true, isActive: true, sourceImportJobId: true, locationId: true },
  });
  const locations = await tx.location.findMany({ where: { tenantId }, select: { id: true, name: true } });
  const mappings = await tx.importSourceMapping.findMany({ where: { tenantId, source: LEDGER_SOURCE } });
  const decisions: PlanDecisions = { person: {}, offering: {}, venue: {} };
  for (const m of mappings) {
    if (m.kind === "person") decisions.person[m.sourceKey] = (m.action === "member" && m.targetId ? { action: "member", targetId: m.targetId } : { action: "pending" }) as PersonDecision;
    if (m.kind === "offering") {
      decisions.offering[m.sourceKey] = (m.action === "class" && m.targetId ? { action: "class", targetId: m.targetId }
        : m.action === "new_class" ? { action: "new_class", targetId: m.targetId } : { action: "pending" }) as OfferingDecision;
    }
    if (m.kind === "venue") {
      decisions.venue[m.sourceKey] = (m.action === "location" && m.targetId ? { action: "location", targetId: m.targetId }
        : m.action === "club" ? { action: "club" } : { action: "pending" }) as VenueDecision;
    }
  }
  return {
    timezone: usableTimezone(tenant?.timezone),
    members,
    classes: classes.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, historical: !!c.sourceImportJobId, locationId: c.locationId })),
    locations,
    decisions,
  };
}

export type BuiltPlan =
  | { errors: string[] }
  | { errors?: undefined; parsed: AttendanceParseResult; plan: AttendancePlan; controls: ReturnType<typeof attendanceControls> };

export function buildPlan(text: string, inputs: ClubInputs, now: Date, createdClasses?: Record<string, string>): BuiltPlan {
  const parsed = parseAttendanceCsv(text);
  if (parsed.errors.length) return { errors: parsed.errors };
  const plan = planAttendanceImport(parsed.rows, {
    timezone: inputs.timezone,
    now,
    members: inputs.members,
    classes: inputs.classes,
    locations: inputs.locations,
    decisions: inputs.decisions,
    isSynthesisedEmail,
    createdClasses,
  });
  return { parsed, plan, controls: attendanceControls(parsed.rows) };
}

/** A digest of everything a commit depends on: the file, the decisions and the roster. */
export function planHashOf(fileHash: string, inputs: ClubInputs): string {
  const h = createHash("sha256");
  h.update(fileHash);
  h.update(JSON.stringify(Object.entries(inputs.decisions).map(([k, v]) => [k, Object.entries(v).sort()])));
  h.update(JSON.stringify(inputs.members.map((m) => [m.id, m.externalRef, m.name, m.email]).sort()));
  h.update(JSON.stringify(inputs.classes.map((c) => [c.id, c.isActive, c.locationId]).sort()));
  h.update(JSON.stringify(inputs.locations.map((l) => l.id).sort()));
  h.update(inputs.timezone);
  return h.digest("hex");
}

// ── Preview ──────────────────────────────────────────────────────────────────

async function existingByKey(tx: Tx, tenantId: string, keys: string[]) {
  const out = new Map<string, { bookingKey: string; status: string; disposition: string; sourceSnapshotAt: Date | null; memberId: string | null; lastJobId: string }>();
  for (let i = 0; i < keys.length; i += 2000) {
    const rows = await tx.importedBooking.findMany({
      where: { tenantId, source: LEDGER_SOURCE, bookingKey: { in: keys.slice(i, i + 2000) } },
      select: { bookingKey: true, status: true, disposition: true, sourceSnapshotAt: true, memberId: true, lastJobId: true },
    });
    for (const r of rows) out.set(r.bookingKey, r);
  }
  return out;
}

function targetDisposition(intent: PlannedBooking["intent"]): Disposition {
  switch (intent) {
    case "attendance":
    case "same_start_visit":
      return "attendance_created"; // or attendance_existing — decided at commit against what is there
    case "booking_only": return "booking_only";
    case "future": return "future";
    case "pending_person": return "pending_person";
    case "pending_offering": return "pending_offering";
    case "pending_venue": return "pending_venue";
    case "venue_conflict": return "venue_conflict";
    case "source_conflict": return "pending_conflict";
  }
}

const isAttendanceDisposition = (d: string) => d === "attendance_created" || d === "attendance_existing";

/** The summary an owner reads before confirming. Bounded: lists are capped and paged elsewhere. */
export async function previewSummary(
  tx: Tx,
  tenantId: string,
  built: Extract<BuiltPlan, { plan: AttendancePlan }>,
  inputs: ClubInputs,
  snapshotAt: Date | null,
) {
  const { plan, parsed, controls } = built;
  const existing = await existingByKey(tx, tenantId, plan.bookings.map((b) => b.bookingKey));

  // Forecast against the ledger: what a commit now would do to each booking.
  const forecast: Record<string, number> = { new: 0, unchanged: 0, status_update: 0, resolution_update: 0, stale: 0 };
  for (const b of plan.bookings) {
    const e = existing.get(b.bookingKey);
    if (!e) { forecast.new += 1; continue; }
    if (e.status !== b.status) {
      if (snapshotAt && (!e.sourceSnapshotAt || snapshotAt > e.sourceSnapshotAt)) forecast.status_update += 1;
      else forecast.stale += 1;
      continue;
    }
    const wanted = targetDisposition(b.intent);
    const same = e.disposition === wanted || (isAttendanceDisposition(e.disposition) && isAttendanceDisposition(wanted)) || e.disposition === "staff_removed";
    if (same && e.memberId === b.memberId) forecast.unchanged += 1;
    else forecast.resolution_update += 1;
  }

  const memberName = new Map(inputs.members.map((m) => [m.id, m.name]));
  const classById = new Map(inputs.classes.map((c) => [c.id, c]));
  const pendingPeople = plan.people.filter((p) => !p.memberId);
  const sessionsByState: Record<string, number> = {};
  for (const s of plan.sessions) sessionsByState[s.state] = (sessionsByState[s.state] ?? 0) + 1;
  const attendanceSessions = new Set(plan.bookings.filter((b) => b.intent === "attendance").map((b) => b.sessionKey));
  const willCreateClasses = new Set(plan.bookings.filter((b) => b.intent === "attendance" && b.classKey?.startsWith("new:")).map((b) => b.classKey));
  const undecidedOfferings = plan.offerings.filter((o) => !o.decision).map((o) => o.label);
  const undecidedVenues = plan.venues.filter((v) => !v.decision).map((v) => v.label);

  return {
    controls,
    columns: {
      mapped: parsed.mappedColumns,
      notImported: parsed.notImportedColumns,
      unmapped: parsed.unmappedColumns,
      blank: parsed.blankColumns,
    },
    rows: plan.totals.inputRows,
    bookings: plan.bookings.length,
    duplicates: plan.duplicates.length,
    rejected: plan.rejected.length,
    rejectedByReason: plan.rejected.reduce<Record<string, number>>((a, r) => ((a[r.reason] = (a[r.reason] ?? 0) + 1), a), {}),
    rejectedSample: plan.rejected.slice(0, 50),
    byIntent: plan.totals.byIntent,
    reconciles: plan.totals.reconciles,
    forecast,
    people: {
      total: plan.people.length,
      matched: plan.people.length - pendingPeople.length,
      byMethod: plan.people.reduce<Record<string, number>>((a, p) => { const k = p.matchMethod ?? (p.decidedPending ? "kept_pending" : "unresolved"); a[k] = (a[k] ?? 0) + 1; return a; }, {}),
      pending: pendingPeople.length,
      pendingBookings: pendingPeople.reduce((n, p) => n + p.bookings, 0),
      pendingAttended: pendingPeople.reduce((n, p) => n + p.attended, 0),
      sharedEmail: plan.people.filter((p) => p.sharedEmail).length,
      missingEmail: plan.people.filter((p) => p.missingEmail).length,
      pendingList: pendingPeople.slice(0, PREVIEW_PEOPLE_CAP).map((p) => ({
        personKey: p.personKey, name: p.name, email: p.email, bookings: p.bookings, attended: p.attended,
        sharedEmail: p.sharedEmail, missingEmail: p.missingEmail, decidedPending: p.decidedPending,
        candidates: p.candidates.map((c) => ({ ...c, name: memberName.get(c.memberId) ?? "" })),
      })),
      pendingListTruncated: pendingPeople.length > PREVIEW_PEOPLE_CAP,
    },
    offerings: plan.offerings.map((o) => ({
      label: o.label, bookings: o.bookings, attended: o.attended, decision: o.decision,
      decisionClassName: o.decision && "targetId" in o.decision && o.decision.targetId ? classById.get(o.decision.targetId)?.name ?? null : null,
      suggestedClassId: o.suggestedClassId,
    })),
    venues: plan.venues.map((v) => ({ label: v.label, bookings: v.bookings, decision: v.decision, suggestedLocationId: v.suggestedLocationId })),
    sessions: {
      provisional: plan.sessions.length,
      byState: sessionsByState,
      withAttendance: attendanceSessions.size,
      sameStartVisits: plan.totals.byIntent.same_start_visit ?? 0,
      newHistoricalClasses: willCreateClasses.size,
    },
    undecided: { offerings: undecidedOfferings, venues: undecidedVenues },
    // What an offering or a venue can be mapped to.
    targets: {
      classes: inputs.classes.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, historical: c.historical })).sort((a, b) => a.name.localeCompare(b.name)),
      locations: inputs.locations.map((l) => ({ id: l.id, name: l.name })),
    },
    committable: undecidedOfferings.length === 0 && undecidedVenues.length === 0 && plan.rejected.length === 0,
  };
}

export type PreviewSummary = Awaited<ReturnType<typeof previewSummary>>;

// ── Decisions ────────────────────────────────────────────────────────────────

export type DecisionInput =
  | { kind: "person"; sourceKey: string; action: "member" | "pending"; targetId?: string | null }
  | { kind: "offering"; sourceKey: string; action: "class" | "new_class" | "pending"; targetId?: string | null }
  | { kind: "venue"; sourceKey: string; action: "location" | "club" | "pending"; targetId?: string | null };

const ACTIONS: Record<DecisionInput["kind"], string[]> = {
  person: ["member", "pending"],
  offering: ["class", "new_class", "pending"],
  venue: ["location", "club", "pending"],
};

/** Validate and store owner decisions. Targets must belong to this club. Returns an error string or null. */
export async function saveDecisions(tx: Tx, tenantId: string, userId: string, list: DecisionInput[]): Promise<string | null> {
  for (const d of list) {
    if (!d || !ACTIONS[d.kind as DecisionInput["kind"]]?.includes(d.action)) return "Unknown decision.";
    if (typeof d.sourceKey !== "string" || !d.sourceKey || d.sourceKey.length > 500) return "Unknown source label.";
    const needsTarget = d.action === "member" || d.action === "class" || d.action === "location";
    if (needsTarget && !d.targetId) return "Choose who or what this maps to.";
    if (d.action === "member") {
      const ok = await tx.member.count({ where: { id: d.targetId!, tenantId } });
      if (!ok) return "That member is not in this club.";
    }
    if (d.action === "class") {
      const ok = await tx.class.count({ where: { id: d.targetId!, tenantId, deletedAt: null } });
      if (!ok) return "That class is not in this club.";
    }
    if (d.action === "location") {
      const ok = await tx.location.count({ where: { id: d.targetId!, tenantId } });
      if (!ok) return "That location is not in this club.";
    }
  }
  for (const d of list) {
    const targetId = d.action === "member" || d.action === "class" || d.action === "location" ? d.targetId! : null;
    await tx.importSourceMapping.upsert({
      where: { tenantId_source_kind_sourceKey: { tenantId, source: LEDGER_SOURCE, kind: d.kind, sourceKey: d.sourceKey } },
      create: { tenantId, source: LEDGER_SOURCE, kind: d.kind, sourceKey: d.sourceKey, action: d.action, targetId, decidedById: userId },
      update: { action: d.action, targetId, decidedById: userId, decidedAt: new Date() },
    });
  }
  return null;
}

// ── Commit ───────────────────────────────────────────────────────────────────

export type Progress = Record<Outcome, number> & {
  dispositions: Partial<Record<Disposition, number>>;
  sessionsCreated: number;
  attendanceCreated: number;
  attendanceLinked: number;
  duplicates: number;
  rejected: number;
};

export function emptyProgress(): Progress {
  return { created: 0, updated: 0, unchanged: 0, stale: 0, protected: 0, dispositions: {}, sessionsCreated: 0, attendanceCreated: 0, attendanceLinked: 0, duplicates: 0, rejected: 0 };
}

/**
 * Frozen at commit: the decisions the owner confirmed (a decision saved while
 * the import runs never changes it), the classes the commit created, and the
 * export time.
 */
export type JobMappings = { createdClasses: Record<string, string>; snapshotAt: string | null; decisions?: PlanDecisions };

export async function claimLease(tx: Tx, tenantId: string, jobId: string, statuses: string[]): Promise<string | null> {
  const token = randomBytes(12).toString("hex");
  const now = new Date();
  const res = await tx.importJob.updateMany({
    where: { id: jobId, tenantId, source: JOB_SOURCE, rolledBackAt: null, status: { in: statuses }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseToken: token },
  });
  return res.count === 1 ? token : null;
}

export async function releaseLease(tx: Tx, tenantId: string, jobId: string, token: string, data: Prisma.ImportJobUpdateManyMutationInput = {}) {
  await tx.importJob.updateMany({ where: { id: jobId, tenantId, leaseToken: token }, data: { ...data, leaseUntil: null, leaseToken: null } });
}

/** Historical classes for `new:` class keys the plan needs, created once per job. */
export async function createHistoricalClasses(
  tx: Tx,
  tenantId: string,
  jobId: string,
  plan: AttendancePlan,
  inputs: ClubInputs,
  createdClasses: Record<string, string>,
) {
  const needed = new Map<string, { label: string; venueKey: string }>();
  for (const b of plan.bookings) {
    if (!b.classKey?.startsWith("new:") || createdClasses[b.classKey]) continue;
    if (b.intent !== "attendance" && b.intent !== "same_start_visit" && b.intent !== "booking_only") continue;
    needed.set(b.classKey, { label: b.offeringLabel, venueKey: b.classKey.split("|").pop() ?? "club" });
  }
  const perOffering = new Map<string, string[]>();
  for (const [key, v] of needed) {
    const c = await tx.class.create({
      data: {
        tenantId,
        name: v.label.slice(0, 120),
        description: "Past sessions imported from a TeamUp attendance export. Not on the timetable.",
        duration: null,
        isActive: false,
        sourceImportJobId: jobId,
        locationId: v.venueKey.startsWith("loc:") ? v.venueKey.slice(4) : null,
      },
      select: { id: true },
    });
    createdClasses[key] = c.id;
    perOffering.set(v.label, [...(perOffering.get(v.label) ?? []), c.id]);
  }
  // A single-venue offering remembers its class for the next export of the club.
  for (const [label, ids] of perOffering) {
    const d = inputs.decisions.offering[label];
    if (ids.length === 1 && d?.action === "new_class" && !d.targetId) {
      await tx.importSourceMapping.updateMany({ where: { tenantId, source: LEDGER_SOURCE, kind: "offering", sourceKey: label }, data: { targetId: ids[0] } });
    }
  }
}

type LedgerRow = {
  id: string;
  bookingKey: string;
  status: string;
  rawStatus: string;
  rowFingerprint: string;
  sourceSnapshotAt: Date | null;
  memberId: string | null;
  matchMethod: string | null;
  classInstanceId: string | null;
  attendanceRecordId: string | null;
  attendanceOwned: boolean;
  disposition: string;
  createdByJobId: string;
  lastJobId: string;
  previousState: Prisma.JsonValue | null;
};

const LEDGER_SELECT = {
  id: true, bookingKey: true, status: true, rawStatus: true, rowFingerprint: true, sourceSnapshotAt: true, memberId: true, matchMethod: true,
  classInstanceId: true, attendanceRecordId: true, attendanceOwned: true, disposition: true, createdByJobId: true, lastJobId: true, previousState: true,
} as const;

/**
 * What a rollback needs to put a booking back: the row as it was (nested, so
 * rolling back several imports in turn restores each layer), whether THIS job
 * deleted the visit the row owned (only then may a rollback recreate it), and
 * which import originally created that visit.
 */
function snapshotOf(prior: LedgerRow, extra: { removedByThisJob?: boolean; attendanceImportJobId?: string | null } = {}) {
  return { ...prior, attendanceImportJobId: prior.attendanceOwned ? prior.createdByJobId : null, ...extra } as unknown as Prisma.InputJsonValue;
}

/** One batch: ledger rows, the sessions they need, and the attendance they become. */
export async function processBatch(
  tx: Tx,
  ctx: { tenantId: string; jobId: string; snapshotAt: Date | null; now: Date },
  batch: PlannedBooking[],
  progress: Progress,
) {
  const { tenantId, jobId, snapshotAt } = ctx;
  const existing = new Map<string, LedgerRow>(
    (await tx.importedBooking.findMany({ where: { tenantId, source: LEDGER_SOURCE, bookingKey: { in: batch.map((b) => b.bookingKey) } }, select: LEDGER_SELECT }))
      .map((r) => [r.bookingKey, r]),
  );

  // Sessions: find every slot the batch refers to; create the ones attendance needs.
  const slotOf = (b: PlannedBooking) => (b.classKey && !b.classKey.startsWith("new:") ? { classId: b.classKey, date: dayMarkerFor(b.localDate), startTime: b.localTime } : null);
  const slotKey = (s: { classId: string; date: Date; startTime: string }) => `${s.classId}|${s.date.toISOString()}|${s.startTime}`;
  const wantsAttendance = (b: PlannedBooking) => b.intent === "attendance" || b.intent === "same_start_visit";
  const slots = new Map<string, { classId: string; date: Date; startTime: string }>();
  for (const b of batch) {
    if (!b.sessionKey) continue;
    const s = slotOf(b);
    if (s) slots.set(slotKey(s), s);
  }
  const findSlots = async () =>
    slots.size
      ? tx.classInstance.findMany({
          where: { class: { tenantId }, OR: [...slots.values()].map((s) => ({ classId: s.classId, date: s.date, startTime: s.startTime })) },
          select: { id: true, classId: true, date: true, startTime: true },
        })
      : [];
  const before = await findSlots();
  const have = new Set(before.map(slotKey));
  const missing = new Map<string, { classId: string; date: Date; startTime: string }>();
  for (const b of batch) {
    if (!wantsAttendance(b) || !b.memberId) continue;
    const s = slotOf(b);
    if (s && !have.has(slotKey(s))) missing.set(slotKey(s), s);
  }
  if (missing.size) {
    // Past sessions only (the plan holds back anything not yet started); end time unknown.
    const res = await tx.classInstance.createMany({
      data: [...missing.values()].map((s) => ({ ...s, endTime: null, sourceImportJobId: jobId })),
      skipDuplicates: true,
    });
    progress.sessionsCreated += res.count;
  }
  const after = missing.size ? await findSlots() : before;
  const instanceBySlot = new Map(after.map((x) => [slotKey(x), x.id]));
  const instanceOf = (b: PlannedBooking) => { const s = slotOf(b); return s ? instanceBySlot.get(slotKey(s)) ?? null : null; };

  // Attendance already at each (member, instant): live check-ins, earlier imports, or this batch.
  const memberIds = [...new Set(batch.filter((b) => b.memberId && wantsAttendance(b)).map((b) => b.memberId!))];
  const dates = [...new Set(batch.filter((b) => wantsAttendance(b)).map((b) => dayMarkerFor(b.localDate).toISOString()))].map((d) => new Date(d));
  const visitAt = new Map<string, { id: string; classInstanceId: string }>();
  if (memberIds.length && dates.length) {
    const recs = await tx.attendanceRecord.findMany({
      where: { tenantId, memberId: { in: memberIds }, classInstance: { date: { in: dates } } },
      select: { id: true, memberId: true, classInstanceId: true, classInstance: { select: { date: true, startTime: true } } },
    });
    for (const r of recs) visitAt.set(`${r.memberId}|${r.classInstance.date.toISOString()}|${r.classInstance.startTime}`, { id: r.id, classInstanceId: r.classInstanceId });
  }
  const visitKey = (b: PlannedBooking) => `${b.memberId}|${dayMarkerFor(b.localDate).toISOString()}|${b.localTime}`;
  // Every visit a ledger row points at: is it still there? An owned one that
  // is gone was removed by staff; a linked one that is gone (its owner's
  // booking was corrected, or staff removed it) is looked for again.
  const linkedIds = [...existing.values()].filter((e) => e.attendanceRecordId).map((e) => e.attendanceRecordId!);
  const stillThere = new Set(linkedIds.length ? (await tx.attendanceRecord.findMany({ where: { tenantId, id: { in: linkedIds } }, select: { id: true } })).map((r) => r.id) : []);

  const tally = (d: Disposition) => { progress.dispositions[d] = (progress.dispositions[d] ?? 0) + 1; };
  const newRecords: Prisma.AttendanceRecordCreateManyInput[] = [];
  const newBookings: Prisma.ImportedBookingCreateManyInput[] = [];

  /** Attendance for a booking that should have it: link to a visit already there, or create one. */
  const attend = async (b: PlannedBooking, instanceId: string): Promise<{ id: string; owned: boolean }> => {
    const there = visitAt.get(visitKey(b));
    if (there) { progress.attendanceLinked += 1; return { id: there.id, owned: false }; }
    // Written in bulk at the end of the batch (same transaction); the id is
    // made here so the booking can point at it without reading it back.
    const rec = { id: randomUUID() };
    newRecords.push({
      id: rec.id, tenantId, memberId: b.memberId!, classInstanceId: instanceId,
      // The session start: the export records no check-in instant (Checkin
      // Timestamp is empty). It dates the visit; the ledger keeps that the
      // actual check-in time is unknown, and screens label the row "imported".
      checkInTime: new Date(b.startUtc),
      checkInMethod: "import",
      importJobId: jobId,
      sourceRowId: `row:${b.record}`,
    });
    visitAt.set(visitKey(b), { id: rec.id, classInstanceId: instanceId });
    progress.attendanceCreated += 1;
    return { id: rec.id, owned: true };
  };

  const sourceFields = (b: PlannedBooking) => ({
    sourcePersonKey: b.personKey, sourceName: b.sourceName.slice(0, 300), sourceEmail: b.sourceEmail || null,
    startsAt: new Date(b.startUtc), startsAtRaw: b.startRaw, offeringLabel: b.offeringLabel, venueLabel: b.venueLabel,
    instructorsRaw: b.instructors || null, bookingMethod: b.bookingMethod || null, bookingSource: b.bookingSource || null,
    customerMembershipRef: b.customerMembershipRef || null, membershipRef: b.membershipRef || null, membershipName: b.membershipName || null,
    checkinAtRaw: b.checkinRaw || null,
  });

  /** Disposition, instance and attendance a booking should have now. */
  const resolve = async (b: PlannedBooking, prior: LedgerRow | null) => {
    const instanceId = b.sessionKey ? instanceOf(b) : null;
    if (wantsAttendance(b) && b.memberId && instanceId) {
      // Keep the visit this booking already owns, if it is still there.
      if (prior?.attendanceRecordId && stillThere.has(prior.attendanceRecordId) && isAttendanceDisposition(prior.disposition) && prior.memberId === b.memberId) {
        return { disposition: prior.disposition as Disposition, classInstanceId: prior.classInstanceId, attendanceRecordId: prior.attendanceRecordId, attendanceOwned: prior.attendanceOwned };
      }
      const a = await attend(b, instanceId);
      return { disposition: (a.owned ? "attendance_created" : "attendance_existing") as Disposition, classInstanceId: instanceId, attendanceRecordId: a.id, attendanceOwned: a.owned };
    }
    const d: Disposition = wantsAttendance(b) ? "pending_person" : (targetDisposition(b.intent) as Disposition);
    // A booking that is not a visit keeps the session it was linked to: a
    // session another import later created at that slot is not a change in
    // the source, and must not make a replay rewrite the row (it would then
    // look "changed by a later import" to a rollback).
    return { disposition: d, classInstanceId: prior ? prior.classInstanceId : instanceId, attendanceRecordId: null, attendanceOwned: false };
  };

  for (const b of batch) {
    const prior = existing.get(b.bookingKey) ?? null;
    if (!prior) {
      const r = await resolve(b, null);
      newBookings.push({
        tenantId, source: LEDGER_SOURCE, bookingKey: b.bookingKey, ...sourceFields(b),
        status: b.status, rawStatus: b.rawStatus, rowFingerprint: b.fingerprint, sourceSnapshotAt: snapshotAt,
        memberId: b.memberId, matchMethod: b.matchMethod, ...r, createdByJobId: jobId, lastJobId: jobId,
      });
      progress.created += 1;
      tally(r.disposition);
      continue;
    }

    // A visit the import made and staff have since removed stays removed —
    // whatever later exports say. Marking it is bookkeeping, not a change in
    // the source, so it carries no previousState and no lastJobId: a rollback
    // of this run can never bring the visit back.
    const removedByStaff = prior.attendanceOwned && !!prior.attendanceRecordId && !stillThere.has(prior.attendanceRecordId);
    if (removedByStaff || prior.disposition === "staff_removed") {
      if (prior.disposition !== "staff_removed") await tx.importedBooking.update({ where: { id: prior.id }, data: { disposition: "staff_removed" } });
      // The source's newer status is still recorded (the visit stays removed).
      const fresher = prior.status !== b.status && !!snapshotAt && (!prior.sourceSnapshotAt || snapshotAt > prior.sourceSnapshotAt);
      if (fresher) {
        await tx.importedBooking.update({
          where: { id: prior.id },
          data: { status: b.status, rawStatus: b.rawStatus, sourceSnapshotAt: snapshotAt, rowFingerprint: b.fingerprint, lastJobId: jobId, previousState: snapshotOf({ ...prior, disposition: "staff_removed" }) },
        });
      }
      progress.protected += 1;
      tally("staff_removed");
      continue;
    }

    // A different status is applied only from a NEWER export; an older or
    // same-time export never overwrites the fact a newer one set.
    const statusChanged = prior.status !== b.status;
    if (statusChanged) {
      const fresher = !!snapshotAt && (!prior.sourceSnapshotAt || snapshotAt > prior.sourceSnapshotAt);
      if (!fresher) { progress.stale += 1; tally(prior.disposition as Disposition); continue; }
    }
    const r = await resolve(b, prior);
    const unchanged = !statusChanged && r.disposition === prior.disposition && r.attendanceRecordId === prior.attendanceRecordId && prior.memberId === b.memberId && r.classInstanceId === prior.classInstanceId;
    if (unchanged) { progress.unchanged += 1; tally(r.disposition); continue; }

    // A source correction away from "attended": the visit this import made
    // goes — unless another booking still counts it (the same person booked
    // two offerings at that start), which then owns it instead.
    let removedByThisJob = false;
    let removedVisitImportJobId: string | null = null;
    if (prior.attendanceOwned && prior.attendanceRecordId && prior.attendanceRecordId !== r.attendanceRecordId && stillThere.has(prior.attendanceRecordId)) {
      const heir = await tx.importedBooking.findFirst({
        where: { tenantId, source: LEDGER_SOURCE, attendanceRecordId: prior.attendanceRecordId, id: { not: prior.id }, disposition: { in: ["attendance_created", "attendance_existing"] } },
        select: LEDGER_SELECT,
      });
      if (heir) {
        await tx.importedBooking.update({ where: { id: heir.id }, data: { attendanceOwned: true, disposition: "attendance_created", lastJobId: jobId, previousState: snapshotOf(heir) } });
      } else {
        // Which import made that visit: a rollback that brings it back gives it
        // back to that import (so rolling that one back removes it in turn).
        const gone = await tx.attendanceRecord.findFirst({ where: { id: prior.attendanceRecordId, tenantId }, select: { importJobId: true } });
        await tx.attendanceRecord.deleteMany({ where: { id: prior.attendanceRecordId, tenantId, checkInMethod: "import" } });
        removedByThisJob = true;
        removedVisitImportJobId = gone?.importJobId ?? null;
      }
    }
    await tx.importedBooking.update({
      where: { id: prior.id },
      data: {
        ...(statusChanged ? { status: b.status, rawStatus: b.rawStatus, sourceSnapshotAt: snapshotAt } : {}),
        rowFingerprint: b.fingerprint,
        memberId: b.memberId, matchMethod: b.matchMethod, ...r,
        lastJobId: jobId,
        previousState: snapshotOf(prior, removedByThisJob ? { removedByThisJob, attendanceImportJobId: removedVisitImportJobId } : {}),
      },
    });
    progress.updated += 1;
    tally(r.disposition);
  }

  // Visits first, then the bookings that point at them. A booking key already
  // present (a concurrent writer) is skipped, never duplicated; the unique key
  // on (tenantId, source, bookingKey) is the guarantee.
  if (newRecords.length) await tx.attendanceRecord.createMany({ data: newRecords });
  if (newBookings.length) {
    const res = await tx.importedBooking.createMany({ data: newBookings, skipDuplicates: true });
    if (res.count !== newBookings.length) throw new Error("Another import wrote some of these bookings at the same moment. Run the step again.");
  }
}

export type StepResult =
  | { kind: "busy" }
  | { kind: "not_found" }
  | { kind: "progress"; processed: number; total: number; progress: Progress }
  | { kind: "complete"; manifest: Record<string, unknown> }
  | { kind: "failed"; error: string; processed: number; total: number };

/**
 * One step of a commit: claim the lease, work through batches from the
 * checkpoint until the time budget is spent, write each batch with its
 * checkpoint atomically, release. Safe to call again at any time.
 */
export async function runStep(tenantId: string, jobId: string, readFile: (url: string) => Promise<string | null>): Promise<StepResult> {
  const token = await withTenantContext(tenantId, (tx) => claimLease(tx, tenantId, jobId, ["running", "failed"]));
  if (!token) {
    const job = await withTenantContext(tenantId, (tx) => tx.importJob.findFirst({ where: { id: jobId, tenantId, source: JOB_SOURCE }, select: { status: true } }));
    return job ? { kind: "busy" } : { kind: "not_found" };
  }
  const started = Date.now();
  let processed = 0;
  let total = 0;
  try {
    const job = await withTenantContext(tenantId, (tx) => tx.importJob.findFirstOrThrow({ where: { id: jobId, tenantId } }));
    const mappings = (job.mappings ?? { createdClasses: {}, snapshotAt: null }) as JobMappings;
    const text = await readFile(job.fileBlobUrl);
    if (text === null) throw new Error("The uploaded file is no longer stored. Upload it again.");
    const live = await withTenantContext(tenantId, (tx) => loadClubInputs(tx, tenantId));
    const inputs: ClubInputs = mappings.decisions ? { ...live, decisions: mappings.decisions } : live;
    const now = job.startedAt ?? new Date();
    const built = buildPlan(text, inputs, now, mappings.createdClasses);
    if (built.errors) throw new Error(built.errors.join(" "));
    const bookings = built.plan.bookings;
    total = bookings.length;
    processed = job.processedRows;
    const snapshotAt = job.sourceExportedAt;
    const progress: Progress = { ...emptyProgress(), ...((job.manifest as { progress?: Progress } | null)?.progress ?? {}) };
    if (job.status === "failed") {
      await withTenantContext(tenantId, (tx) => tx.importJob.update({ where: { id: jobId }, data: { status: "running" } }));
    }

    while (processed < total && Date.now() - started < STEP_BUDGET_MS) {
      const slice = bookings.slice(processed, processed + BATCH);
      const next = processed + slice.length;
      const p: Progress = JSON.parse(JSON.stringify(progress));
      await withTenantContext(
        tenantId,
        async (tx) => {
          await processBatch(tx, { tenantId, jobId, snapshotAt, now }, slice, p);
          // The checkpoint moves with the batch, in the same transaction.
          const moved = await tx.importJob.updateMany({
            where: { id: jobId, tenantId, leaseToken: token, processedRows: processed },
            data: {
              processedRows: next,
              leaseUntil: new Date(Date.now() + LEASE_MS),
              manifest: { kind: "attendance", inProgress: true, progress: p } as unknown as Prisma.InputJsonValue,
            },
          });
          if (moved.count !== 1) throw new Error("Lost the import lease — another step took over.");
        },
        { timeout: 60_000, maxWait: 15_000 },
      );
      Object.assign(progress, p);
      processed = next;
    }

    if (processed < total) {
      await withTenantContext(tenantId, (tx) => releaseLease(tx, tenantId, jobId, token));
      return { kind: "progress", processed, total, progress };
    }

    // Done: the manifest is read back from the database, not from the counters.
    const manifest = await withTenantContext(tenantId, (tx) => finalManifest(tx, tenantId, jobId, built.plan, progress, mappings), { timeout: 60_000 });
    await withTenantContext(tenantId, (tx) =>
      releaseLease(tx, tenantId, jobId, token, {
        status: "complete",
        completedAt: new Date(),
        totalRows: built.plan.totals.inputRows,
        processedRows: total,
        importedRows: progress.attendanceCreated,
        skippedRows: progress.unchanged + progress.stale + built.plan.duplicates.length,
        errorRows: built.plan.rejected.length,
        manifest: manifest as unknown as Prisma.InputJsonValue,
      }),
    );
    return { kind: "complete", manifest };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Import step failed";
    console.error(`[attendance-import ${jobId}] step failed`, e);
    await withTenantContext(tenantId, (tx) =>
      releaseLease(tx, tenantId, jobId, token, { status: "failed", errorLog: [{ row: 0, reason: msg.slice(0, 500) }] as unknown as Prisma.InputJsonValue }),
    ).catch(() => {});
    return { kind: "failed", error: msg, processed, total };
  }
}

async function finalManifest(tx: Tx, tenantId: string, jobId: string, plan: AttendancePlan, progress: Progress, mappings: JobMappings) {
  const touched = await tx.importedBooking.groupBy({
    by: ["disposition", "status"],
    where: { tenantId, source: LEDGER_SOURCE, OR: [{ createdByJobId: jobId }, { lastJobId: jobId }] },
    _count: { _all: true },
  });
  const attendanceOwned = await tx.attendanceRecord.count({ where: { tenantId, importJobId: jobId } });
  const sessionsCreated = await tx.classInstance.count({ where: { class: { tenantId }, sourceImportJobId: jobId } });
  const classesCreated = await tx.class.count({ where: { tenantId, sourceImportJobId: jobId } });
  const outcomes = progress.created + progress.updated + progress.unchanged + progress.stale + progress.protected;
  return {
    kind: "attendance",
    mappingVersion: MAPPING_VERSION,
    input: { rows: plan.totals.inputRows, bookings: plan.bookings.length, duplicates: plan.duplicates.length, rejected: plan.rejected.length },
    outcomes: { created: progress.created, updated: progress.updated, unchanged: progress.unchanged, stale: progress.stale, protected: progress.protected },
    dispositions: progress.dispositions,
    ledgerByDispositionAndStatus: touched.map((t) => ({ disposition: t.disposition, status: t.status, count: t._count._all })),
    attendance: { createdByThisImport: attendanceOwned, linkedToExisting: progress.attendanceLinked },
    sessions: { created: sessionsCreated },
    classes: { created: classesCreated, createdClasses: mappings.createdClasses },
    // Every row of the file: one booking outcome, a duplicate, or a rejection.
    reconciles: outcomes + plan.duplicates.length + plan.rejected.length === plan.totals.inputRows,
    progress,
  };
}

// ── Rollback ─────────────────────────────────────────────────────────────────

type PreviousState = Omit<LedgerRow, "previousState"> & { previousState?: Prisma.JsonValue | null; attendanceImportJobId?: string | null; removedByThisJob?: boolean };

/**
 * Undo one attendance import, conservatively. Removes the bookings it created
 * that nothing changed since, the visits it created for them, then the
 * sessions and classes it created that nothing else uses. Bookings it UPDATED
 * go back to how they were. Bookings a later import changed are kept.
 */
export async function rollbackJob(tx: Tx, tenantId: string, jobId: string) {
  const report = { bookingsRemoved: 0, bookingsRestored: 0, bookingsKeptLaterImport: 0, attendanceRemoved: 0, attendanceRestored: 0, attendanceKeptInUse: 0, sessionsRemoved: 0, sessionsKept: 0, classesRemoved: 0, classesKept: 0 };

  // 1. Created here, untouched since. Their visits go in step 4, once no
  //    remaining booking (of any import) points at them.
  const own = await tx.importedBooking.findMany({ where: { tenantId, source: LEDGER_SOURCE, createdByJobId: jobId, lastJobId: jobId }, select: { id: true } });
  for (let i = 0; i < own.length; i += 1000) {
    // Re-checked in the delete itself: a row another import touched meanwhile is not this job's to remove.
    await tx.importedBooking.deleteMany({ where: { tenantId, createdByJobId: jobId, lastJobId: jobId, id: { in: own.slice(i, i + 1000).map((r) => r.id) } } });
  }
  report.bookingsRemoved = own.length;

  // 2. Created here, changed by a later import: kept.
  report.bookingsKeptLaterImport = await tx.importedBooking.count({ where: { tenantId, source: LEDGER_SOURCE, createdByJobId: jobId, NOT: { lastJobId: jobId } } });

  // 3. Changed here, created earlier: restore the previous state.
  const changed = await tx.importedBooking.findMany({ where: { tenantId, source: LEDGER_SOURCE, lastJobId: jobId, NOT: { createdByJobId: jobId } }, select: { id: true, previousState: true, attendanceRecordId: true, attendanceOwned: true } });
  for (const row of changed) {
    const prev = row.previousState as PreviousState | null;
    if (!prev) continue;
    let attendanceRecordId = prev.attendanceRecordId;
    let disposition = prev.disposition;
    const exists = prev.attendanceRecordId ? (await tx.attendanceRecord.count({ where: { id: prev.attendanceRecordId, tenantId } })) > 0 : false;
    if (prev.attendanceRecordId && !exists) {
      if (prev.removedByThisJob && prev.memberId && prev.classInstanceId) {
        // The visit THIS job deleted (a source correction) comes back, owned by the import that first made it.
        const booking = await tx.importedBooking.findUnique({ where: { id: row.id }, select: { startsAt: true } });
        const rec = await tx.attendanceRecord.create({
          data: { tenantId, memberId: prev.memberId, classInstanceId: prev.classInstanceId, checkInTime: booking!.startsAt, checkInMethod: "import", importJobId: prev.attendanceImportJobId ?? prev.createdByJobId, sourceRowId: null },
          select: { id: true },
        });
        attendanceRecordId = rec.id;
        report.attendanceRestored += 1;
      } else if (prev.attendanceOwned) {
        // Gone, and not by this job: staff removed it. It stays removed.
        disposition = "staff_removed";
      } else {
        // A link to a visit that no longer exists: found again on the next import.
        attendanceRecordId = null;
        disposition = "pending_person";
      }
    }
    await tx.importedBooking.update({
      where: { id: row.id },
      data: {
        status: prev.status, rawStatus: prev.rawStatus, rowFingerprint: prev.rowFingerprint,
        sourceSnapshotAt: prev.sourceSnapshotAt ? new Date(prev.sourceSnapshotAt) : null,
        memberId: prev.memberId, matchMethod: prev.matchMethod, classInstanceId: prev.classInstanceId,
        attendanceRecordId, attendanceOwned: prev.attendanceOwned && !!attendanceRecordId, disposition, lastJobId: prev.lastJobId,
        // One layer back: the state before that one stays, so rolling back the
        // previous import afterwards restores it too.
        previousState: (prev.previousState ?? Prisma.DbNull) as Prisma.InputJsonValue,
      },
    });
    report.bookingsRestored += 1;
  }

  // 4. Any other visit this job created that no remaining booking points at.
  const referenced = new Set(
    (await tx.importedBooking.findMany({ where: { tenantId, source: LEDGER_SOURCE, attendanceRecordId: { not: null } }, select: { attendanceRecordId: true } }))
      .map((r) => r.attendanceRecordId!),
  );
  const mine = (await tx.attendanceRecord.findMany({ where: { tenantId, importJobId: jobId }, select: { id: true } })).map((r) => r.id);
  const leftovers = mine.filter((id) => !referenced.has(id));
  report.attendanceKeptInUse = mine.length - leftovers.length;
  for (let i = 0; i < leftovers.length; i += 1000) {
    const del = await tx.attendanceRecord.deleteMany({ where: { tenantId, id: { in: leftovers.slice(i, i + 1000) } } });
    report.attendanceRemoved += del.count;
  }

  // 5. Sessions this job created that nothing uses now.
  const sessions = await tx.classInstance.findMany({ where: { class: { tenantId }, sourceImportJobId: jobId }, select: { id: true, _count: { select: { attendances: true, waitlists: true } } } });
  const removable = sessions.filter((s) => s._count.attendances === 0 && s._count.waitlists === 0).map((s) => s.id);
  const stillLinked = new Set(
    removable.length ? (await tx.importedBooking.findMany({ where: { tenantId, classInstanceId: { in: removable } }, select: { classInstanceId: true } })).map((r) => r.classInstanceId!) : [],
  );
  const drop = removable.filter((id) => !stillLinked.has(id));
  for (let i = 0; i < drop.length; i += 1000) {
    const del = await tx.classInstance.deleteMany({ where: { id: { in: drop.slice(i, i + 1000) }, class: { tenantId }, sourceImportJobId: jobId } });
    report.sessionsRemoved += del.count;
  }
  report.sessionsKept = sessions.length - report.sessionsRemoved;

  // 6. Historical classes this job created that hold no sessions now.
  const classes = await tx.class.findMany({
    where: { tenantId, sourceImportJobId: jobId },
    select: { id: true, _count: { select: { instances: true, schedules: true, subscriptions: true, rosterMembers: true } } },
  });
  for (const c of classes) {
    // Anything staff have since attached (a session, a schedule, a subscriber, a roster) keeps the class.
    if (c._count.instances + c._count.schedules + c._count.subscriptions + c._count.rosterMembers > 0) { report.classesKept += 1; continue; }
    await tx.importSourceMapping.updateMany({ where: { tenantId, source: LEDGER_SOURCE, kind: "offering", targetId: c.id }, data: { targetId: null } });
    await tx.class.delete({ where: { id: c.id } });
    report.classesRemoved += 1;
  }
  // The names the import history reads (components/dashboard/ImportHistory.tsx).
  return { ...report, recordsRemoved: report.attendanceRemoved, instancesRemoved: report.sessionsRemoved, instancesKept: report.sessionsKept };
}
