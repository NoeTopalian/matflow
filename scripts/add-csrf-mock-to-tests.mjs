// Lane 1 iter-1 follow-up: the CSRF sweep added assertSameOrigin to 28+
// mutation routes. Existing tests for those routes constructed `new Request()`
// without an Origin header, so the guard now returns 403 in test environments.
// The established convention (see tests/unit/totp-no-self-disable.test.ts) is
// to add a vi.mock that short-circuits the guard to null at the top of the
// test file. This script applies that mock to test files that import from
// routes I newly CSRF-guarded.
//
// Insertion strategy: place the mock IMMEDIATELY AFTER the line that imports
// `vi` from "vitest". That guarantees we are at top-level (not inside another
// vi.mock block) and that `vi` is in scope when the mock evaluates.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const TOUCHED_ROUTE_PATHS = [
  "@/app/api/settings/route",
  "@/app/api/memberships",
  "@/app/api/ranks",
  "@/app/api/announcements",
  "@/app/api/orders/[id]/mark-paid",
  "@/app/api/members/[id]/rank",
  "@/app/api/classes/route",
  "@/app/api/classes/[id]",
  "@/app/api/class-packs",
  "@/app/api/initiatives",
  "@/app/api/products/[id]",
  "@/app/api/members/[id]/link-child",
  "@/app/api/members/[id]/unlink-child",
  "@/app/api/drive/",
  "@/app/api/admin/email/test",
  "@/app/api/owner/reset-onboarding",
  "@/app/api/reports/generate",
  "@/app/api/coach/instances/[id]/attendance",
  "@/app/api/instances/generate",
  "@/app/api/staff/route",
  "@/app/api/staff/[id]",
  "@/app/api/members/route",
];

const MOCK_BLOCK =
  '\n// Lane 1 iter-1 CSRF-sweep follow-up: short-circuit the guard so test\n' +
  "// Requests (which carry no browser-set Origin header) don't 403.\n" +
  'vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));\n';

function listFiles() {
  const out = execSync("git ls-files tests/unit tests/integration", { encoding: "utf8" });
  return out.split(/\r?\n/).filter((f) => /\.test\.tsx?$/.test(f));
}

let patched = 0;
let skipped = 0;
let needsManual = 0;
for (const file of listFiles()) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (src.includes('vi.mock("@/lib/csrf"')) {
    skipped++;
    continue;
  }
  const touchesGuarded = TOUCHED_ROUTE_PATHS.some((p) => src.includes(p));
  if (!touchesGuarded) {
    skipped++;
    continue;
  }

  // Locate the line that imports `vi` from "vitest" — single-line scan.
  const lines = src.split("\n");
  let insertAfter = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s+\{[^}]*\bvi\b[^}]*\}\s+from\s+["']vitest["']/.test(lines[i])) {
      insertAfter = i;
      break;
    }
  }
  if (insertAfter === -1) {
    // Test imports vi via different shape — leave it for manual handling.
    needsManual++;
    console.log("  needs manual: " + file);
    continue;
  }
  lines.splice(insertAfter + 1, 0, MOCK_BLOCK);
  writeFileSync(file, lines.join("\n"));
  patched++;
  console.log("  patched " + file);
}
console.log("---");
console.log("patched: " + patched + ", skipped: " + skipped + ", needs-manual: " + needsManual);
