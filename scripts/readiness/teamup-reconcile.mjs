// Independent reconciliation of a TeamUp import against the source CSV
// (teamup-2, 2 Oct 2026). Pure CSV + pg; no product code imported, so it can
// disagree with the importer. Prints AGGREGATES ONLY; row-level differences go
// to a private file you name with --ledger (keep it out of git).
//
//   node scripts/readiness/teamup-reconcile.mjs --csv <file.csv> --tenant <slug> [--as-of YYYY-MM-DD] [--ledger <private.json>]
//
// Guards: reads DATABASE_URL from .env.test, refuses any host that is not the
// test branch, opens a read-only transaction.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const csvPath = opt("--csv"), slug = opt("--tenant"), ledgerOut = opt("--ledger");
if (!csvPath || !slug) { console.error("usage: --csv <file> --tenant <slug> [--as-of YYYY-MM-DD] [--ledger <private.json>]"); process.exit(2); }

// ── env + guard ────────────────────────────────────────────────────────────
const envText = readFileSync(".env.test", "utf8");
const envVal = (k) => { const m = envText.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^"|"$/g, "") : undefined; };
const url = process.env.RECONCILE_DATABASE_URL ?? envVal("DATABASE_URL");
if (!url || !url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) { console.error("refusing: DATABASE_URL is not the test branch"); process.exit(2); }

// ── CSV ────────────────────────────────────────────────────────────────────
function parseCsv(s) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const buf = readFileSync(csvPath);
const sha256 = createHash("sha256").update(buf).digest("hex");
let text = buf.toString("utf8"); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
const all = parseCsv(text); const header = all[0];
const data = all.slice(1).filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
const col = (n) => header.indexOf(n);
const C = { name: col("Customer Name"), email: col("Customer Email"), plan: col("Membership Name"), type: col("Type"), status: col("Status"), start: col("Start Date"), expiry: col("Expiration Date"), cancelled: col("Cancelled Date"), dob: col("Date of birth") };
const cell = (r, k) => (r[C[k]] ?? "").trim();
const asOf = opt("--as-of") ?? new Date().toISOString().slice(0, 10);
const fp = (r) => r.map((c) => (c ?? "").trim()).join("\u0001");

// ── independent expectations per person ────────────────────────────────────
const seen = new Set(); let dupRows = 0, deletedRows = 0;
const people = new Map();
data.forEach((r, i) => {
  const n = i + 2;
  const name = cell(r, "name");
  if (!name || /^\(deleted customer\)$/i.test(name)) { deletedRows++; return; }
  const k = fp(r); if (seen.has(k)) { dupRows++; return; } seen.add(k);
  const key = `teamup:${cell(r, "email").toLowerCase()}|${name.toLowerCase()}`;
  const p = people.get(key) ?? { key, email: cell(r, "email").toLowerCase(), rows: [] };
  p.rows.push({ n, r }); people.set(key, p);
});
const age = (dob) => { if (!/^\d{4}-\d{2}-\d{2}/.test(dob)) return null; const [y, m, d] = dob.slice(0, 10).split("-").map(Number); const [Y, M, D] = asOf.split("-").map(Number); let a = Y - y; if (M < m || (M === m && D < d)) a--; return a; };
const live = (r) => { const s = cell(r, "status"); if (s !== "active" && s !== "hold") return false; const st = cell(r, "start").slice(0, 10); if (st && st > asOf) return false; const e = cell(r, "expiry").slice(0, 10); return !e || e >= asOf; };

const expected = new Map();
for (const p of people.values()) {
  const dob = p.rows.map(({ r }) => cell(r, "dob")).find(Boolean) ?? "";
  const a = age(dob);
  const kidsPlan = p.rows.some(({ r }) => /\bkids?\b/i.test(cell(r, "plan")));
  const band = a !== null ? (a < 13 ? "kids" : a < 18 ? "junior" : "adult") : kidsPlan ? "kids" : "adult";
  const started = p.rows.filter(({ r }) => live(r) && cell(r, "status") === "active");
  const held = p.rows.filter(({ r }) => live(r) && cell(r, "status") === "hold");
  const byStart = (a, b) => (cell(a.r, "start").slice(0, 10) || "").localeCompare(cell(b.r, "start").slice(0, 10) || "") || a.n - b.n;
  const last = [...p.rows].sort(byStart).at(-1).r;
  let status, paymentStatus, plan, kind;
  if (started.length === 1) { status = "active"; paymentStatus = "paid"; plan = cell(started[0].r, "plan"); kind = "current"; }
  else if (started.length >= 2) { status = "active"; paymentStatus = "paid"; plan = null; kind = "decision"; }
  else if (held.length >= 1) { status = "active"; paymentStatus = "paused"; plan = cell(held[held.length - 1].r, "plan"); kind = "held"; }
  else if (p.rows.some(({ r }) => cell(r, "status") === "active" && cell(r, "start").slice(0, 10) > asOf)) { status = "active"; paymentStatus = "paid"; plan = null; kind = "scheduled"; }
  else { const completedPrepaid = cell(last, "status") === "completed" && cell(last, "type") === "prepaid"; status = completedPrepaid ? "inactive" : "cancelled"; paymentStatus = "cancelled"; plan = cell(last, "plan"); kind = "history"; }
  const cancelledAt = kind === "history" ? (cell(last, "cancelled").slice(0, 10) || null) : null;
  const quarantined = band === "kids" && !p.email;
  expected.set(p.key, { band, status, paymentStatus, plan, kind, cancelledAt, quarantined, rows: p.rows.length });
}

// ── database facts (read-only) ─────────────────────────────────────────────
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("BEGIN READ ONLY");
const t = (await client.query(`SELECT id, name FROM "Tenant" WHERE slug = $1`, [slug])).rows[0];
if (!t) { console.error("no such tenant on the test branch"); process.exit(2); }
const q = async (sql, params = []) => (await client.query(sql, [t.id, ...params])).rows;
const members = await q(`SELECT id, "externalRef", "accountType", status, "paymentStatus", "membershipType", "cancelledAt"::date::text AS "cancelledAt", "parentMemberId", "guardianConfirmedAt", "guardianSuggestedBy", "unverifiedEmail", email, "billedBy", "billingStatusAsOf", "stripeCustomerId", "stripeSubscriptionId", "nextDueAt" FROM "Member" WHERE "tenantId" = $1`);
const ledger = await q(`SELECT i.disposition, i.entitlement, i."memberId" FROM "ImportedMembership" i JOIN "ImportJob" j ON j.id = i."importJobId" WHERE i."tenantId" = $1 AND j."rolledBackAt" IS NULL AND j.mode = 'create'`);
const payments = (await q(`SELECT count(*)::int AS n FROM "Payment" WHERE "tenantId" = $1`))[0].n;
const emails = await q(`SELECT "templateId", count(*)::int AS n FROM "EmailLog" WHERE "tenantId" = $1 GROUP BY 1`);
const jobs = await q(`SELECT id, status, mode, "rolledBackAt", "mappingVersion", "sourceExportedAt", manifest->>'reconciles' AS reconciles FROM "ImportJob" WHERE "tenantId" = $1 ORDER BY "createdAt"`);
await client.query("ROLLBACK"); await client.end();

// ── compare ────────────────────────────────────────────────────────────────
const byRef = new Map(members.filter((m) => m.externalRef).map((m) => [m.externalRef, m]));
const diffs = []; const tally = { matched: 0, missing: 0, quarantinedAbsent: 0, quarantinedPresent: 0, statusMismatch: 0, paymentMismatch: 0, planMismatch: 0, cancelledAtMismatch: 0, bandMismatch: 0 };
for (const [key, e] of expected) {
  const m = byRef.get(key);
  if (e.quarantined) { if (m) { tally.quarantinedPresent++; diffs.push({ key, why: "quarantined kid was created" }); } else tally.quarantinedAbsent++; continue; }
  if (!m) { tally.missing++; diffs.push({ key, why: "person missing" }); continue; }
  let ok = true;
  if (m.status !== e.status) { tally.statusMismatch++; ok = false; diffs.push({ key, why: "status", expected: e.status, got: m.status }); }
  if (m.paymentStatus !== e.paymentStatus) { tally.paymentMismatch++; ok = false; diffs.push({ key, why: "paymentStatus", expected: e.paymentStatus, got: m.paymentStatus }); }
  if ((m.membershipType ?? null) !== e.plan && !(e.kind === "history")) { tally.planMismatch++; ok = false; diffs.push({ key, why: "plan", expected: e.plan, got: m.membershipType }); }
  if (e.kind === "history" && (m.cancelledAt ?? null) !== e.cancelledAt) { tally.cancelledAtMismatch++; ok = false; diffs.push({ key, why: "cancelledAt", expected: e.cancelledAt, got: m.cancelledAt }); }
  const gotBand = m.accountType === "adult" || m.accountType === "parent" ? "adult" : m.accountType;
  if (gotBand !== e.band) { tally.bandMismatch++; ok = false; diffs.push({ key, why: "band", expected: e.band, got: m.accountType }); }
  if (ok) tally.matched++;
}
const drafts = members.filter((m) => m.externalRef?.startsWith("teamup-payer:"));
const linked = members.filter((m) => m.parentMemberId);
const dispositions = ledger.reduce((a, r) => ((a[r.disposition.split(":")[0]] = (a[r.disposition.split(":")[0]] ?? 0) + 1), a), {});
const entitlements = ledger.reduce((a, r) => ((a[r.entitlement] = (a[r.entitlement] ?? 0) + 1), a), {});
const checks = {
  "every CSV record has one ledger row": ledger.length === data.length,
  "ledger dispositions sum to the record count": Object.values(dispositions).reduce((a, b) => a + b, 0) === data.length,
  "duplicate rows linked, deleted rows excluded": (dispositions.duplicate_of ?? 0) === dupRows && (dispositions.excluded ?? 0) === deletedRows,
  "every expected person present with the expected standing": tally.missing === 0 && tally.statusMismatch === 0 && tally.paymentMismatch === 0 && tally.planMismatch === 0 && tally.cancelledAtMismatch === 0 && tally.bandMismatch === 0,
  "quarantined kids were not created": tally.quarantinedPresent === 0,
  "every family link is SUGGESTED (unconfirmed)": linked.every((m) => m.guardianConfirmedAt === null && (m.guardianSuggestedBy === "shared_email" || m.guardianSuggestedBy === "emergency_contact")),
  "guardian drafts have no real login and keep the payer address": drafts.every((m) => /no-login\.matflow\.local$/.test(m.email) && !!m.unverifiedEmail),
  "every member is billed by TeamUp with the as-of date": members.every((m) => m.billedBy === "teamup" && m.billingStatusAsOf),
  "no Stripe ids, no due dates, no payments": members.every((m) => !m.stripeCustomerId && !m.stripeSubscriptionId && !m.nextDueAt) && payments === 0,
  "no mail beyond the owner's import notice": emails.every((e) => e.templateId === "import_complete") && emails.reduce((a, e) => a + e.n, 0) <= jobs.filter((j) => j.mode === "create").length,
  "import job(s) reconcile": jobs.length > 0 && jobs.every((j) => j.reconciles === "true" || j.status !== "complete" || j.rolledBackAt),
};
const out = {
  tenant: t.name, file: csvPath.replace(/\\/g, "/").split("/").pop(), sha256, records: data.length, asOf,
  expected: { people: expected.size, quarantinedKids: [...expected.values()].filter((e) => e.quarantined).length, byKind: [...expected.values()].reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {}) },
  database: { members: members.length, byAccountType: members.reduce((a, m) => ((a[m.accountType] = (a[m.accountType] ?? 0) + 1), a), {}), guardianDrafts: drafts.length, linkedChildren: linked.length, ledgerRows: ledger.length, dispositions, entitlements, payments, emailTemplates: Object.fromEntries(emails.map((e) => [e.templateId, e.n])), jobs: jobs.map((j) => ({ status: j.status, mode: j.mode, rolledBack: !!j.rolledBackAt, mappingVersion: j.mappingVersion, reconciles: j.reconciles })) },
  tally, checks, verdict: Object.values(checks).every(Boolean) ? "RECONCILED" : "DISCREPANCIES",
};
console.log(JSON.stringify(out, null, 2));
if (ledgerOut) { writeFileSync(ledgerOut, JSON.stringify({ diffs }, null, 1)); console.error(`row-level differences (${diffs.length}) written to ${ledgerOut} — keep it out of git`); }
process.exit(out.verdict === "RECONCILED" ? 0 : 1);
