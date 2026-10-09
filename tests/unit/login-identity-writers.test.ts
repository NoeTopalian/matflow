// Writer inventory for login addresses (admin hub AH-01, 9 Oct 2026).
//
// The cross-table claim lock in lib/login-email.ts (claimLoginIdentity /
// claimLoginIdentities) only protects "one login address per club across
// User and Member" while EVERY writer of User.email / Member.email takes it.
// This scan of app/ and lib/ fails when a write to a User or Member row could
// set `email` and its file neither claims nor sits on the allow-list below
// with a reason. A write whose `data` is not a literal (a spread, a variable,
// a mapped array) is treated as possibly writing `email` — it must claim or be
// explained. Allow-list entries that no longer match a write fail too, so the
// list cannot rot.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

/** Files allowed to write User/Member rows without a claim, and why. */
const ALLOW: Record<string, string> = {
  "app/api/admin/create-tenant/route.ts":
    "creates the club and its first owner in ONE transaction; no other row can exist in a club that does not exist yet",
  "app/api/admin/applications/[id]/approve/route.ts":
    "creates the club and its first owner in ONE transaction; no other row can exist in a club that does not exist yet",
  "app/api/admin/dsar/erase/route.ts":
    "renames to a per-member sentinel deleted-<id>@deleted.invalid: unique by member id, never a deliverable or claimable login",
  "app/api/admin/import/[id]/rollback/route.ts":
    "data is refreshWrite(...) — status, payment and billing columns only (lib/importers/teamup-refresh.ts); never email",
  "app/api/member/children/[id]/route.ts": "data is updateData typed { name?, dateOfBirth? } — never email",
  "app/api/member/children/route.ts": "a child is created on a fresh synthesised no-login address (synthesiseKidEmail): random, never shared",
  "app/api/members/[id]/link-child/route.ts": "guardian link columns only (parentMemberId, guardian confirmation); never email",
  "app/api/members/accept-invite/route.ts": "sets the password and date of birth on the member the token names; never email",
  "app/api/stripe/webhook/route.ts": "payment and subscription columns only; never email",
  "lib/stripe/migrate-memberships.ts": "Stripe subscription linkage columns only; never email",
  "lib/undo-registry.ts": "guardian-link undo only (parentMemberId + confirmation); login addresses are not restorable (f22ac66)",
};

/** A file that claims: the claim must be inside the writer's transaction (typed: LoginClaimTx). */
const CLAIMS = /\b(claimLoginIdentity|claimLoginIdentities|loginEmailTaken)\s*\(/;

type Finding = { file: string; line: number; call: string; why: "email" | "opaque" | "nested" };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** The text of the call starting at `open` (index just after its "("), balanced. */
function callBody(src: string, open: number): string {
  let depth = 1;
  let i = open;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  return src.slice(open, i - 1);
}

const EMAIL_KEY = /(^|[\s{,])email\s*[:,}]/;

/** Classify the `data` of one write call. */
function classify(body: string): "email" | "opaque" | null {
  const at = body.search(/\bdata\s*:/);
  if (at < 0) return null;
  const data = body.slice(at).replace(/^data\s*:\s*/, "");
  if (EMAIL_KEY.test(data)) return "email";
  if (!data.startsWith("{")) return "opaque"; // a variable, a call, a mapped array
  if (/\.\.\.\s*[A-Za-z_(]/.test(data)) return "opaque"; // a spread into the literal
  return null;
}

export function scan(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const write = /\.(user|member)\.(create|createMany|update|updateMany|upsert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = write.exec(src))) {
    const why = classify(callBody(src, m.index + m[0].length));
    if (why) out.push({ file, line: src.slice(0, m.index).split("\n").length, call: `${m[1]}.${m[2]}`, why });
  }
  const nested = /\b(users|members|children)\s*:\s*\{\s*create(Many)?\s*:/g;
  while ((m = nested.exec(src))) {
    out.push({ file, line: src.slice(0, m.index).split("\n").length, call: `nested ${m[1]}.create`, why: "nested" });
  }
  return out;
}

function inventory() {
  const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib"))];
  const findings: Finding[] = [];
  const claiming = new Set<string>();
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    const src = fs.readFileSync(abs, "utf8");
    const f = scan(rel, src);
    if (f.length === 0) continue;
    findings.push(...f);
    if (CLAIMS.test(src)) claiming.add(rel);
  }
  return { findings, claiming };
}

describe("login identity writer inventory", () => {
  it("the scanner sees an email write, an opaque write and a nested create (positive controls)", () => {
    expect(scan("x.ts", "await tx.member.create({ data: { tenantId, email: e } })")).toMatchObject([{ why: "email" }]);
    expect(scan("x.ts", "await tx.user.update({ where: { id }, data: { email } })")).toMatchObject([{ why: "email" }]);
    expect(scan("x.ts", "await tx.member.updateMany({ where: { id }, data: { ...rest } })")).toMatchObject([{ why: "opaque" }]);
    expect(scan("x.ts", "await tx.member.createMany({ data: rows.map(f) })")).toMatchObject([{ why: "opaque" }]);
    expect(scan("x.ts", "tx.tenant.create({ data: { users: { create: { email } } } })")).toMatchObject([{ why: "nested" }]);
    expect(scan("x.ts", "await tx.member.update({ where: { id }, data: { name: n } })")).toEqual([]);
  });

  it("every User/Member write that could set email claims the address or is allow-listed with a reason", () => {
    const { findings, claiming } = inventory();
    const unexplained = findings.filter((f) => !claiming.has(f.file) && !ALLOW[f.file]);
    expect(unexplained.map((f) => `${f.file}:${f.line} ${f.call} (${f.why})`)).toEqual([]);
  });

  it("the known login-address writers are all claiming", () => {
    const { claiming } = inventory();
    for (const f of [
      "app/api/members/route.ts",
      "app/api/members/[id]/route.ts",
      "app/api/members/[id]/guardian/route.ts",
      "app/api/member/me/route.ts",
      "app/api/staff/route.ts",
      "app/api/staff/[id]/route.ts",
      "app/api/account/login-email/route.ts",
      "app/api/admin/customers/[id]/login-email/route.ts",
      "app/api/admin/import/[id]/commit/route.ts",
    ]) {
      expect(claiming.has(f), f).toBe(true);
    }
  });

  it("no allow-list entry is stale, empty, or shadowing a claiming file", () => {
    const { findings, claiming } = inventory();
    const flagged = new Set(findings.map((f) => f.file));
    for (const [file, reason] of Object.entries(ALLOW)) {
      expect(reason.length, file).toBeGreaterThan(20);
      expect(flagged.has(file), `${file} no longer writes User/Member — remove it from ALLOW`).toBe(true);
      expect(claiming.has(file), `${file} claims — it does not need an allow-list entry`).toBe(false);
    }
  });
});
