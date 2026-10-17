#!/usr/bin/env node
// READ-ONLY EmailLog report (17 Oct 2026): what was sent, suppressed, failed, bounced or complained, and why —
// the failure view for email until the app has one. Test branch by default; production is refused.
//
//   node scripts/readiness/email-log-report.mjs [--env .env.test] [--days 7] [--tenant <slug>]
//
// Prints counts by status and template, the distinct failure/suppression reasons (addresses removed), and the
// most recent problem rows with the recipient masked (first character + domain). Never prints subjects, bodies,
// full addresses or secrets. One READ ONLY transaction with a statement timeout.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { resolveDbTarget, TEST_ENDPOINT_ID } from "./db-target.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const envFile = path.resolve(opt("env", ".env.test"));
const days = Number(opt("days", "7"));
const tenantSlug = opt("tenant", null);
if (!Number.isFinite(days) || days <= 0 || days > 366) { console.error("--days must be 1–366"); process.exit(2); }
if (!fs.existsSync(envFile)) { console.error(`env file not found: ${envFile}`); process.exit(2); }
const url = fs.readFileSync(envFile, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)?.[1];
if (!url) { console.error(`no DATABASE_URL in ${envFile}`); process.exit(2); }
let host;
try { host = resolveDbTarget(url, { expectHost: TEST_ENDPOINT_ID }); } catch (e) { console.error(`refused: ${e.message}`); process.exit(2); }

const mask = (a) => { const [u, d] = String(a).split("@"); return d ? `${u.slice(0, 1)}…@${d}` : "…"; };
const noAddr = (s) => String(s ?? "").replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, "[address]").slice(0, 160);

const c = new pg.Client({ connectionString: url, statement_timeout: 15000 });
await c.connect();
try {
  await c.query("begin transaction read only");
  await c.query("select set_config('app.bypass_rls','on',true)");
  const where = [`l."createdAt" >= now() - ($1 || ' days')::interval`];
  const params = [String(days)];
  if (tenantSlug) { params.push(tenantSlug); where.push(`l."tenantId" = (select id from "Tenant" where slug = $${params.length})`); }
  const w = where.join(" and ");
  const byStatus = (await c.query(`select status, count(*)::int n from "EmailLog" l where ${w} group by status order by n desc`, params)).rows;
  const byTemplate = (await c.query(`select "templateId", status, count(*)::int n from "EmailLog" l where ${w} group by 1, 2 order by 1, 2`, params)).rows;
  const reasons = (await c.query(`select coalesce("errorMessage", '') reason, status, count(*)::int n from "EmailLog" l where ${w} and status <> 'sent' and status <> 'delivered' group by 1, 2 order by n desc limit 20`, params)).rows;
  const recent = (await c.query(`select l."createdAt", t.slug, l."templateId", l.recipient, l.status, l."errorMessage" from "EmailLog" l join "Tenant" t on t.id = l."tenantId" where ${w} and l.status in ('failed','bounced','complained','suppressed') order by l."createdAt" desc limit 15`, params)).rows;
  await c.query("commit");
  console.log(`EmailLog on ${host}, last ${days} day(s)${tenantSlug ? `, club ${tenantSlug}` : ""} — read at ${new Date().toISOString()}`);
  console.log("\nBy status:");
  for (const r of byStatus) console.log(`  ${r.status.padEnd(18)} ${r.n}`);
  console.log("\nBy template and status:");
  for (const r of byTemplate) console.log(`  ${r.templateId.padEnd(26)} ${r.status.padEnd(18)} ${r.n}`);
  console.log("\nReasons (not sent / not delivered):");
  for (const r of reasons) console.log(`  ${String(r.n).padStart(4)}  ${r.status.padEnd(12)} ${noAddr(r.reason.split(":")[0]) || "(none)"}`);
  console.log("\nMost recent problem rows:");
  for (const r of recent) console.log(`  ${r.createdAt.toISOString()}  ${r.slug.padEnd(22)} ${r.templateId.padEnd(22)} ${mask(r.recipient).padEnd(28)} ${r.status.padEnd(11)} ${noAddr((r.errorMessage ?? "").split(":")[0])}`);
} finally { await c.end(); }
