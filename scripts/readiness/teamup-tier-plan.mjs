#!/usr/bin/env node
// Plan label → MatFlow tier plan for a TeamUp "Memberships" export.
//
// For every plan label in the file: how many rows carry it (all / active /
// hold), its disposition, the EXACT tier name to create, the cycle TeamUp
// charges on, and the tier fields to enter so that MatFlow neither advertises
// £0 nor invents a due date, an overdue or revenue for a member TeamUp bills.
//
//   node scripts/readiness/teamup-tier-plan.mjs <file.csv> [--as-of YYYY-MM-DD] [--json]
//
// AGGREGATES ONLY: plan labels are the club's catalogue names, not personal
// data; no name, email, phone or date of birth is ever printed.
//
// Dispositions:
//   LIVE_TIER     the label has active or hold rows: create a tier with exactly
//                 this name before the first import, or those members land
//                 with the plan name as text and no tier.
//   HISTORY_ONLY  no active or hold row: no tier. The rows are kept whole as
//                 ImportedMembership.planLabel (commit/route.ts ledger write)
//                 and a member's tier follows their current / scheduled / held
//                 membership, never a history row.
//
// The commit matches a tier by name trimmed and case-insensitive
// (app/api/admin/import/[id]/commit/route.ts tierByName), so the name printed
// is byte-identical to the file's (shown JSON-quoted to expose spaces).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Mirror of lib/importers/teamup.ts cycleForPlan (pinned by tests/unit/teamup-tier-plan.test.ts). */
export function cycleForPlan(plan) {
  if (/^8 week/i.test(plan)) return "none";
  if (/\(old\)/i.test(plan)) return "monthly";
  return "four_weekly";
}

const CYCLE_WORDS = { four_weekly: "every 4 weeks", monthly: "monthly", none: "one-off course" };

/**
 * The tier fields that carry no financial effect for a TeamUp-billed member
 * (report B, task 5): price 0 with cycle "none" seeds no due date
 * (lib/overdue.ts advanceDueDate returns null for "none"), so nothing can
 * become overdue; no Stripe price, so nothing can be started or charged
 * (lib/stripe/tier-price.ts refuses a price of 0); not a kids plan, so a
 * parent's self-billing screen never offers it; the description says why
 * the price reads as unset.
 */
export const PRICE_NOT_SET_MARKER = "Price not yet confirmed — billed by TeamUp";
export function tierFields(label) {
  const cycle = cycleForPlan(label);
  return {
    name: label,
    pricePence: 0,
    billingCycle: "none",
    isKids: false,
    stripePriceId: null,
    description: `${PRICE_NOT_SET_MARKER} (${CYCLE_WORDS[cycle]})`,
  };
}

function parseCsv(s) {
  const rows = [];
  let cur = [], field = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; cur.push(field); rows.push(cur); cur = []; field = ""; }
    else field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

/** One row per plan label, sorted LIVE first then by rows. */
export function tierPlan(text, { asOf } = {}) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const all = parseCsv(s);
  const header = all[0].map((h) => h.trim().toLowerCase());
  const data = all.slice(1).filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
  const col = (n) => header.indexOf(n);
  const C = { plan: col("membership name"), status: col("status"), start: col("start date"), expiry: col("expiration date") };
  if (C.plan < 0 || C.status < 0) throw new Error("Not a TeamUp memberships export (no Membership Name / Status column).");
  const cell = (r, i) => (i >= 0 ? (r[i] ?? "").trim() : "");

  const byLabel = new Map();
  for (const r of data) {
    // The label as the commit sees it: trimmed (lib/importers/teamup.ts cell()).
    const label = cell(r, C.plan);
    const raw = r[C.plan] ?? "";
    const x = byLabel.get(label) ?? { label, rows: 0, active: 0, hold: 0, other: 0, liveAtAsOf: 0, untrimmed: false };
    x.rows += 1;
    if (raw !== label) x.untrimmed = true;
    const status = cell(r, C.status).toLowerCase();
    if (status === "active") x.active += 1;
    else if (status === "hold") x.hold += 1;
    else x.other += 1;
    if (asOf && (status === "active" || status === "hold")) {
      // lib/importers/teamup.ts classify: live unless expired; a hold must have started.
      const start = cell(r, C.start).slice(0, 10);
      const exp = cell(r, C.expiry).slice(0, 10);
      const live = !exp || exp >= asOf;
      const started = !start || start <= asOf;
      if (live && (status === "active" || started)) x.liveAtAsOf += 1;
    }
    byLabel.set(label, x);
  }

  const lower = new Map();
  for (const l of byLabel.keys()) lower.set(l.toLowerCase(), [...(lower.get(l.toLowerCase()) ?? []), l]);

  return [...byLabel.values()]
    .map((x) => {
      const disposition = x.active + x.hold > 0 ? "LIVE_TIER" : "HISTORY_ONLY";
      const notes = [];
      if (x.untrimmed) notes.push("label has surrounding spaces in the file; the tier name is the trimmed label");
      if ((lower.get(x.label.toLowerCase()) ?? []).length > 1) notes.push("another label differs only in case; ONE tier serves both");
      if (asOf && disposition === "LIVE_TIER" && x.liveAtAsOf === 0) notes.push(`no row is live at ${asOf} (every active/hold row has expired or not started)`);
      return {
        label: x.label,
        rows: x.rows,
        active: x.active,
        hold: x.hold,
        ...(asOf ? { liveAtAsOf: x.liveAtAsOf } : {}),
        disposition,
        teamupCycle: cycleForPlan(x.label),
        ...(disposition === "LIVE_TIER" ? { createTier: tierFields(x.label) } : {}),
        notes,
      };
    })
    .sort((a, b) => (a.disposition === b.disposition ? b.active + b.hold - (a.active + a.hold) || b.rows - a.rows : a.disposition === "LIVE_TIER" ? -1 : 1));
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--as-of");
  if (!file) {
    console.error("usage: teamup-tier-plan.mjs <file.csv> [--as-of YYYY-MM-DD] [--json]");
    process.exit(2);
  }
  const i = args.indexOf("--as-of");
  const asOf = i >= 0 ? args[i + 1] : undefined;
  const plan = tierPlan(readFileSync(file, "utf8"), { asOf });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ asOf: asOf ?? null, labels: plan.length, live: plan.filter((p) => p.disposition === "LIVE_TIER").length, plan }, null, 2));
    return;
  }
  const live = plan.filter((p) => p.disposition === "LIVE_TIER");
  console.log(`${plan.length} plan labels: ${live.length} LIVE_TIER, ${plan.length - live.length} HISTORY_ONLY${asOf ? ` (live-at check as of ${asOf})` : ""}\n`);
  console.log(["disposition", "rows", "active", "hold", ...(asOf ? ["liveAtAsOf"] : []), "teamupCycle", "tier name (exact, JSON-quoted)"].join("\t"));
  for (const p of plan) {
    console.log([p.disposition, p.rows, p.active, p.hold, ...(asOf ? [p.liveAtAsOf] : []), p.teamupCycle, JSON.stringify(p.label)].join("\t"));
    for (const n of p.notes) console.log(`\t  note: ${n}`);
  }
  console.log(`\nFor every LIVE_TIER label create a tier with: name exactly as above; price 0; billing cycle "none"; not a kids plan; no Stripe price; description "${PRICE_NOT_SET_MARKER} (<cycle>)".`);
  console.log("HISTORY_ONLY labels need no tier.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
