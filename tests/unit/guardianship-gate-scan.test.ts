/**
 * Every parent→child door requires a CONFIRMED guardian link (2 Oct 2026).
 * The independent acceptance (S6) found the one door the route sweep missed:
 * the server-rendered child page. This scan walks the member portal pages and
 * the member-facing APIs and fails on any `where` that keys on parentMemberId
 * without `...CONFIRMED_GUARDIAN` — so a new door cannot be added unguarded.
 *
 * Allowed without the gate: the idempotent replay lookup in the create-child
 * route (keyed by the parent's own request id; the child they made is
 * confirmed by construction).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const ROOTS = ["app/member", "app/api/member", "app/api/waiver", "app/api/checkin"];
// Also allowed: reading the PARENT's own row (id: parentMemberId), a signed-waiver
// audit keyed on who collected it, and the per-parent child-count cap (a count,
// not a read of any child).
const ALLOWED = [/createRequestId:\s*requestId/, /\bid:\s*parentMemberId\b/, /collectedBy:\s*parentMemberId/, /^where:\s*\{\s*parentMemberId,\s*tenantId\s*\}$/];
const allowed = (block: string) => ALLOWED.some((a) => a.test(block.replace(/\s+/g, " ")));

describe("guardianship gate scan", () => {
  it("every where keyed on parentMemberId in a parent-facing surface carries CONFIRMED_GUARDIAN", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        // A where block up to two nesting levels deep.
        const re = /where:\s*\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          const block = m[0];
          if (!/\bparentMemberId\b/.test(block)) continue;
          // Only reads that act for a child: the child's row keyed by the signed-in parent.
          if (!/parentMemberId(: memberId|: parentMemberId|,|\s*\})/.test(block)) continue;
          if (block.includes("CONFIRMED_GUARDIAN")) continue;
          if (allowed(block)) continue;
          offenders.push(`${file.replace(/\\/g, "/")}: ${block.replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
