import type { MigrationReason, MigrationRow } from "@/lib/stripe/migrate-memberships";
import { cycleLabel } from "@/lib/billing-cycle";
import { csvRow } from "@/lib/csv";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

/**
 * The billing cutover manifest: one row per membership, built from a
 * migration PREVIEW, that a person signs before anything is applied and that
 * tells the club owner exactly what to do in the previous platform (TeamUp)
 * and by when.
 *
 * Pure: no Stripe, no database, no clock. The same preview rows and the same
 * timestamps always produce the same manifest, byte for byte, so a signed
 * manifest can be re-derived and compared.
 *
 * Two rules it exists to enforce:
 *
 *  - The PAYER is never inferred from a shared email. A preview matches a
 *    Stripe customer by email; that says whose customer it probably is, not who
 *    pays. Every payer is `verified: false` unless the input row carries an
 *    explicit payer link (a parent link or an owner confirmation recorded
 *    outside the preview). A junior without one is an exception.
 *  - The TeamUp action is written per decision, because the wrong one either
 *    double-charges a member or cancels the subscription MatFlow now bills on.
 *
 * See docs/runbooks/CUTOVER-MANIFEST-TEMPLATE.md for how it is produced and
 * signed off.
 */

/** Who acts in the previous platform. One named person, not "the club". */
export const SOURCE_ACTION_OWNER = "Sean";

/** The previous platform, as named on every row. */
export const SOURCE_PLATFORM = "TeamUp";

/**
 * A first MatFlow collection closer than this to the snapshot leaves too
 * little time to end the TeamUp membership safely, so it is an exception even
 * though the engine itself would accept an anchor one hour out.
 */
export const MIN_ACTION_LEAD_HOURS = 48;

/** A source export older than this at snapshot time is stale; re-export first. */
export const MAX_SOURCE_AGE_HOURS = 24;

/** The first live cohort is deliberately tiny. */
export const FIRST_COHORT_MAX = 5;

/**
 * An explicit record of who pays, from outside the preview: the member's
 * parent link, or an owner confirmation. Its absence means "unverified", never
 * "the person whose email matched".
 */
export type ManifestPayerLink = {
  payerMemberId: string;
  payerName: string;
  source: "parent_link" | "owner_confirmed";
};

/** A preview row, optionally carrying facts the preview does not know. */
export type ManifestInputRow = MigrationRow & {
  payerLink?: ManifestPayerLink | null;
  /** True for a junior membership. A synthesised `kid-…` email implies it. */
  isJunior?: boolean;
};

export type ManifestDecision = "adopt" | "replace" | "create" | "already_migrated" | "remain_on_source";

export type ManifestExceptionCode =
  | "on_hold"
  | "tier_mismatch"
  | "no_payment_method"
  | "other_live_subscription"
  | "period_end_too_soon"
  | "payer_unverified"
  | "not_ready";

export type ManifestException = { code: ManifestExceptionCode; detail: string };

export type ManifestPayer = {
  stripeCustomerId: string | null;
  payerMemberId: string | null;
  name: string | null;
  verified: boolean;
  basis: "explicit_link" | "email_match_unverified" | "none";
};

export type ManifestRow = {
  beneficiary: { memberId: string; name: string; junior: boolean };
  payer: ManifestPayer;
  stripe: {
    customerId: string | null;
    /** The subscription MatFlow bills on (adopt / already migrated); null until apply for create and replace. */
    subscriptionId: string | null;
    /** The TeamUp-created subscription that must stop (replace), or that is still live beside ours (already migrated). */
    sourceSubscriptionId: string | null;
    priceId: string | null;
  };
  tierName: string | null;
  amountPence: number | null;
  currency: string | null;
  cadence: string;
  /** amountPence as a calendar-month equivalent, rounded to the penny; null when the amount is unknown. */
  monthlyEquivalentPence: number | null;
  collectionController: "TeamUp" | "MatFlow" | "Both";
  /** YYYY-MM-DD (UTC). Null when the membership stays on the source. */
  firstMatflowCollectionDate: string | null;
  exceptions: ManifestException[];
  decision: ManifestDecision;
  /** The preview's skip reason, for remain_on_source. */
  decisionReason: MigrationReason | null;
  sourceAction: { text: string; owner: string; dueBy: string | null };
};

export type CutoverManifest = {
  snapshotAt: string;
  sourceExportedAt: string;
  sourceAgeHours: number;
  sourceStale: boolean;
  rows: ManifestRow[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayBefore(iso: string): string {
  return isoDay(new Date(new Date(iso).getTime() - DAY_MS));
}

function toDate(v: Date | string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(v)}`);
  return d;
}

/** Cycles per calendar month, as an exact fraction (numerator / denominator). */
function perMonth(cycle: string | null): [number, number] | null {
  switch (cycle) {
    case "weekly": return [52, 12];
    case "fortnightly": return [26, 12];
    case "four_weekly": return [13, 12];
    case "monthly": return [1, 1];
    case "annual": return [1, 12];
    case "none": return [0, 1];
    default: return null;
  }
}

export function monthlyEquivalentPence(amountPence: number | null, cycle: string | null): number | null {
  if (amountPence == null) return null;
  const f = perMonth(cycle);
  if (!f) return null;
  return Math.round((amountPence * f[0]) / f[1]);
}

function isJunior(row: ManifestInputRow): boolean {
  if (row.isJunior) return true;
  return isSynthesisedEmail(row.memberEmail) && row.memberEmail.toLowerCase().startsWith("kid-");
}

function payerOf(row: ManifestInputRow): ManifestPayer {
  if (row.payerLink) {
    return {
      stripeCustomerId: row.customerId,
      payerMemberId: row.payerLink.payerMemberId,
      name: row.payerLink.payerName,
      verified: true,
      basis: "explicit_link",
    };
  }
  // An email match names a customer, not a payer. A synthesised address
  // cannot even do that.
  const emailMatched = row.customerId !== null && !isSynthesisedEmail(row.memberEmail);
  return {
    stripeCustomerId: row.customerId,
    payerMemberId: null,
    name: null,
    verified: false,
    basis: emailMatched ? "email_match_unverified" : "none",
  };
}

function decisionOf(row: MigrationRow): ManifestDecision {
  if (row.action === "adopt" || row.action === "replace" || row.action === "create") return row.action;
  if (row.reason === "already_linked") return "already_migrated";
  return "remain_on_source";
}

function exceptionsOf(
  row: ManifestInputRow,
  decision: ManifestDecision,
  junior: boolean,
  payer: ManifestPayer,
  snapshotAt: Date,
): ManifestException[] {
  const out: ManifestException[] = [];
  switch (row.reason) {
    case "on_hold":
      out.push({ code: "on_hold", detail: "On hold in the source; not billed by anyone now" });
      break;
    case "tier_mismatch":
      out.push({ code: "tier_mismatch", detail: `Member tier "${row.memberTierName ?? "?"}" but the subscription bills "${row.tierName ?? "?"}"` });
      break;
    case "no_payment_method":
      out.push({ code: "no_payment_method", detail: "No usable saved card or Direct Debit on the customer" });
      break;
    case "bacs_not_enabled":
      out.push({ code: "no_payment_method", detail: "Only a Direct Debit is saved and the club has Direct Debit switched off" });
      break;
    case "period_end_too_soon":
      out.push({ code: "period_end_too_soon", detail: "The existing period ends within the hour" });
      break;
    case "already_linked":
    case null:
      break;
    default:
      out.push({ code: "not_ready", detail: `Preview reason: ${row.reason}` });
  }
  if (row.otherLiveSubscriptionId) {
    out.push({ code: "other_live_subscription", detail: `Subscription ${row.otherLiveSubscriptionId} is still live beside MatFlow's — double-charge risk` });
  }
  if ((decision === "adopt" || decision === "replace" || decision === "create") && row.firstChargeAt) {
    const leadMs = new Date(row.firstChargeAt).getTime() - snapshotAt.getTime();
    if (leadMs < MIN_ACTION_LEAD_HOURS * 60 * 60 * 1000) {
      out.push({ code: "period_end_too_soon", detail: `First MatFlow collection is less than ${MIN_ACTION_LEAD_HOURS} hours after the snapshot` });
    }
  }
  if (junior && !payer.verified) {
    out.push({ code: "payer_unverified", detail: "Junior membership with no explicit payer link; the payer is never inferred from a shared email" });
  }
  return out;
}

function controllerOf(row: MigrationRow, decision: ManifestDecision): ManifestRow["collectionController"] {
  if (decision !== "already_migrated") return "TeamUp";
  return row.otherLiveSubscriptionId ? "Both" : "MatFlow";
}

function sourceActionOf(row: MigrationRow, decision: ManifestDecision, snapshotAt: Date): ManifestRow["sourceAction"] {
  const owner = SOURCE_ACTION_OWNER;
  const first = row.firstChargeAt ? isoDay(new Date(row.firstChargeAt)) : null;
  switch (decision) {
    case "adopt":
      return {
        owner,
        dueBy: row.firstChargeAt ? dayBefore(row.firstChargeAt) : null,
        text:
          `Only if ${SOURCE_PLATFORM} has confirmed in writing that ending a membership does not cancel its Stripe subscription: ` +
          `end the ${SOURCE_PLATFORM} membership effective ${first ?? "the period end"} — do NOT cancel the Stripe subscription ${row.subscriptionId ?? "(unknown)"}.`,
      };
    case "replace":
      return {
        owner,
        dueBy: row.firstChargeAt ? dayBefore(row.firstChargeAt) : null,
        text:
          `After the MatFlow replacement is applied and checked (customer ${row.customerId ?? "?"}, amount, start ${first ?? "?"}): ` +
          `end the ${SOURCE_PLATFORM} membership so the charge that opened the current period is its final one and nothing is taken on or after ${first ?? "the period end"}. ` +
          `Ending it cancels ${SOURCE_PLATFORM}'s subscription ${row.replacesSubscriptionId ?? "(unknown)"}; do NOT cancel the MatFlow subscription (metadata.matflowReplaces = ${row.replacesSubscriptionId ?? "?"}).`,
      };
    case "create":
      return {
        owner,
        dueBy: row.firstChargeAt ? dayBefore(row.firstChargeAt) : null,
        text:
          `After the MatFlow subscription is applied and checked: end the ${SOURCE_PLATFORM} membership so its final charge falls before ${first ?? "the due date"} — ` +
          `no ${SOURCE_PLATFORM} charge on or after that date. Do NOT cancel the MatFlow subscription (metadata.matflowMemberId = ${row.memberId}).`,
      };
    case "already_migrated":
      if (row.otherLiveSubscriptionId) {
        return {
          owner,
          dueBy: isoDay(snapshotAt),
          text:
            `End the ${SOURCE_PLATFORM} membership now: its subscription ${row.otherLiveSubscriptionId} is still live beside MatFlow's ${row.subscriptionId ?? "?"}. ` +
            `Do NOT cancel ${row.subscriptionId ?? "the MatFlow subscription"}.`,
        };
      }
      return { owner, dueBy: null, text: `None — already billed by MatFlow on ${row.subscriptionId ?? "?"}; no ${SOURCE_PLATFORM} subscription live.` };
    case "remain_on_source":
      return {
        owner,
        dueBy: null,
        text: `Change nothing in ${SOURCE_PLATFORM}. The membership keeps billing there until "${row.reason ?? "unknown"}" is resolved and a fresh preview moves it.`,
      };
  }
}

const DECISION_ORDER: Record<ManifestDecision, number> = {
  replace: 0,
  create: 1,
  adopt: 2,
  already_migrated: 3,
  remain_on_source: 4,
};

function compareRows(a: ManifestRow, b: ManifestRow): number {
  const d = DECISION_ORDER[a.decision] - DECISION_ORDER[b.decision];
  if (d !== 0) return d;
  const ad = a.firstMatflowCollectionDate ?? "9999-12-31";
  const bd = b.firstMatflowCollectionDate ?? "9999-12-31";
  if (ad !== bd) return ad < bd ? -1 : 1;
  const an = a.beneficiary.name.toLowerCase();
  const bn = b.beneficiary.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.beneficiary.memberId !== b.beneficiary.memberId) return a.beneficiary.memberId < b.beneficiary.memberId ? -1 : 1;
  return 0;
}

export function buildCutoverManifest(
  previewRows: ManifestInputRow[],
  opts: { snapshotAt: Date | string; sourceExportedAt: Date | string },
): CutoverManifest {
  const snapshotAt = toDate(opts.snapshotAt);
  const sourceExportedAt = toDate(opts.sourceExportedAt);
  const sourceAgeHours = Math.round(((snapshotAt.getTime() - sourceExportedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;

  const rows = previewRows.map((row): ManifestRow => {
    const decision = decisionOf(row);
    const junior = isJunior(row);
    const payer = payerOf(row);
    const cycle = row.cycle;
    const migrating = decision === "adopt" || decision === "replace" || decision === "create";
    return {
      beneficiary: { memberId: row.memberId, name: row.memberName, junior },
      payer,
      stripe: {
        customerId: row.customerId,
        subscriptionId: row.subscriptionId,
        sourceSubscriptionId: row.replacesSubscriptionId ?? row.otherLiveSubscriptionId ?? null,
        priceId: row.priceId,
      },
      tierName: row.tierName,
      amountPence: row.amountPence,
      currency: row.currency ? row.currency.toUpperCase() : null,
      cadence: row.cycleLabel ?? (cycle ? cycleLabel(cycle) : "Unknown"),
      monthlyEquivalentPence: monthlyEquivalentPence(row.amountPence, cycle),
      collectionController: controllerOf(row, decision),
      firstMatflowCollectionDate: migrating && row.firstChargeAt ? isoDay(new Date(row.firstChargeAt)) : null,
      exceptions: exceptionsOf(row, decision, junior, payer, snapshotAt),
      decision,
      decisionReason: decision === "remain_on_source" ? row.reason : null,
      sourceAction: sourceActionOf(row, decision, snapshotAt),
    };
  });
  rows.sort(compareRows);

  return {
    snapshotAt: snapshotAt.toISOString(),
    sourceExportedAt: sourceExportedAt.toISOString(),
    sourceAgeHours,
    sourceStale: sourceAgeHours < 0 || sourceAgeHours > MAX_SOURCE_AGE_HOURS,
    rows,
  };
}

export type ManifestSummary = {
  total: number;
  byDecision: Record<ManifestDecision, number>;
  withExceptions: number;
  /** Per currency, pence per calendar month. Rows with no amount are counted in `rowsWithoutAmount`, not guessed. */
  monthlyEquivalentPence: Record<string, { migrating: number; notMigrating: number; total: number }>;
  rowsWithoutAmount: number;
  firstCohort: { tierName: string | null; memberIds: string[] };
};

/**
 * First cohort: adults only, all on ONE plan, a clean actionable preview row
 * (adopt / replace / create) with no exceptions and a known amount; at most
 * five. The plan chosen is the one with the most such members (ties by name);
 * members are taken in manifest order.
 */
export function summariseManifest(manifest: CutoverManifest): ManifestSummary {
  const byDecision: Record<ManifestDecision, number> = { adopt: 0, replace: 0, create: 0, already_migrated: 0, remain_on_source: 0 };
  const money: ManifestSummary["monthlyEquivalentPence"] = {};
  let withExceptions = 0;
  let rowsWithoutAmount = 0;
  const cohortByTier = new Map<string, string[]>();

  for (const r of manifest.rows) {
    byDecision[r.decision] += 1;
    if (r.exceptions.length > 0) withExceptions += 1;
    const migrating = r.decision === "adopt" || r.decision === "replace" || r.decision === "create";
    if (r.monthlyEquivalentPence == null || !r.currency) {
      rowsWithoutAmount += 1;
    } else {
      const m = (money[r.currency] ??= { migrating: 0, notMigrating: 0, total: 0 });
      if (migrating) m.migrating += r.monthlyEquivalentPence;
      else m.notMigrating += r.monthlyEquivalentPence;
      m.total += r.monthlyEquivalentPence;
    }
    if (migrating && !r.beneficiary.junior && r.exceptions.length === 0 && r.tierName && r.amountPence != null) {
      const list = cohortByTier.get(r.tierName) ?? [];
      list.push(r.beneficiary.memberId);
      cohortByTier.set(r.tierName, list);
    }
  }

  let best: [string, string[]] | null = null;
  for (const entry of [...cohortByTier.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!best || entry[1].length > best[1].length) best = entry;
  }

  return {
    total: manifest.rows.length,
    byDecision,
    withExceptions,
    monthlyEquivalentPence: money,
    rowsWithoutAmount,
    firstCohort: best ? { tierName: best[0], memberIds: best[1].slice(0, FIRST_COHORT_MAX) } : { tierName: null, memberIds: [] },
  };
}

export const MANIFEST_CSV_HEADER = [
  "Member ID",
  "Member",
  "Junior",
  "Payer",
  "Payer member ID",
  "Payer verified",
  "Payer basis",
  "Stripe customer",
  "Stripe subscription",
  "Source subscription",
  "Stripe price",
  "Tier",
  "Amount (pence)",
  "Currency",
  "Cadence",
  "Monthly equivalent (pence)",
  "Collected by",
  "First MatFlow collection",
  "Exceptions",
  "Decision",
  "Reason",
  "Source action",
  "Action owner",
  "Action due by",
];

/** The manifest as CSV; every cell passes the formula-injection guard in lib/csv.ts. */
export function manifestToCsv(manifest: CutoverManifest): string {
  const lines = [csvRow(MANIFEST_CSV_HEADER)];
  for (const r of manifest.rows) {
    lines.push(
      csvRow([
        r.beneficiary.memberId,
        r.beneficiary.name,
        r.beneficiary.junior ? "yes" : "no",
        r.payer.name ?? "Unconfirmed",
        r.payer.payerMemberId,
        r.payer.verified ? "yes" : "NO",
        r.payer.basis,
        r.stripe.customerId,
        r.stripe.subscriptionId,
        r.stripe.sourceSubscriptionId,
        r.stripe.priceId,
        r.tierName,
        r.amountPence,
        r.currency,
        r.cadence,
        r.monthlyEquivalentPence,
        r.collectionController,
        r.firstMatflowCollectionDate,
        r.exceptions.map((e) => `${e.code}: ${e.detail}`).join("; "),
        r.decision,
        r.decisionReason,
        r.sourceAction.text,
        r.sourceAction.owner,
        r.sourceAction.dueBy,
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
