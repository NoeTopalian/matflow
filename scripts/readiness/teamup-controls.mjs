#!/usr/bin/env node
// Independent source controls for a TeamUp "Memberships" export.
//
// Pure CSV arithmetic — it imports nothing from the product, so it can never
// agree with the importer by construction. It prints AGGREGATES ONLY (no
// names, emails, phones, dates of birth); the row-level exception list is
// written to a file you name with --rows, which must stay out of git.
//
//   node scripts/readiness/teamup-controls.mjs <file.csv> [--as-of YYYY-MM-DD] [--rows <private.json>]
//
// Record ordinals are CSV records with header = 1, parsed RFC-4180 (quoted
// fields may span lines), never physical lines.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: teamup-controls.mjs <file.csv> [--as-of YYYY-MM-DD] [--rows <private.json>]");
  process.exit(2);
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const asOf = opt("--as-of") ?? new Date().toISOString().slice(0, 10);
const rowsOut = opt("--rows");

const buf = readFileSync(file);
const sha256 = createHash("sha256").update(buf).digest("hex");
let text = buf.toString("utf8");
const bom = text.charCodeAt(0) === 0xfeff;
if (bom) text = text.slice(1);

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

const all = parseCsv(text);
const header = all[0];
const data = all.slice(1).filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
const col = (n) => header.indexOf(n);
const C = {
  name: col("Customer Name"), email: col("Customer Email"), other: col("Other Active"), plan: col("Membership Name"),
  type: col("Type"), status: col("Status"), proc: col("Payment Processor"), start: col("Start Date"), expiry: col("Expiration Date"),
  cancelled: col("Cancelled Date"), completed: col("Completed At"), dob: col("Date of birth"), ecName: col("Emergency Contact Name"),
  marketing: col("Marketing Preference"), country: col("Country"),
};
const cell = (r, k) => (C[k] >= 0 ? (r[C[k]] ?? "").trim() : "");
const count = (xs) => xs.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const fingerprint = (r) => createHash("sha1").update(r.map((c) => (c ?? "").trim()).join("\u0001")).digest("hex").slice(0, 16);

// ── Row-level facts ────────────────────────────────────────────────────────
const records = data.map((r, i) => ({ n: i + 2, r, fp: fingerprint(r) }));
const seen = new Map();
const duplicates = [];
for (const rec of records) {
  if (seen.has(rec.fp)) duplicates.push({ row: rec.n, duplicateOf: seen.get(rec.fp) });
  else seen.set(rec.fp, rec.n);
}
const deletedRows = records.filter(({ r }) => { const n = cell(r, "name"); return !n || /^\(deleted customer\)$/i.test(n); }).map((x) => x.n);
const missingEmailRows = records.filter(({ r }) => !cell(r, "email") && !deletedRows.includes(0) && cell(r, "name") && !/^\(deleted customer\)$/i.test(cell(r, "name"))).map((x) => x.n);
const cancelledNoDate = records.filter(({ r }) => cell(r, "status") === "cancelled" && !cell(r, "cancelled")).map((x) => x.n);
const futureStartActive = records.filter(({ r }) => cell(r, "status") === "active" && cell(r, "start").slice(0, 10) > asOf).map((x) => x.n);
const expiredActive = records.filter(({ r }) => { const e = cell(r, "expiry").slice(0, 10); return cell(r, "status") === "active" && e && e < asOf; }).map((x) => x.n);

// ── People (normalised email|name — a discovery aid, not identity) ─────────
const people = new Map();
for (const rec of records) {
  if (deletedRows.includes(rec.n) || duplicates.some((d) => d.row === rec.n)) continue;
  const key = `${cell(rec.r, "email").toLowerCase()}|${cell(rec.r, "name").toLowerCase()}`;
  const p = people.get(key) ?? { key, email: cell(rec.r, "email").toLowerCase(), rows: [] };
  p.rows.push(rec);
  people.set(key, p);
}
const age = (dob) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null; const [y, m, d] = dob.split("-").map(Number); const [Y, M, D] = asOf.split("-").map(Number); let a = Y - y; if (M < m || (M === m && D < d)) a--; return a; };
const isStartedLive = (r) => { const s = cell(r, "status"); if (s !== "active" && s !== "hold") return false; if (cell(r, "start").slice(0, 10) > asOf) return false; const e = cell(r, "expiry").slice(0, 10); return !e || e >= asOf; };

const byEmail = new Map();
const perPerson = [];
for (const p of people.values()) {
  const dob = p.rows.map(({ r }) => cell(r, "dob").slice(0, 10)).find(Boolean) ?? "";
  const a = age(dob);
  const kidsPlan = p.rows.some(({ r }) => /\bkids?\b/i.test(cell(r, "plan")));
  const band = a !== null ? (a < 13 ? "kids" : a < 18 ? "junior" : "adult") : kidsPlan ? "kids" : "adult";
  const live = p.rows.filter(({ r }) => isStartedLive(r));
  const startedActive = live.filter(({ r }) => cell(r, "status") === "active");
  const held = live.filter(({ r }) => cell(r, "status") === "hold");
  const scheduled = p.rows.filter(({ r }) => cell(r, "status") === "active" && cell(r, "start").slice(0, 10) > asOf);
  const ecs = new Set(p.rows.map(({ r }) => cell(r, "ecName").toLowerCase()).filter(Boolean));
  const info = { key: p.key, email: p.email, band, rows: p.rows.map((x) => x.n), startedActive: startedActive.length, held: held.length, scheduled: scheduled.length, ecConflict: ecs.size > 1 };
  perPerson.push(info);
  if (p.email) byEmail.set(p.email, [...(byEmail.get(p.email) ?? []), info]);
}
const adultsOn = (email) => (byEmail.get(email) ?? []).filter((x) => x.band === "adult");
let kidsWithAdult = 0, kidsNoAdult = 0, kidsNoEmail = 0, kidsAmbiguousAdults = 0, secondAdults = 0;
for (const x of perPerson) {
  if (x.band === "adult") continue;
  if (!x.email) { kidsNoEmail++; continue; }
  const a = adultsOn(x.email);
  if (a.length === 0) kidsNoAdult++; else if (a.length === 1) kidsWithAdult++; else kidsAmbiguousAdults++;
}
for (const [, xs] of byEmail) { const a = xs.filter((x) => x.band === "adult"); if (a.length > 1) secondAdults += a.length - 1; }

const summary = {
  file: file.replace(/\\/g, "/").split("/").pop(),
  sha256, bom, bytes: buf.length, columns: header.length, records: data.length, asOf,
  statuses: count(records.map(({ r }) => cell(r, "status"))),
  types: count(records.map(({ r }) => cell(r, "type"))),
  processors: count(records.map(({ r }) => cell(r, "proc") || "(blank)")),
  marketing: count(records.map(({ r }) => cell(r, "marketing") || "(blank)")),
  distinctPlanLabels: new Set(records.map(({ r }) => cell(r, "plan"))).size,
  distinctCountryValues: new Set(records.map(({ r }) => cell(r, "country"))).size,
  exactDuplicateRows: duplicates.length,
  deletedCustomerRows: deletedRows.length,
  missingEmailRows: missingEmailRows.length,
  cancelledWithoutDate: cancelledNoDate.length,
  activeWithFutureStart: futureStartActive.length,
  activeAlreadyExpired: expiredActive.length,
  people: people.size,
  bands: count(perPerson.map((x) => x.band)),
  peopleWithTwoStartedActives: perPerson.filter((x) => x.startedActive >= 2).length,
  peopleActivePlusHeld: perPerson.filter((x) => x.startedActive >= 1 && x.held >= 1).length,
  peopleHeldOnly: perPerson.filter((x) => x.startedActive === 0 && x.held >= 1).length,
  peopleWithScheduledStart: perPerson.filter((x) => x.scheduled >= 1).length,
  peopleWithConflictingEmergencyContacts: perPerson.filter((x) => x.ecConflict).length,
  kidsOrJuniors: { withOneAdultOnEmail: kidsWithAdult, withSeveralAdultsOnEmail: kidsAmbiguousAdults, withNoAdultOnEmail: kidsNoAdult, withNoEmail: kidsNoEmail },
  secondAdultsOnSharedEmail: secondAdults,
  missingEmailActivePeople: perPerson.filter((x) => !x.email && x.startedActive + x.held > 0).length,
  planCounts: Object.fromEntries(
    Object.entries(
      records.reduce((m, { r }) => { const k = cell(r, "plan"); m[k] = m[k] ?? { active: 0, hold: 0, history: 0 }; const s = cell(r, "status"); m[k][s === "active" ? "active" : s === "hold" ? "hold" : "history"]++; return m; }, {}),
    ).sort((a, b) => b[1].active - a[1].active),
  ),
};
console.log(JSON.stringify(summary, null, 2));

if (rowsOut) {
  // Row-level references only (ordinals); still private because ordinals map to people.
  writeFileSync(rowsOut, JSON.stringify({ duplicates, deletedRows, missingEmailRows, cancelledNoDate, futureStartActive, expiredActive, people: perPerson }, null, 1));
  console.error(`row-level ledger written to ${rowsOut} — keep it out of git`);
}
