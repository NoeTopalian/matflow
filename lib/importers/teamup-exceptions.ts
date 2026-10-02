/**
 * TeamUp import exceptions (teamup-2, 2 Oct 2026): the list of things the
 * owner must decide, confirm or know about before and after an import, as
 * rows — one per person or source row — so they can be read on screen and
 * downloaded as a CSV. Pure: built from the parser's drafts and errors, and
 * stored on the job (preview summary, then commit manifest) so the download
 * works after the file itself has been deleted.
 *
 * Nothing here is a guess: every row names its source and what it needs.
 */
import { csvRow } from "@/lib/csv";
import type { MemberDraft } from "@/lib/importers";

export type ExceptionKind =
  | "decision_required"
  | "scheduled_start"
  | "guardian_suggested"
  | "guardian_draft"
  | "shared_email_adult"
  | "missing_email_active"
  | "cancelled_without_date"
  | "plan_without_tier"
  | "refused_row";

export type ExceptionRow = {
  kind: ExceptionKind;
  /** The person the row is about (the child, for a guardian suggestion). */
  name: string;
  /** Their real address when one is known; never a synthesised login. */
  email: string | null;
  /** What must happen, in words. */
  action: string;
  /** Supporting fact: the options, the start date, the suggested guardian… */
  detail: string;
  /** 1-based CSV line numbers (header = 1) the row rests on. */
  sourceRows: number[];
};

export const EXCEPTION_WORDS: Record<ExceptionKind, { title: string; action: string }> = {
  decision_required: { title: "Two active plans at TeamUp", action: "Choose which plan is current, on the member's profile." },
  scheduled_start: { title: "Plan starts after the export date", action: "Nothing to do now; a later refresh after the start date moves them onto it." },
  guardian_suggested: { title: "Guardian suggested, not confirmed", action: "Confirm or reject on the child's Family card. No parent access until confirmed." },
  guardian_draft: { title: "Guardian created from an emergency contact", action: "Confirm the link on the child's Family card; adopt the address as their login only if it is theirs." },
  shared_email_adult: { title: "Second adult on a shared email", action: "Give them their own address on their profile before inviting them." },
  missing_email_active: { title: "Active member with no email", action: "Add an address on their profile; until then they cannot be invited." },
  cancelled_without_date: { title: "Cancelled at TeamUp, no cancellation date", action: "Nothing is invented; add the date on the profile if you know it." },
  plan_without_tier: { title: "Plan label with no MatFlow tier", action: "Create the tier with this exact name, then run a status refresh to link it." },
  refused_row: { title: "Row not imported", action: "Fix the row at TeamUp or in MatFlow and re-import." },
};

const realEmail = (d: MemberDraft): string | null => (d.nonContactable ? d.unverifiedEmail ?? null : d.email || null);

export function buildExceptionRows(drafts: MemberDraft[], errors: { row: number; reason: string }[], tierNames: Set<string>): ExceptionRow[] {
  const out: ExceptionRow[] = [];
  // parentEmail resolves exactly as the commit resolves it: the adult who KEEPS
  // the address as their login, or a guardian draft holding it as the payer
  // address. A second adult on a shared email (synthesised login) never claims it.
  const byEmail = new Map<string, MemberDraft>();
  for (const d of drafts) {
    if (d.email && !d.nonContactable) byEmail.set(d.email.toLowerCase(), d);
    if (d.unverifiedEmail && d.unverified && !byEmail.has(d.unverifiedEmail.toLowerCase())) byEmail.set(d.unverifiedEmail.toLowerCase(), d);
  }
  const W = EXCEPTION_WORDS;

  for (const d of drafts) {
    const rows = d.sourceRows ?? [];
    if (d.decision) {
      out.push({ kind: "decision_required", name: d.name, email: realEmail(d), action: W.decision_required.action, detail: d.decision.options.join(" or "), sourceRows: d.decision.rows });
    }
    if (d.scheduled) {
      out.push({ kind: "scheduled_start", name: d.name, email: realEmail(d), action: W.scheduled_start.action, detail: `${d.scheduled.planLabel} from ${d.scheduled.startDate}`, sourceRows: [d.scheduled.sourceRow] });
    }
    if (d.guardianSuggestedBy && d.parentEmail) {
      const parent = byEmail.get(d.parentEmail.toLowerCase());
      const via = d.guardianSuggestedBy === "shared_email" ? "shared email address" : "emergency contact";
      out.push({ kind: "guardian_suggested", name: d.name, email: null, action: W.guardian_suggested.action, detail: `${parent?.name ?? d.parentEmail} (${via})`, sourceRows: rows });
    }
    if (d.unverified && d.accountType === "parent") {
      out.push({ kind: "guardian_draft", name: d.name, email: d.unverifiedEmail ?? null, action: W.guardian_draft.action, detail: d.unverifiedEmail ? `Payer address at TeamUp: ${d.unverifiedEmail}` : "No address", sourceRows: rows });
    }
    if (d.unverifiedEmail && !d.unverified && d.accountType !== "parent") {
      out.push({ kind: "shared_email_adult", name: d.name, email: d.unverifiedEmail, action: W.shared_email_adult.action, detail: `Shares ${d.unverifiedEmail}`, sourceRows: rows });
    }
    if (d.nonContactable && !d.unverifiedEmail && !["kids", "junior", "parent"].includes(d.accountType ?? "") && d.status === "active") {
      out.push({ kind: "missing_email_active", name: d.name, email: null, action: W.missing_email_active.action, detail: d.membershipType ?? "", sourceRows: rows });
    }
    if (d.status === "cancelled" && !d.cancelledAt) {
      out.push({ kind: "cancelled_without_date", name: d.name, email: realEmail(d), action: W.cancelled_without_date.action, detail: d.membershipType ?? "", sourceRows: rows });
    }
  }

  const labels = new Map<string, number[]>();
  for (const d of drafts) {
    const l = d.membershipType?.trim();
    if (!l || tierNames.has(l.toLowerCase())) continue;
    labels.set(l, [...(labels.get(l) ?? []), ...(d.sourceRows ?? [])]);
  }
  for (const [label, rows] of labels) {
    out.push({ kind: "plan_without_tier", name: label, email: null, action: W.plan_without_tier.action, detail: `${new Set(rows).size} source rows`, sourceRows: [...new Set(rows)].sort((a, b) => a - b).slice(0, 50) });
  }
  for (const e of errors) {
    out.push({ kind: "refused_row", name: `Row ${e.row}`, email: null, action: W.refused_row.action, detail: e.reason, sourceRows: [e.row] });
  }
  return out;
}

export function countByKind(rows: ExceptionRow[]): Record<ExceptionKind, number> {
  const acc = Object.fromEntries(Object.keys(EXCEPTION_WORDS).map((k) => [k, 0])) as Record<ExceptionKind, number>;
  for (const r of rows) acc[r.kind] += 1;
  return acc;
}

/** CSV with the formula guard on every text cell (lib/csv.ts). */
export function exceptionsCsv(rows: ExceptionRow[], header: { club: string; file: string; asOf: string | null }): string {
  const lines = [
    csvRow(["MatFlow TeamUp import exceptions", header.club, header.file, header.asOf ? `as of ${header.asOf}` : "export date not given"]),
    csvRow(["Kind", "What it means", "Person or row", "Email", "Detail", "What to do", "Source rows"]),
    ...rows.map((r) => csvRow([r.kind, EXCEPTION_WORDS[r.kind].title, r.name, r.email ?? "", r.detail, r.action, r.sourceRows.join(" ")])),
  ];
  return lines.join("\r\n") + "\r\n";
}
