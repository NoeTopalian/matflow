// Every session-authenticated mutating route checks its origin.
//
// The repo's stated policy is that `assertSameOrigin` guards every
// state-mutating route, and a sweep bulk-applied it. Five were missed, and the
// misses were not random — they are the routes where a cross-site POST costs
// the most:
//
//   * members/[id]/waiver/sign EXECUTES a legal document in a member's name and
//     writes the club's liability evidence;
//   * admin/dsar/erase performs an irreversible GDPR erase — and despite the
//     /admin path it is gated by a TENANT owner session, not the operator
//     plane, so an owner's browser is the attack surface;
//   * admin/import/[id]/commit and /preview act on a whole membership import,
//     while their sibling admin/import/upload guards correctly;
//   * products POST, while its own [id] sibling guards.
//
// Token-authenticated routes are genuinely exempt (the kiosk, the Stripe
// webhook) because the token is not a cookie the browser attaches for you. The
// operator plane is NOT exempt, because `isAdminAuthed` accepts the
// `matflow_admin` COOKIE — that exclusion is tracked separately and is a bigger
// piece of work than this file.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

/** Comments stripped, so a route that merely MENTIONS the guard does not pass. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the five routes that were missed", () => {
  const missed = [
    "app/api/members/[id]/waiver/sign/route.ts",
    "app/api/admin/dsar/erase/route.ts",
    "app/api/admin/import/[id]/commit/route.ts",
    "app/api/admin/import/[id]/preview/route.ts",
    "app/api/products/route.ts",
  ];

  for (const file of missed) {
    it(`${file} checks its origin`, () => {
      const src = code(file);
      expect(src, "guard not imported").toContain('from "@/lib/csrf"');
      // The CALL, not the import — an import alone is the vacuous shape.
      expect(src, "guard imported but never called").toMatch(/assertSameOrigin\(\s*req\s*\)/);
    });
  }
});

describe("and no session-authenticated mutation ships without one", () => {
  it("holds across every route in the product", () => {
    // Token-authenticated surfaces verify a bearer secret the browser does not
    // attach on its own, so a cross-site POST cannot forge them.
    const TOKEN_AUTHENTICATED = [
      "app/api/kiosk/",
      "app/api/stripe/webhook/",
      "app/api/resend/",
      "app/api/cron/",
      "app/api/waiver/",
      "app/api/health/",
    ];
    // The operator plane used to sit here wholesale, excluded because
    // `isAdminAuthed` accepts a COOKIE and closing it was "a larger piece of
    // work than this sweep". It is closed now: every operator MUTATION checks
    // its origin, and the positive assertions below name them one by one so it
    // cannot quietly reopen.
    //
    // What remains is the operator LOGIN surface, and it remains on purpose.
    // Those routes establish a session rather than acting on one, so there is
    // no cookie yet to ride; the residual is login-CSRF, which is real but far
    // smaller than forging a suspension or an impersonation. admin/auth/logout
    // takes no `req` at all, so guarding it is a signature change for a
    // nuisance-grade attack. Named and sized, not hidden.
    const KNOWN_GAP = ["app/api/admin/auth/", "app/api/admin/operators/", "app/api/admin/platform/"];

    // Exports a POST but mutates nothing: the handler authenticates and then
    // returns an unconditional 403. There is no state to forge a change to, and
    // it takes no `req` to check an origin on — a guard here would be
    // decorative. The test below asserts it is STILL that, so implementing it
    // fails loudly rather than shipping through this exclusion.
    const NOT_A_MUTATION = ["app/api/auth/totp/disable/route.ts"];

    const offenders: string[] = [];
    for (const file of walk("app/api")) {
      if (TOKEN_AUTHENTICATED.some((p) => file.startsWith(p))) continue;
      if (KNOWN_GAP.some((p) => file.startsWith(p))) continue;
      if (NOT_A_MUTATION.includes(file)) continue;
      const src = code(file);
      const mutates = /export async function (POST|PATCH|PUT|DELETE)\b/.test(src);
      if (!mutates) continue;
      // Only routes that actually read a session are in scope — a route with no
      // cookie auth has no cookie to ride.
      // Operator auth counts too. This predicate recognised only TENANT session
      // helpers, so even without KNOWN_GAP every operator route fell out of
      // scope here — two independent reasons the plane was never swept, either
      // of which alone would have hidden it.
      const sessionAuthed = /requireApi|await auth\(\)|isAdminAuthed|getOperatorContext/.test(src);
      if (!sessionAuthed) continue;
      if (!/assertSameOrigin\(/.test(src)) offenders.push(file);
    }

    // This is the assertion that would have caught all five on the day the
    // sweep claimed to be complete.
    expect(offenders).toEqual([]);
  });
});

describe("every operator-plane mutation checks its origin", () => {
  // Named individually rather than derived, because this is the surface where a
  // forged request is worst: suspending a club, transferring its ownership,
  // stripping a member's second factor, or starting a session AS THE OWNER.
  //
  // lib/admin-auth.ts accepts a `matflow_admin` cookie, and a cookie rides
  // along on a cross-site form post — so before this, every one of these was
  // reachable from any page an operator happened to have open.
  const OPERATOR_MUTATIONS = [
    "app/api/admin/create-tenant/route.ts",
    "app/api/admin/applications/[id]/approve/route.ts",
    "app/api/admin/applications/[id]/reject/route.ts",
    "app/api/admin/customers/[id]/suspend/route.ts",
    "app/api/admin/customers/[id]/soft-delete/route.ts",
    "app/api/admin/customers/[id]/transfer-ownership/route.ts",
    "app/api/admin/customers/[id]/force-password-reset/route.ts",
    "app/api/admin/customers/[id]/totp-reset/route.ts",
    "app/api/admin/customers/[id]/member-totp-reset/route.ts",
    "app/api/admin/impersonate/route.ts",
  ];

  it("guards all of them", () => {
    const unguarded = OPERATOR_MUTATIONS.filter((f) => !/assertSameOrigin\(/.test(code(f)));
    expect(unguarded).toEqual([]);
  });

  it("guards EVERY mutating handler in those files, not just the first", () => {
    // suspend and soft-delete each export a POST AND a DELETE, and impersonate
    // does too. A file-level grep is satisfied by one of the two, which would
    // leave the other wide open while the test above stayed green.
    const short = [];
    for (const f of OPERATOR_MUTATIONS) {
      const s = code(f);
      const handlers = (s.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) || []).length;
      const guards = (s.match(/assertSameOrigin\(/g) || []).length;
      if (guards < handlers) short.push(`${f}: ${handlers} handler(s), ${guards} guard(s)`);
    }
    expect(short).toEqual([]);
  });
});

describe("the one route excluded as not-a-mutation", () => {
  it("is still a stub that refuses everyone, so the exclusion still holds", () => {
    // It is excluded from the sweep above because it changes nothing: the
    // handler authenticates and returns an unconditional 403, and takes no
    // `req` to check an origin on. The moment someone implements it, this fails
    // and they have to add the guard — which is the whole point of excluding it
    // by name rather than by silence.
    const src = code("app/api/auth/totp/disable/route.ts");
    expect(src).toMatch(/status:\s*403/);
    // No branch that could ever succeed: no DB client, no update of any kind.
    expect(src, "totp/disable now touches state — it needs a CSRF guard")
      .not.toMatch(/prisma|withTenantContext|withRlsBypass|\.update\(|\.create\(/);
  });
});

describe("the waiver pair no longer disagrees", () => {
  it("sending the link is not stricter than signing on someone's behalf", () => {
    // waiver-link kept a LOCAL two-element STAFF_ROLES shadowing the shared
    // four-element constant under the identical name, so the strictly less
    // powerful verb (email the member a link) was the restricted one while its
    // sibling (execute the document in their name) admitted every staff role.
    const link = code("app/api/members/[id]/waiver-link/route.ts");
    expect(link, "still shadows the shared constant")
      .not.toMatch(/const STAFF_ROLES\s*=/);
    expect(link).toContain('from "@/lib/authz"');
  });
});
