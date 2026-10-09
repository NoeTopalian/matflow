// Security lane B (9 Oct 2026) — SEC-023 support-session read-only backstop.
//
// proxy.ts refuses every non-GET request from a support (impersonation)
// session. Each club mutation handler in lane B's scope also refuses one
// itself, so a matcher change, a proxy bypass or a direct handler call cannot
// turn "read-only support" into writes. Found missing on 15 member mutators
// (sec-b-role-matrix-db: POST /api/members/[id]/unlock as a support session
// answered 200 and unlocked the member at the handler level).
//
// Static: every exported POST/PUT/PATCH/DELETE in app/api/members/**,
// app/api/staff/**, app/api/account/** calls refuseSupportSession( in its own
// body or through the named helper listed below. Behaviour (I level) is pinned
// by the `support` row of tests/integration/sec-b-role-matrix-db.test.ts.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const DIRS = ["app/api/members", "app/api/staff", "app/api/account"];

/** Handlers that legitimately have no session, or refuse through a helper. */
const EXEMPT: Record<string, string> = {
  "app/api/members/accept-invite/route.ts#POST": "public invite redemption: no session; the token names the member",
  "app/api/account/pending-tenant/route.ts#POST": "pre-session: chooses a club before sign-in; no session to impersonate",
  "app/api/members/[id]/profile-picture/route.ts#PUT": "refuses in authoriseTarget(), the gate PUT and DELETE share",
  "app/api/members/[id]/profile-picture/route.ts#DELETE": "refuses in authoriseTarget(), the gate PUT and DELETE share",
};

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

function handlers(src: string): Array<{ method: string; body: string }> {
  const out: Array<{ method: string; body: string }> = [];
  const re = /export async function (POST|PUT|PATCH|DELETE)\s*\(/g;
  const starts: Array<{ method: string; at: number }> = [];
  for (const m of src.matchAll(re)) starts.push({ method: m[1], at: m.index! });
  const all = [...src.matchAll(/export async function \w+\s*\(/g)].map((m) => m.index!);
  for (const s of starts) {
    const next = all.find((i) => i > s.at) ?? src.length;
    out.push({ method: s.method, body: src.slice(s.at, next) });
  }
  return out;
}

describe("SEC-023 support sessions are refused inside every lane-B club mutator", () => {
  const files = DIRS.flatMap((d) => walk(path.join(ROOT, d)));

  it("every mutating handler refuses a support session itself (or is exempt with a reason)", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const abs of files) {
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      const src = fs.readFileSync(abs, "utf8");
      for (const h of handlers(src)) {
        checked++;
        const key = `${rel}#${h.method}`;
        if (EXEMPT[key]) continue;
        if (!/refuseSupportSession\s*\(/.test(h.body)) missing.push(key);
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(missing).toEqual([]);
  });

  it("the exempt helper really refuses, and no exemption is stale", () => {
    const pp = fs.readFileSync(path.join(ROOT, "app/api/members/[id]/profile-picture/route.ts"), "utf8");
    const helper = pp.slice(pp.indexOf("async function authoriseTarget"), pp.indexOf("export async function"));
    expect(helper).toMatch(/refuseSupportSession\(session\)/);
    for (const key of Object.keys(EXEMPT)) {
      const [file, method] = key.split("#");
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(handlers(src).some((h) => h.method === method), key).toBe(true);
    }
  });
});
