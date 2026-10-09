// Writer inventory for login addresses (admin hub AH-01, 9 Oct 2026; per-call
// rewrite, security lane B, 9 Oct 2026 — AH-R3 / SEC-029).
//
// The cross-table claim lock in lib/login-email.ts (claimLoginIdentity /
// claimLoginIdentities / loginEmailTaken) only protects "one login address per
// club across User and Member" while EVERY writer of User.email / Member.email
// takes it inside the writer's own transaction, before the write.
//
// This scan classifies EVERY write PER CALL (not per file):
//   - delegate writes on `.user` / `.member` (also `["user"]`): create,
//     createMany, createManyAndReturn, update, updateMany, updateManyAndReturn,
//     upsert — the `data`, `create` and `update` arguments, including a
//     shorthand `data`, a quoted or computed "email" key, a spread, or a
//     non-literal argument (all treated as possibly writing `email`);
//   - nested writes through ANY relation field whose type is User or Member
//     (read from prisma/schema.prisma, so a new relation is covered without
//     editing this file): create, createMany, connectOrCreate, upsert, update,
//     updateMany;
//   - raw SQL ($executeRaw / $queryRaw / *Unsafe / Prisma.sql) that UPDATEs or
//     INSERTs into "User" or "Member", and any *Unsafe call with a non-literal
//     statement.
// A call passes only if (a) it sits inside a transaction callback
// (withTenantContext / withRlsBypass / $transaction) in which a claim call
// appears BEFORE it, or (b) it is on the per-call allow-list below with a
// reason. Allow-list entries carry an exact count, so a second write of the
// same kind in an allow-listed file fails, and a stale entry fails.
//
// Out-of-band writers (scripts/, prisma/seed.ts) are pinned the same way: they
// take no claim, retire no tokens and write no audit row, so each is listed
// with what it does; a NEW one fails.
//
// What this does NOT prove (enforcement statement, ACCOUNT-EDITING.md): a
// textual scan cannot see a write assembled through a helper in another file,
// a client extension, or a hand-typed psql session. The database has no
// cross-table constraint; the claim is a convention every writer must follow.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

type Why = "email" | "opaque" | "nested" | "raw";
export type Finding = { file: string; line: number; offset: number; call: string; why: Why; claimed: boolean };

/** Per call: "<file>#<call>" → [count, reason]. In-app writers that take no claim. */
const ALLOW: Record<string, [number, string]> = {
  "app/api/admin/create-tenant/route.ts#nested users.create": [1, "creates the club and its first owner in ONE transaction; no other row can exist in a club that does not exist yet"],
  "app/api/admin/applications/[id]/approve/route.ts#nested users.create": [1, "creates the club and its first owner in ONE transaction; no other row can exist in a club that does not exist yet"],
  "app/api/admin/dsar/erase/route.ts#member.update": [1, "renames to the per-member sentinel deleted-<id>@deleted.invalid: unique by member id, never a deliverable or claimable login"],
  "app/api/admin/import/[id]/commit/route.ts#member.updateMany": [1, "status refresh: data is refreshWrite(...) — status, payment and billing columns only (lib/importers/teamup-refresh.ts); never email"],
  "app/api/admin/import/[id]/rollback/route.ts#member.updateMany": [1, "refresh rollback: data is refreshWrite(...) — status, payment and billing columns only; never email"],
  "app/api/member/children/[id]/route.ts#member.updateMany": [1, "data is updateData typed { name?, dateOfBirth? } — never email"],
  "app/api/member/children/route.ts#member.create": [1, "a child is created on a fresh synthesised no-login address (synthesiseKidEmail): random, never shared"],
  "app/api/members/[id]/link-child/route.ts#member.updateMany": [1, "guardian link columns (parentMemberId, CONFIRMED_BY spread, derived accountType); never email"],
  "app/api/members/accept-invite/route.ts#member.update": [1, "sets the password, date of birth and derived accountType on the member the token names; never email"],
  "app/api/stripe/webhook/route.ts#member.update": [1, "payment, hold and status columns (conditional spreads); never email"],
  "lib/stripe/migrate-memberships.ts#member.updateMany": [2, "Stripe subscription linkage and tier columns (membershipTierWrite spread); never email"],
  "lib/undo-registry.ts#member.updateMany": [2, "guardian-link undo only (parentMemberId + CONFIRMED_BY spread); login addresses are not restorable (f22ac66, AH-H2)"],
};

/**
 * Out-of-band writers: run by hand with database credentials. None claims,
 * retires tokens, bumps sessionVersion or writes an audit row. Pinned per call.
 */
const OUT_OF_BAND: Record<string, [number, string]> = {
  "prisma/seed.ts#user.upsert": [3, "local/demo seed (owner, coach, admin of the seed club)"],
  "prisma/seed.ts#member.upsert": [1, "local/demo seed members"],
  "scripts/seed-demo-rich.mjs#user.createMany": [1, "demo data generator (fresh demo club)"],
  "scripts/seed-demo-rich.mjs#member.createMany": [1, "demo data generator (fresh demo club)"],
  "scripts/stripe-dispute-closed-e2e.mjs#user.create": [1, "Stripe test-mode e2e fixture club"],
  "scripts/stripe-dispute-closed-e2e.mjs#member.create": [1, "Stripe test-mode e2e fixture club"],
  "scripts/stripe-family-e2e.mjs#member.create": [1, "Stripe test-mode e2e fixture club"],
  "scripts/stripe-lifecycle-e2e.mjs#user.create": [1, "Stripe test-mode e2e fixture club"],
  "scripts/stripe-lifecycle-e2e.mjs#member.create": [1, "Stripe test-mode e2e fixture club"],
  "scripts/stripe-migration-e2e.mjs#user.create": [1, "Stripe test-mode e2e fixture club"],
  "scripts/stripe-migration-e2e.mjs#member.create": [4, "Stripe test-mode e2e fixture club"],
  "scripts/wipe-totalbjj-demo-data.mjs#user.update": [1, "one-shot of 3 Oct 2026 (already run): demo owner → the real owner, guarded by exact demo-state checks; no claim/token retirement/audit"],
  "scripts/setup-test-accounts.mjs#user.updateMany": [2, "OPEN FINDING SEC-B-F1: rewrites the owner login of the `totalbjj` club and of `noetest` to fixed addresses and resets the password, against whatever DATABASE_URL dotenv loads (.env = production), with no host guard, no claim, no token retirement, no audit — delete or guard (lane E / lead)"],
  "scripts/setup-test-accounts.mjs#user.create": [1, "OPEN FINDING SEC-B-F1 (same script): creates the noetest owner"],
  "scripts/apply-rls-enforcement.ts#raw executeRawUnsafe (non-literal)": [1, "DDL only: ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY statements filtered from the migration file; no row data"],
  "scripts/create-restricted-role.ts#raw executeRawUnsafe (non-literal)": [1, "DDL only: CREATE ROLE / GRANT for matflow_app; no row data"],
};

/** A claim call: must sit in the writer's transaction (typed LoginClaimTx). */
const CLAIM = /\b(claimLoginIdentity|claimLoginIdentities|loginEmailTaken)\s*\(/;
const TX_OPEN = /\b(withTenantContext|withRlsBypass)\s*\(|\$transaction\s*\(/g;
const WRITE_OPS = "create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert";
const NESTED_OPS = /\b(create|createMany|connectOrCreate|upsert|update|updateMany)\s*:/g;
const RAW_WRITE = /\b(UPDATE|INSERT\s+INTO|MERGE\s+INTO)\s+(?:"?public"?\s*\.\s*)?"?(User|Member)"?(?![A-Za-z])/i;

/** Relation fields typed User / Member, read from the schema. */
export function relationFields(schema: string): string[] {
  const out = new Set<string>();
  for (const m of schema.matchAll(/^\s+([a-zA-Z_]\w*)\s+(User|Member)(\?|\[\])?(\s|$)/gm)) out.add(m[1]);
  return [...out].sort();
}
const SCHEMA_RELATIONS = relationFields(fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8"));

/** Balanced text from `open` (just after an opening bracket) to its close. */
function balanced(src: string, open: number, o = "(", c = ")"): string {
  let depth = 1;
  let i = open;
  while (i < src.length && depth > 0) {
    if (src[i] === o) depth++;
    else if (src[i] === c) depth--;
    i++;
  }
  return src.slice(open, i - 1);
}

/** Object literal text starting at `s[0] === "{"`, or null. */
function objectAt(s: string): string | null {
  return s.startsWith("{") ? `{${balanced(s, 1, "{", "}")}}` : null;
}

const EMAIL_KEY = /(^|[\s{,])(["'`]?)email\2\s*[:,}]|\[\s*["'`]email["'`]\s*\]\s*:/;

/** Classify one write-argument value. */
function classifyValue(v: string): "email" | "opaque" | null {
  const o = objectAt(v.trimStart());
  if (!o) return "opaque"; // a variable, a call, a mapped array, a ternary
  if (EMAIL_KEY.test(o)) return "email";
  if (/\.\.\.\s*[A-Za-z_($[]/.test(o)) return "opaque"; // a spread into the literal
  return null;
}

/**
 * Source with comments blanked to spaces (offsets and newlines preserved), so
 * a "data:" or "UPDATE \"Member\"" in a comment is never read as code.
 * Strings and template literals are kept as they are.
 */
export function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let q: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q) {
      if (c === "\\") { i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; i++; continue; }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] !== "\n") out[i] = " "; i++; }
      if (i < src.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Depth-1 text of an object literal (nested braces/brackets/parens blanked). */
function topLevel(obj: string): string {
  let depth = 0;
  let s = "";
  for (const ch of obj) {
    if ("{[(".includes(ch)) { depth++; s += depth === 1 ? ch : " "; continue; }
    if ("}])".includes(ch)) { s += depth === 1 ? ch : " "; depth--; continue; }
    s += depth === 1 ? ch : " ";
  }
  return s;
}

/** Classify the argument list of one delegate write call. */
function classifyArgs(args: string): "email" | "opaque" | null {
  const a = args.trimStart();
  if (!a.startsWith("{")) return a.length ? "opaque" : null; // the whole argument is a variable
  const top = objectAt(a)!;
  const flat = topLevel(top);
  if (/\.\.\.\s*[A-Za-z_($[]/.test(flat)) return "opaque"; // `{ ...args }` at the top level
  if (/(^|[{,]\s*)(data|create|update)\s*[,}]/.test(flat)) return "opaque"; // shorthand `{ where, data }`
  const vals: string[] = [];
  for (const m of flat.matchAll(/(?<![\w$.])(data|create|update)\s*:/g)) vals.push(top.slice(m.index! + m[0].length));
  let worst: "email" | "opaque" | null = null;
  for (const v of vals) {
    const c = classifyValue(v);
    if (c === "email") return "email";
    if (c === "opaque") worst = "opaque";
  }
  return worst;
}

/** Spans of transaction callbacks: [start, end) offsets in src. */
function txSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of src.matchAll(TX_OPEN)) {
    const open = m.index! + m[0].length;
    spans.push([open, open + balanced(src, open).length]);
  }
  return spans;
}

/** Inside the innermost enclosing transaction callback, does a claim call come before `at`? */
function claimedAt(src: string, spans: Array<[number, number]>, at: number): boolean {
  const enclosing = spans.filter(([s, e]) => s <= at && at < e).sort((x, y) => (y[0] - x[0]))[0];
  if (!enclosing) return false;
  const body = src.slice(enclosing[0], at);
  return CLAIM.test(body);
}

export function scan(file: string, source: string, relations: string[] = SCHEMA_RELATIONS): Finding[] {
  const src = stripComments(source);
  const out: Finding[] = [];
  const spans = txSpans(src);
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const push = (offset: number, call: string, why: Why) => {
    out.push({ file, line: lineOf(offset), offset, call, why, claimed: claimedAt(src, spans, offset) });
  };

  // 1. Delegate writes.
  const delegate = new RegExp(String.raw`(?:\.(user|member)|\[\s*["'](user|member)["']\s*\])\s*\.\s*(${WRITE_OPS})\s*\(`, "g");
  for (const m of src.matchAll(delegate)) {
    const why = classifyArgs(balanced(src, m.index! + m[0].length));
    if (why) push(m.index!, `${m[1] ?? m[2]}.${m[3]}`, why);
  }

  // 2. Nested writes through a relation typed User / Member.
  if (relations.length) {
    const rel = new RegExp(String.raw`(?<![\w$.])(${relations.join("|")})\s*:\s*\{`, "g");
    for (const m of src.matchAll(rel)) {
      const obj = `{${balanced(src, m.index! + m[0].length, "{", "}")}}`;
      for (const op of obj.matchAll(NESTED_OPS)) {
        const v = obj.slice(op.index! + op[0].length).trimStart();
        // connect-style payloads with no write of columns are not writes of email.
        const c = op[1] === "connectOrCreate" ? classifyValue((v.match(/create\s*:\s*([\s\S]*)/) ?? ["", "{}"])[1]) : classifyValue(v);
        if (c) {
          push(m.index!, `nested ${m[1]}.${op[1]}`, "nested");
          break;
        }
      }
    }
  }

  // 3. Raw SQL that writes the two identity tables.
  for (const m of src.matchAll(/\$(executeRaw|queryRaw)(Unsafe)?\s*(`|\()|\bPrisma\.sql\s*`/g)) {
    const start = m.index! + m[0].length;
    if (m[2] === "Unsafe" && m[3] === "(") {
      const arg = balanced(src, start).trimStart();
      if (!/^["'`]/.test(arg)) { push(m.index!, `raw ${m[1]}Unsafe (non-literal)`, "raw"); continue; }
      if (RAW_WRITE.test(arg)) push(m.index!, `raw ${m[1]}Unsafe`, "raw");
      continue;
    }
    const text = m[3] === "(" ? balanced(src, start) : src.slice(start, src.indexOf("`", start));
    if (RAW_WRITE.test(text)) push(m.index!, `raw ${m[1] ?? "Prisma.sql"}`, "raw");
  }
  return out.sort((a, b) => a.offset - b.offset);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p, out);
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");
const rootFiles = () =>
  fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|mts|mjs)$/.test(e.name) && !/\.config\./.test(e.name))
    .map((e) => path.join(ROOT, e.name));

function inventory(files: string[]) {
  const findings: Finding[] = [];
  for (const abs of files) findings.push(...scan(rel(abs), fs.readFileSync(abs, "utf8")));
  return findings;
}
const inApp = () => inventory([...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib")), ...rootFiles()]);
const outOfBand = () => inventory([...walk(path.join(ROOT, "scripts")), path.join(ROOT, "prisma", "seed.ts")].filter((f) => fs.existsSync(f)));
const key = (f: Finding) => `${f.file}#${f.call}`;
function countBy(list: Finding[]) {
  const m = new Map<string, number>();
  for (const f of list) m.set(key(f), (m.get(key(f)) ?? 0) + 1);
  return m;
}

describe("login identity writer inventory (per call)", () => {
  it("the schema relation list is read (User/Member relations, incl. users/members/children/parent)", () => {
    for (const r of ["users", "members", "children", "parent", "member", "user"]) expect(SCHEMA_RELATIONS, r).toContain(r);
  });

  it("positive controls: every write FORM is seen (AH-R3: upsert, raw SQL, quoted key, nested singular, per call)", () => {
    const one = (src: string) => scan("x.ts", src).map((f) => ({ call: f.call, why: f.why, claimed: f.claimed }));
    // plain, shorthand, quoted, computed
    expect(one("await tx.member.create({ data: { tenantId, email: e } })")).toMatchObject([{ why: "email" }]);
    expect(one("await tx.user.update({ where: { id }, data: { email } })")).toMatchObject([{ why: "email" }]);
    expect(one(`await tx.member.update({ where: { id }, data: { "email": e } })`)).toMatchObject([{ why: "email" }]);
    expect(one(`await tx.member.update({ where: { id }, data: { ["email"]: e } })`)).toMatchObject([{ why: "email" }]);
    expect(one("await tx.member.update({ where, data })")).toMatchObject([{ why: "opaque" }]);
    expect(one("await tx.member.update(args)")).toMatchObject([{ why: "opaque" }]);
    expect(one(`await tx["member"].update({ where: { id }, data: { email } })`)).toMatchObject([{ why: "email" }]);
    // spreads and mapped arrays
    expect(one("await tx.member.updateMany({ where: { id }, data: { ...rest } })")).toMatchObject([{ why: "opaque" }]);
    expect(one("await tx.member.createMany({ data: rows.map(f) })")).toMatchObject([{ why: "opaque" }]);
    expect(one("await tx.member.createManyAndReturn({ data: [{ email }] })")).toMatchObject([{ why: "opaque" }]);
    // upsert: create AND update keys
    expect(one("await tx.member.upsert({ where: { id }, create: { tenantId, email, name }, update: { name } })")).toMatchObject([{ why: "email" }]);
    expect(one("await tx.user.upsert({ where: { id }, create: { name }, update: { email: e } })")).toMatchObject([{ why: "email" }]);
    // nested, plural and singular, connectOrCreate
    expect(one("tx.tenant.create({ data: { users: { create: { email } } } })")).toMatchObject([{ call: "nested users.create", why: "nested" }]);
    expect(one("tx.payment.create({ data: { member: { create: { email, name } } } })")).toMatchObject([{ call: "nested member.create" }]);
    expect(one("tx.payment.update({ where, data: { member: { update: { email: e } } } })")).toMatchObject([{ call: "nested member.update" }]);
    expect(one("tx.order.create({ data: { member: { connectOrCreate: { where: { id }, create: { email } } } } })")).toMatchObject([{ call: "nested member.connectOrCreate" }]);
    // raw SQL
    expect(one('await tx.$executeRaw`UPDATE "Member" SET "email" = ${e} WHERE "id" = ${id}`')).toMatchObject([{ why: "raw" }]);
    expect(one('await tx.$executeRaw`INSERT INTO public."User" ("email") VALUES (${e})`')).toMatchObject([{ why: "raw" }]);
    expect(one('await tx.$executeRawUnsafe(`UPDATE "User" SET email = $1`, e)')).toMatchObject([{ why: "raw" }]);
    expect(one("await tx.$executeRawUnsafe(sql, e)")).toMatchObject([{ why: "raw" }]);
    // claim containment is PER CALL: a claimed write and an unclaimed write in one file
    const mixed = `
      await withTenantContext(t, async (tx) => { await claimLoginIdentity(tx, { tenantId: t, email: e }); await tx.member.create({ data: { email: e } }); });
      await withTenantContext(t, async (tx) => { await tx.member.update({ where: { id }, data: { email: e } }); });
      await withTenantContext(t, async (tx) => { await tx.member.update({ where: { id }, data: { email: e } }); await claimLoginIdentity(tx, { tenantId: t, email: e }); });`;
    expect(one(mixed).map((f) => f.claimed)).toEqual([true, false, false]);
    // negatives: no email, connect-only, reads, raw reads, other tables
    expect(one("await tx.member.update({ where: { id }, data: { name: n } })")).toEqual([]);
    expect(one("await tx.payment.create({ data: { member: { connect: { id } } } })")).toEqual([]);
    expect(one("await tx.member.findMany({ where: { member: { email } } })")).toEqual([]);
    expect(one('await tx.$queryRaw`SELECT "email" FROM "Member"`')).toEqual([]);
    expect(one('await tx.$executeRaw`UPDATE "MemberRank" SET "x" = 1`')).toEqual([]);
    expect(one('// await tx.member.update({ where: { id }, data: { email } })\n/* tx.$executeRaw`UPDATE "Member" SET email = 1` */')).toEqual([]);
    expect(one("await tx.member.updateMany({ where: { id, ...(x ? { y } : {}) }, data: { status: s } })")).toEqual([]);
  });

  it("every in-app User/Member write that could set email is claimed in ITS transaction, or allow-listed per call", () => {
    const findings = inApp();
    const unclaimed = findings.filter((f) => !f.claimed);
    const counts = countBy(unclaimed);
    const unexplained = [...counts.entries()].filter(([k, n]) => !ALLOW[k] || ALLOW[k][0] !== n);
    expect(
      unexplained.map(([k, n]) => `${k} ×${n} (allowed ×${ALLOW[k]?.[0] ?? 0}) at ${unclaimed.filter((f) => key(f) === k).map((f) => f.line).join(",")}`),
    ).toEqual([]);
  });

  it("the known login-address writers claim at the write itself (not just somewhere in the file)", () => {
    const findings = inApp();
    for (const [file, call] of [
      ["app/api/members/route.ts", "member.create"],
      ["app/api/members/[id]/route.ts", "member.updateMany"],
      ["app/api/members/[id]/guardian/route.ts", "member.update"],
      ["app/api/member/me/route.ts", "member.updateMany"],
      ["app/api/staff/route.ts", "user.create"],
      ["app/api/staff/[id]/route.ts", "user.updateMany"],
      ["app/api/account/login-email/route.ts", "user.update"],
      ["app/api/admin/customers/[id]/login-email/route.ts", "user.updateMany"],
      ["app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts", "member.updateMany"],
      ["app/api/admin/import/[id]/commit/route.ts", "member.createMany"],
    ] as const) {
      const hits = findings.filter((f) => f.file === file && f.call === call);
      expect(hits.length, `${file} ${call}`).toBeGreaterThan(0);
      expect(hits.some((f) => f.claimed), `${file} ${call} claimed`).toBe(true);
    }
  });

  it("no allow-list entry is stale, empty, or shadowing a claimed write", () => {
    const findings = inApp();
    const unclaimed = countBy(findings.filter((f) => !f.claimed));
    for (const [k, [n, reason]] of Object.entries(ALLOW)) {
      expect(reason.length, k).toBeGreaterThan(20);
      expect(unclaimed.get(k) ?? 0, `${k} — the allowed count no longer matches; re-review it`).toBe(n);
    }
  });

  it("out-of-band writers (scripts/, prisma/seed.ts) are exactly the pinned list — a NEW one fails", () => {
    const counts = countBy(outOfBand());
    expect(Object.fromEntries([...counts.entries()].sort())).toEqual(Object.fromEntries(Object.entries(OUT_OF_BAND).map(([k, [n]]) => [k, n]).sort()));
  });

  it("the client in lib/prisma.ts carries no extension that could rewrite a write out of the scanner's sight", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib", "prisma.ts"), "utf8");
    expect(src).not.toMatch(/\$extends\s*\(/);
    expect(src).not.toMatch(/\$use\s*\(/);
  });
});
