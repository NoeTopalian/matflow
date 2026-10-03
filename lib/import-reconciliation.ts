/**
 * Independent reconciliation of one member import (3 Oct 2026, Total BJJ
 * handover).
 *
 * The importer writes a manifest of what it believes it did. This module does
 * NOT trust that manifest: it re-reads the club's own rows — the members that
 * carry the job's id, the job's ImportedMembership ledger, the club's tiers,
 * and anything attached to those members since — and compares what it counts
 * with what the importer claimed. It shares no counting code with the importer
 * (the live-entitlement list and the tier-name rule are restated here on
 * purpose), so a bug in the importer's tally cannot hide itself.
 *
 * Read-only. Tenant-scoped: every read goes through withTenantContext and
 * filters on tenantId. The result carries counts, category labels the club
 * itself chose (plan names, statuses) and source row numbers — never a name,
 * email, phone or date of birth.
 *
 * Three kinds of check:
 *  - "invariant": must hold for as long as the import stands. A ✗ is a defect.
 *  - "baseline": true at the moment of import; legitimately moves once the club
 *    uses MatFlow (a payment, a check-in, a guardian confirmed). A mismatch
 *    reads "changed since import", not "broken".
 *  - "info": a count with no expectation, shown so the owner can sanity-check.
 */
import type { Prisma } from "@prisma/client";
import { withTenantContext } from "@/lib/prisma-tenant";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

export type ReconKind = "invariant" | "baseline" | "info";

export interface ReconCheck {
  group: string;
  check: string;
  kind: ReconKind;
  expected: number | string | null;
  actual: number | string;
  /** null for "info" rows: there is nothing to pass or fail. */
  ok: boolean | null;
  note?: string;
  /** Source CSV row numbers behind a mismatch (header = row 1), capped. */
  sourceRows?: number[];
}

export interface PlanLabelLine {
  label: string;
  rows: number;
  liveRows: number;
  tierMatched: boolean;
}

export interface ReconciliationResult {
  job: {
    id: string;
    source: string;
    mode: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    rolledBack: boolean;
  };
  checks: ReconCheck[];
  planLabels: PlanLabelLine[];
  summary: { invariantsFailed: number; baselinesMoved: number; passed: number; info: number };
}

/** Everything the comparison needs, as read from the database. */
export interface ReconciliationInput {
  job: {
    id: string;
    source: string;
    mode: string;
    status: string;
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    errorRows: number;
    manifest: unknown;
    rolledBackAt: Date | null;
    createdAt: Date;
    completedAt: Date | null;
  };
  members: {
    id: string;
    accountType: string;
    status: string;
    paymentStatus: string;
    billedBy: string;
    membershipTierId: string | null;
    email: string;
    unverifiedEmail: string | null;
    name: string;
    dateOfBirth: Date | null;
    parentMemberId: string | null;
    guardianConfirmedAt: Date | null;
  }[];
  ledger: { sourceRow: number; memberId: string | null; planLabel: string; entitlement: string; disposition: string }[];
  tierNames: string[];
  paymentsAttached: number;
  attendanceAttached: number;
  waiversSigned: number;
}

// Restated, not imported from lib/importers: an independent check must not
// share the importer's definitions. Same meaning as LIVE_ENTITLEMENTS there.
const LIVE = new Set(["current", "scheduled", "held"]);
const ROW_CAP = 50;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function tally<T>(xs: T[], key: (x: T) => string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = key(x) ?? "(none)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const counts = (v: unknown): Record<string, number> => {
  const o = obj(v);
  if (!o) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(o)) if (typeof n === "number") out[k] = n;
  return out;
};

function invariant(group: string, check: string, expected: number | string | null, actual: number | string, note?: string, sourceRows?: number[]): ReconCheck {
  return {
    group, check, kind: "invariant", expected, actual,
    // An expectation the manifest never recorded cannot pass.
    ok: expected !== null && expected === actual,
    ...(note ? { note } : {}),
    ...(sourceRows && sourceRows.length ? { sourceRows: sourceRows.slice(0, ROW_CAP) } : {}),
  };
}

function baseline(group: string, check: string, expected: number | string, actual: number | string, note: string, sourceRows?: number[]): ReconCheck {
  return {
    group, check, kind: "baseline", expected, actual, ok: expected === actual, note,
    ...(sourceRows && sourceRows.length ? { sourceRows: sourceRows.slice(0, ROW_CAP) } : {}),
  };
}

function info(group: string, check: string, actual: number | string, note?: string): ReconCheck {
  return { group, check, kind: "info", expected: null, actual, ok: null, ...(note ? { note } : {}) };
}

/** One check per key of either tally, so a category that appears on only one side is caught. */
function tallyChecks(group: string, label: string, expected: Record<string, number>, actual: Record<string, number>, kind: "invariant" | "baseline", note: string): ReconCheck[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.map((k) =>
    kind === "invariant"
      ? invariant(group, `${label}: ${k}`, expected[k] ?? 0, actual[k] ?? 0, note)
      : baseline(group, `${label}: ${k}`, expected[k] ?? 0, actual[k] ?? 0, note),
  );
}

/**
 * The comparison. Pure — no database — so it is unit-tested with fixtures.
 */
export function compareReconciliation(input: ReconciliationInput): ReconciliationResult {
  const { job, members, ledger } = input;
  const m = obj(job.manifest) ?? {};
  const created = obj(m.created) ?? {};
  const inputM = obj(m.input) ?? {};
  const t2 = obj(m.teamup2);
  const t2Ledger = obj(t2?.ledger);
  const t2Exceptions = obj(t2?.exceptions);

  const checks: ReconCheck[] = [];
  const jobOut = {
    id: job.id,
    source: job.source,
    mode: job.mode,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    rolledBack: job.rolledBackAt !== null,
  };

  // ── The job itself ────────────────────────────────────────────────────────
  checks.push(invariant("Import", "Import finished", "complete", job.status));
  checks.push(invariant("Import", "Not rolled back", "no", job.rolledBackAt ? "yes" : "no"));

  if (job.mode === "refresh") {
    checks.push(info("Import", "Status refresh", "not reconciled here", "A status refresh changes standing on people an earlier import created. Reconcile that import instead."));
    return finish(jobOut, checks, []);
  }

  checks.push(invariant("Import", "Importer's own balance check", "true", m.reconciles === true ? "true" : m.reconciles === false ? "false" : "not recorded",
    "The manifest's own claim that every person was created, already in the club, or refused."));

  const people = num(inputM.people);
  const commitErrors = num(m.commitErrors);
  const parseErrors = num(inputM.parseErrors);
  const sourceNote = "Counted from the members carrying this import's id, not from the importer's counters. A member deleted since the import lowers it.";

  // ── People ────────────────────────────────────────────────────────────────
  checks.push(invariant("People", "Members created (manifest)", num(created.total), members.length, sourceNote));
  checks.push(invariant("People", "Members created (job counter)", job.importedRows, members.length, sourceNote));
  checks.push(invariant("People", "Every person accounted for (created + already in club + refused)",
    people, members.length + job.skippedRows + (commitErrors ?? 0),
    "People in the file versus members found now, plus those the job says were already in the club or refused."));
  checks.push(invariant("People", "Rows refused (job counter vs manifest)",
    parseErrors === null || commitErrors === null ? null : parseErrors + commitErrors, job.errorRows));
  checks.push(invariant("People", "People read (job counter vs manifest)", people !== null && parseErrors !== null ? people + parseErrors : null, job.totalRows));

  const editsNote = "As of now. A member edited, cancelled or deleted since the import moves this count.";
  checks.push(...tallyChecks("People", "By account type", counts(created.byAccountType), tally(members, (x) => x.accountType), "invariant", "Account type is fixed at import."));
  checks.push(...tallyChecks("People", "By status", counts(created.byStatus), tally(members, (x) => x.status), "baseline", editsNote));
  checks.push(...tallyChecks("People", "By payment status", counts(created.byPaymentStatus), tally(members, (x) => x.paymentStatus), "baseline", editsNote));

  const billedByExpected = job.source === "teamup" ? "teamup" : "matflow";
  const billedBy = tally(members, (x) => x.billedBy);
  checks.push(baseline("People", `Billed by ${billedByExpected === "teamup" ? "TeamUp" : "MatFlow"}`, members.length, billedBy[billedByExpected] ?? 0,
    billedByExpected === "teamup"
      ? "Every member a TeamUp import creates stays billed by TeamUp until the cutover moves them."
      : "Members created by this import are billed by MatFlow."));
  for (const [k, n] of Object.entries(billedBy)) if (k !== billedByExpected) checks.push(info("People", `Billed by: ${k}`, n));

  // ── Plans and the ledger ──────────────────────────────────────────────────
  const tierSet = new Set(input.tierNames.map(norm));
  const rowsByMember = new Map<string, number[]>();
  for (const r of ledger) if (r.memberId) rowsByMember.set(r.memberId, [...(rowsByMember.get(r.memberId) ?? []), r.sourceRow]);
  const rowsOf = (ids: string[]) => ids.flatMap((id) => rowsByMember.get(id) ?? []).sort((a, b) => a - b);

  const planLabels: PlanLabelLine[] = [];
  if (ledger.length > 0) {
    const byLabel = new Map<string, PlanLabelLine>();
    for (const r of ledger) {
      const label = r.planLabel.trim();
      const line = byLabel.get(norm(label)) ?? { label, rows: 0, liveRows: 0, tierMatched: tierSet.has(norm(label)) };
      line.rows += 1;
      if (LIVE.has(r.entitlement)) line.liveRows += 1;
      byLabel.set(norm(label), line);
    }
    planLabels.push(...[...byLabel.values()].sort((a, b) => b.liveRows - a.liveRows || a.label.localeCompare(b.label, "en-GB")));

    const liveMemberIds = new Set(ledger.filter((r) => r.memberId && LIVE.has(r.entitlement)).map((r) => r.memberId!));
    const untiered = members.filter((x) => liveMemberIds.has(x.id) && !x.membershipTierId).map((x) => x.id);
    const unmatchedLive = planLabels.filter((l) => l.liveRows > 0 && !l.tierMatched);
    const reportedAtCommit = Array.isArray(t2Exceptions?.unmatchedPlanLabels) ? (t2Exceptions!.unmatchedPlanLabels as unknown[]).length : null;
    checks.push(baseline("Plans", "Plan labels on live rows with no tier of that name today", 0, unmatchedLive.length,
      `Matched by name, trimmed, ignoring case. ${reportedAtCommit === null ? "" : `The importer reported ${reportedAtCommit} at commit. `}Create or rename a tier to match, then place the members.`));
    checks.push(baseline("Plans", "Members on a live plan with no tier", 0, untiered.length,
      "A live member without a tier is not counted under any tier and cannot be billed by MatFlow until placed.", rowsOf(untiered)));

    checks.push(invariant("Ledger", "Source rows recorded (manifest vs ledger)", num(t2Ledger?.rows), ledger.length,
      "One ledger row per CSV record; every record has exactly one disposition."));
    checks.push(...tallyChecks("Ledger", "By entitlement", counts(t2Ledger?.byEntitlement), tally(ledger, (r) => r.entitlement), "invariant",
      "A member deleted since the import takes their ledger rows with them."));
    const orphanHistory = ledger.filter((r) => r.disposition === "member_history" && !r.memberId).map((r) => r.sourceRow).sort((a, b) => a - b);
    checks.push(invariant("Ledger", "Member-history rows with no member", 0, orphanHistory.length,
      "A row the importer kept as someone's history but could not attach to a member.", orphanHistory));
  } else {
    checks.push(info("Plans", "Source ledger", "none", "This import kept no per-row ledger (only TeamUp imports do), so plan checks are skipped."));
  }

  // ── Family ────────────────────────────────────────────────────────────────
  const linked = members.filter((x) => x.parentMemberId);
  const confirmed = linked.filter((x) => x.guardianConfirmedAt).map((x) => x.id);
  checks.push(info("Family", "Guardian links awaiting staff review", linked.length - confirmed.length,
    "An import only ever suggests a parent link; staff confirm it on the member's Family card."));
  checks.push(baseline("Family", "Guardian links confirmed", 0, confirmed.length,
    "An import never confirms a link. Any here were confirmed by staff after the import.", rowsOf(confirmed)));

  // ── Duplicates within the job ─────────────────────────────────────────────
  const groups = new Map<string, string[]>();
  for (const x of members) {
    const k = `${norm(x.name)}|${x.dateOfBirth ? x.dateOfBirth.toISOString().slice(0, 10) : ""}`;
    groups.set(k, [...(groups.get(k) ?? []), x.id]);
  }
  const dupWithDob = [...groups.entries()].filter(([k, ids]) => ids.length > 1 && !k.endsWith("|"));
  const dupNoDob = [...groups.entries()].filter(([k, ids]) => ids.length > 1 && k.endsWith("|"));
  checks.push(invariant("Duplicates", "Same name and date of birth, created twice", 0, dupWithDob.length,
    "Each is one person who may have been created twice (for example under two email addresses).", rowsOf(dupWithDob.flatMap(([, ids]) => ids))));
  checks.push(info("Duplicates", "Same name, no date of birth on file", dupNoDob.length,
    "Could be two people who share a name; check the source rows."));

  // ── Contact ───────────────────────────────────────────────────────────────
  const invented = members.filter((x) => isSynthesisedEmail(x.email));
  checks.push(info("Contact", "Members with no real email (MatFlow placeholder)", invented.length,
    "They cannot be sent an invite, a waiver link or a reminder until an address is added."));
  for (const [k, n] of Object.entries(tally(invented, (x) => x.accountType))) checks.push(info("Contact", `No real email: ${k}`, n));
  const missingEmailActive = num(t2Exceptions?.missingEmailActive);
  if (missingEmailActive !== null) {
    const actual = invented.filter((x) => x.accountType === "adult" && !x.unverifiedEmail && x.status === "active").map((x) => x.id);
    checks.push(baseline("Contact", "Active adults with no email at all", missingEmailActive, actual.length,
      "Compared with the importer's exception count. Moves when staff add an address or change a status.", rowsOf(actual)));
  }

  // ── Activity since the import ─────────────────────────────────────────────
  const activity = "Zero at the moment of import: an import brings no payments, check-ins or waivers. Rises as the club uses MatFlow.";
  checks.push(baseline("Since import", "Payments recorded for these members", 0, input.paymentsAttached, activity));
  checks.push(baseline("Since import", "Check-ins recorded for these members", 0, input.attendanceAttached, `${activity} An attendance-history import also raises it.`));
  checks.push(baseline("Since import", "Waivers signed by these members", 0, input.waiversSigned, activity));

  return finish(jobOut, checks, planLabels);
}

function finish(job: ReconciliationResult["job"], checks: ReconCheck[], planLabels: PlanLabelLine[]): ReconciliationResult {
  return {
    job,
    checks,
    planLabels,
    summary: {
      invariantsFailed: checks.filter((c) => c.kind === "invariant" && c.ok === false).length,
      baselinesMoved: checks.filter((c) => c.kind === "baseline" && c.ok === false).length,
      passed: checks.filter((c) => c.ok === true).length,
      info: checks.filter((c) => c.ok === null).length,
    },
  };
}

const ID_CHUNK = 1000;

async function countByMember(ids: string[], count: (chunk: string[]) => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) total += await count(ids.slice(i, i + ID_CHUNK));
  return total;
}

/** Every read the comparison needs, inside one tenant-scoped transaction. */
export async function gatherReconciliationInput(tx: Prisma.TransactionClient, tenantId: string, jobId: string): Promise<ReconciliationInput | null> {
  const job = await tx.importJob.findFirst({
    where: { id: jobId, tenantId },
    select: {
      id: true, source: true, mode: true, status: true, totalRows: true, importedRows: true, skippedRows: true,
      errorRows: true, manifest: true, rolledBackAt: true, createdAt: true, completedAt: true,
    },
  });
  if (!job) return null;
  const members = await tx.member.findMany({
    where: { tenantId, importJobId: jobId },
    select: {
      id: true, accountType: true, status: true, paymentStatus: true, billedBy: true, membershipTierId: true,
      email: true, unverifiedEmail: true, name: true, dateOfBirth: true, parentMemberId: true, guardianConfirmedAt: true,
    },
  });
  const ledger = await tx.importedMembership.findMany({
    where: { tenantId, importJobId: jobId },
    select: { sourceRow: true, memberId: true, planLabel: true, entitlement: true, disposition: true },
    orderBy: { sourceRow: "asc" },
  });
  const tiers = await tx.membershipTier.findMany({ where: { tenantId }, select: { name: true } });
  const ids = members.map((x) => x.id);
  const paymentsAttached = await countByMember(ids, (chunk) => tx.payment.count({ where: { tenantId, memberId: { in: chunk } } }));
  const attendanceAttached = await countByMember(ids, (chunk) => tx.attendanceRecord.count({ where: { tenantId, memberId: { in: chunk } } }));
  const waiversSigned = await countByMember(ids, (chunk) => tx.signedWaiver.count({ where: { tenantId, memberId: { in: chunk } } }));
  return { job, members, ledger, tierNames: tiers.map((t) => t.name), paymentsAttached, attendanceAttached, waiversSigned };
}

/**
 * Reconcile one import of this club. Null when the job is not this club's.
 */
export async function reconcileImport(tenantId: string, jobId: string): Promise<ReconciliationResult | null> {
  const input = await withTenantContext(tenantId, (tx) => gatherReconciliationInput(tx, tenantId, jobId));
  return input ? compareReconciliation(input) : null;
}

/** The club's create-mode imports, newest first, for the picker. No file names. */
export async function listReconcilableImports(tenantId: string) {
  const jobs = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findMany({
      where: { tenantId, mode: "create" },
      select: { id: true, source: true, status: true, createdAt: true, rolledBackAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  );
  return jobs.map((j) => ({ id: j.id, source: j.source, status: j.status, createdAt: j.createdAt.toISOString(), rolledBack: j.rolledBackAt !== null }));
}
