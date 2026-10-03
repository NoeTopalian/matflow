// Independent reconciliation of a TeamUp ATTENDANCE import against the source
// CSV (3 Oct 2026). Pure CSV + pg; no product code imported — its own parser,
// its own identity rule, its own session and visit arithmetic — so it can
// disagree with the importer. Prints AGGREGATES ONLY; row-level differences go
// to a private file you name with --ledger (keep it out of git).
//
//   node scripts/readiness/attendance-reconcile.mjs --csv <file.csv> --tenant <slug> [--ledger <private.json>]
//
// Guards: reads DATABASE_URL from .env.test (or RECONCILE_DATABASE_URL), refuses
// any host that is not the test branch, and reads inside a READ ONLY
// transaction. Checks, each PASS/FAIL:
//   C1 source controls (rows, the four statuses, identities, sessions)
//   C2 every CSV row has exactly one ledger booking (person key, instant,
//      offering, venue) and no ledger booking lacks a CSV row (no phantoms)
//   C3 each booking's status is the CSV's status
//   C4 people: the identity each booking was matched to is the one this script
//      derives (owner decision > Member.externalRef "teamup:<email>|<name>" >
//      one member with that exact name AND email); unmatched stay pending
//   C5 visits: every attended booking of a matched person in a decided session
//      points at an AttendanceRecord of THAT member at THAT club date/time;
//      distinct visits == distinct (member, instant) — no double counting
//   C6 no attendance for non-attended or pending bookings; no imported
//      AttendanceRecord that no booking points at (no phantoms)
//   C7 sessions: every provisional session (instant + offering + venue) has a
//      disposition — created / matched / pending / no attendance — and imported
//      sessions carry no end time
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const csvPath = opt("--csv"), slug = opt("--tenant"), ledgerOut = opt("--ledger");
if (!csvPath || !slug) { console.error("usage: --csv <file> --tenant <slug> [--ledger <private.json>]"); process.exit(2); }

const envText = readFileSync(".env.test", "utf8");
const envVal = (k) => { const m = envText.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim().replace(/^"|"$/g, "") : undefined; };
const url = process.env.RECONCILE_DATABASE_URL ?? envVal("DATABASE_URL");
if (!url || !url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) { console.error("refusing: DATABASE_URL is not the test branch"); process.exit(2); }

// ── CSV (own RFC-4180 reader) ─────────────────────────────────────────────────
const buf = readFileSync(csvPath);
const sha256 = createHash("sha256").update(buf).digest("hex");
let text = buf.toString("utf8");
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
const recs = []; { let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); recs.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); recs.push(row); } }
const header = recs[0];
const data = recs.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
const get = (r, h) => (r[col[h]] ?? "").trim();
const lc = (s) => s.trim().toLowerCase();
const nrm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
const STATUS = { "attended": "attended", "registered": "registered", "late cancelled": "late_cancelled", "no show": "no_show" };

const rows = data.map((r, i) => {
  const name = get(r, "Customer Name"), email = get(r, "Customer Email");
  const raw = get(r, "Event Starts At");
  const at = Date.parse(raw);
  return {
    n: i + 2, name, email: lc(email), personKey: `teamup:${lc(email)}|${lc(name)}`,
    raw, at, offering: get(r, "Offering Type Name"), venue: get(r, "Venue Name"),
    status: STATUS[lc(get(r, "Status"))] ?? `?${get(r, "Status")}`,
  };
});
const rowKey = (pk, at, off, ven) => `${pk}\u0001${at}\u0001${nrm(off)}\u0001${nrm(ven)}`;

const checks = [];
const check = (id, ok, saw) => { checks.push({ id, result: ok ? "PASS" : "FAIL", saw }); console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${saw}`); };
const diffs = {};
const note = (k, v) => { (diffs[k] ??= []).push(v); };

// ── C1 source controls ────────────────────────────────────────────────────────
const byStatus = {}; for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const people = new Set(rows.map((r) => r.personKey));
const sessions = new Set(rows.map((r) => `${r.at}|${nrm(r.offering)}|${nrm(r.venue)}`));
check("C1-source-controls", rows.every((r) => !Number.isNaN(r.at)) && !Object.keys(byStatus).some((k) => k.startsWith("?")),
  `sha256 ${sha256.slice(0, 12)}… rows ${rows.length} ${JSON.stringify(byStatus)} identities ${people.size} provisional sessions ${sessions.size}`);

// ── DB (read only) ───────────────────────────────────────────────────────────
// Prisma writes DateTime into `timestamp without time zone` as UTC; node-pg
// would read it in the MACHINE's zone (BST here) and move every summer
// instant by an hour. Read it as the UTC it is.
pg.types.setTypeParser(1114, (s) => new Date(`${s.replace(" ", "T")}Z`));
const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query("BEGIN READ ONLY");
const q = async (sql, p) => (await db.query(sql, p)).rows;
const [tenant] = await q(`select id, timezone from "Tenant" where slug=$1`, [slug]);
if (!tenant) { console.error("no such tenant"); process.exit(2); }
const T = tenant.id;
const tz = tenant.timezone || "Europe/London";
const members = await q(`select id, name, email, "externalRef" from "Member" where "tenantId"=$1`, [T]);
const decisions = await q(`select kind, "sourceKey", action, "targetId" from "ImportSourceMapping" where "tenantId"=$1 and source='teamup'`, [T]);
const ledger = await q(`select id, "sourcePersonKey", "startsAt", "offeringLabel", "venueLabel", status, "memberId", "classInstanceId", "attendanceRecordId", "attendanceOwned", disposition from "ImportedBooking" where "tenantId"=$1 and source='teamup'`, [T]);
const records = await q(`select ar.id, ar."memberId", ar."checkInMethod", ar."importJobId", ci.date, ci."startTime", ci."endTime", ci."sourceImportJobId" from "AttendanceRecord" ar join "ClassInstance" ci on ci.id = ar."classInstanceId" where ar."tenantId"=$1`, [T]);
const instances = await q(`select ci.id, ci."sourceImportJobId", ci."endTime" from "ClassInstance" ci join "Class" c on c.id = ci."classId" where c."tenantId"=$1`, [T]);
await db.query("ROLLBACK");
await db.end();

// ── C2 one ledger booking per CSV row, no phantoms ────────────────────────────
const L = new Map();
for (const b of ledger) {
  const k = rowKey(b.sourcePersonKey, new Date(b.startsAt).getTime(), b.offeringLabel, b.venueLabel);
  if (L.has(k)) note("ledger_duplicate_key", b.id);
  L.set(k, b);
}
const seen = new Set();
let missing = 0;
for (const r of rows) {
  const k = rowKey(r.personKey, r.at, r.offering, r.venue);
  if (!L.has(k)) { missing += 1; note("csv_row_without_booking", r.n); }
  seen.add(k);
}
const phantoms = [...L.keys()].filter((k) => !seen.has(k));
for (const k of phantoms) note("booking_without_csv_row", L.get(k).id);
check("C2-one-booking-per-row", missing === 0 && phantoms.length === 0 && !diffs.ledger_duplicate_key, `ledger ${ledger.length} · CSV rows without a booking ${missing} · bookings without a CSV row ${phantoms.length}`);

// ── C3 statuses ───────────────────────────────────────────────────────────────
let statusDiff = 0;
const ledgerByStatus = {};
for (const r of rows) {
  const b = L.get(rowKey(r.personKey, r.at, r.offering, r.venue));
  if (!b) continue;
  ledgerByStatus[b.status] = (ledgerByStatus[b.status] ?? 0) + 1;
  if (b.status !== r.status) { statusDiff += 1; note("status_differs", { row: r.n, csv: r.status, ledger: b.status }); }
}
check("C3-statuses", statusDiff === 0, `ledger ${JSON.stringify(ledgerByStatus)} · differences ${statusDiff}`);

// ── C4 identities ─────────────────────────────────────────────────────────────
const synthetic = (e) => !e || e.toLowerCase().endsWith("@no-login.matflow.local");
const memberIds = new Set(members.map((m) => m.id));
const byRef = new Map(); for (const m of members) if (m.externalRef) byRef.set(lc(m.externalRef), [...(byRef.get(lc(m.externalRef)) ?? []), m.id]);
const byNE = new Map(); for (const m of members) if (!synthetic(m.email)) { const k = `${nrm(m.name)}|${lc(m.email)}`; byNE.set(k, [...(byNE.get(k) ?? []), m.id]); }
const personDecision = new Map(decisions.filter((d) => d.kind === "person").map((d) => [d.sourceKey, d]));
const expectMember = new Map();
for (const pk of people) {
  const r = rows.find((x) => x.personKey === pk);
  const d = personDecision.get(pk);
  let id = null;
  if (d) id = d.action === "member" && memberIds.has(d.targetId) ? d.targetId : null;
  else if ((byRef.get(pk) ?? []).length === 1) id = byRef.get(pk)[0];
  else if (!(byRef.get(pk) ?? []).length && r.email && r.name && (byNE.get(`${nrm(r.name)}|${r.email}`) ?? []).length === 1) id = byNE.get(`${nrm(r.name)}|${r.email}`)[0];
  expectMember.set(pk, id);
}
let personDiff = 0;
for (const r of rows) {
  const b = L.get(rowKey(r.personKey, r.at, r.offering, r.venue));
  if (!b) continue;
  if ((b.memberId ?? null) !== expectMember.get(r.personKey)) { personDiff += 1; note("member_differs", { row: r.n }); }
}
const matchedPeople = [...expectMember.values()].filter(Boolean).length;
check("C4-people", personDiff === 0, `identities ${people.size} · matched ${matchedPeople} · pending ${people.size - matchedPeople} · booking/member differences ${personDiff}`);

// ── C5 / C6 visits ────────────────────────────────────────────────────────────
const recById = new Map(records.map((x) => [x.id, x]));
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const offeringDecided = (label) => { const d = decisions.find((x) => x.kind === "offering" && x.sourceKey === label); return d && d.action !== "pending"; };
const venueDecided = (label) => { const d = decisions.find((x) => x.kind === "venue" && x.sourceKey === label); return d && d.action !== "pending"; };
const expectedVisits = new Set();
let visitDiff = 0, wrongAttendance = 0, protectedCount = 0;
const referenced = new Set();
for (const r of rows) {
  const b = L.get(rowKey(r.personKey, r.at, r.offering, r.venue));
  if (!b) continue;
  if (b.attendanceRecordId) referenced.add(b.attendanceRecordId);
  const mid = expectMember.get(r.personKey);
  const shouldVisit = r.status === "attended" && mid && offeringDecided(r.offering) && venueDecided(r.venue);
  if (b.disposition === "staff_removed") { protectedCount += 1; continue; }
  if (b.disposition === "pending_conflict") { note("held_conflict", r.n); continue; }
  if (shouldVisit) {
    expectedVisits.add(`${mid}|${r.at}`);
    const rec = b.attendanceRecordId ? recById.get(b.attendanceRecordId) : null;
    const day = dayFmt.format(new Date(r.at)), time = timeFmt.format(new Date(r.at));
    const recDay = rec ? new Date(rec.date).toISOString().slice(0, 10) : null;
    if (!rec || rec.memberId !== mid || recDay !== day || rec.startTime !== time) { visitDiff += 1; note("visit_wrong_or_missing", { row: r.n, has: !!rec }); }
  } else if (b.attendanceRecordId) { wrongAttendance += 1; note("attendance_on_non_visit", { row: r.n, status: r.status }); }
}
const distinctLinked = new Set(ledger.filter((b) => b.attendanceRecordId && (b.disposition === "attendance_created" || b.disposition === "attendance_existing")).map((b) => b.attendanceRecordId));
check("C5-visits", visitDiff === 0 && distinctLinked.size === expectedVisits.size,
  `expected visits (distinct member+instant) ${expectedVisits.size} · distinct records linked ${distinctLinked.size} · wrong/missing ${visitDiff} · staff-removed kept ${protectedCount} · held conflicts ${(diffs.held_conflict ?? []).length}`);
const imported = records.filter((x) => x.checkInMethod === "import");
const orphanImported = imported.filter((x) => !referenced.has(x.id));
check("C6-no-phantom-attendance", wrongAttendance === 0 && orphanImported.length === 0,
  `imported AttendanceRecords ${imported.length} · on non-visits ${wrongAttendance} · referenced by no booking ${orphanImported.length} · live check-ins ${records.length - imported.length}`);

// ── C7 sessions ───────────────────────────────────────────────────────────────
const instById = new Map(instances.map((i) => [i.id, i]));
const sessionState = new Map();
for (const r of rows) {
  const s = `${r.at}|${nrm(r.offering)}|${nrm(r.venue)}`;
  const b = L.get(rowKey(r.personKey, r.at, r.offering, r.venue));
  const inst = b?.classInstanceId ? instById.get(b.classInstanceId) : null;
  const st = inst ? (inst.sourceImportJobId ? "created" : "matched") : (!offeringDecided(r.offering) || !venueDecided(r.venue) || b?.disposition === "pending_conflict") ? "pending" : "no_attendance";
  const rank = { created: 3, matched: 3, pending: 1, no_attendance: 0 };
  if (!sessionState.has(s) || rank[st] > rank[sessionState.get(s)]) sessionState.set(s, st);
}
const sessionCounts = {}; for (const v of sessionState.values()) sessionCounts[v] = (sessionCounts[v] ?? 0) + 1;
const createdWithEnd = instances.filter((i) => i.sourceImportJobId && i.endTime !== null).length;
check("C7-sessions", sessionState.size === sessions.size && createdWithEnd === 0,
  `provisional ${sessions.size} → ${JSON.stringify(sessionCounts)} · import-created sessions ${instances.filter((i) => i.sourceImportJobId).length} (with an end time: ${createdWithEnd})`);

if (ledgerOut) writeFileSync(ledgerOut, JSON.stringify({ sha256, checks, diffs }, null, 1));
const failed = checks.filter((c) => c.result === "FAIL").length;
console.log(`${failed ? "NOT RECONCILED" : "RECONCILED"} — ${checks.length - failed}/${checks.length} checks pass`);
process.exit(failed ? 1 : 0);
