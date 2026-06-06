// Lane 1 iter-1 CSRF sweep — one-off bulk patcher. Inserts assertSameOrigin
// import + guard into the top of each mutating handler that doesn't already
// have it.
//
// Safe to re-run: the guard regex skips handlers that are already covered.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = [
  // First wave (Lane 1 iter-1).
  "app/api/settings/route.ts",
  "app/api/memberships/route.ts",
  "app/api/memberships/[id]/route.ts",
  "app/api/ranks/route.ts",
  "app/api/ranks/[id]/route.ts",
  "app/api/announcements/route.ts",
  "app/api/announcements/[id]/route.ts",
  "app/api/orders/[id]/mark-paid/route.ts",
  "app/api/members/[id]/rank/route.ts",
  "app/api/members/[id]/rank/demote/route.ts",
  "app/api/classes/route.ts",
  "app/api/classes/[id]/route.ts",
  "app/api/class-packs/route.ts",
  "app/api/class-packs/[id]/route.ts",
  // Second wave (remaining CSRF gaps from S-09, S-11, S-13, S-16, S-17, S-18, S-22).
  "app/api/initiatives/route.ts",
  "app/api/initiatives/[id]/route.ts",
  "app/api/products/[id]/route.ts",
  "app/api/members/[id]/link-child/route.ts",
  "app/api/members/[id]/unlink-child/route.ts",
  "app/api/drive/select-folder/route.ts",
  "app/api/drive/disconnect/route.ts",
  "app/api/drive/index/route.ts",
  "app/api/admin/email/test/route.ts",
  "app/api/owner/reset-onboarding/route.ts",
  "app/api/reports/generate/route.ts",
  "app/api/coach/instances/[id]/attendance/route.ts",
  "app/api/classes/[id]/instances/route.ts",
  "app/api/instances/generate/route.ts",
  "app/api/classes/[id]/roster/route.ts",
  "app/api/classes/[id]/roster/[memberId]/route.ts",
];

const IMPORT_LINE = `import { assertSameOrigin } from "@/lib/csrf";`;
const GUARD = `  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.\n  const csrfViolation = assertSameOrigin(req);\n  if (csrfViolation) return csrfViolation;\n`;

let total = 0;
let totalGuards = 0;

for (const file of files) {
  const fullPath = join(process.cwd(), file);
  let src = readFileSync(fullPath, "utf8");
  let modified = false;
  let addedGuards = 0;

  if (!src.includes(IMPORT_LINE)) {
    const lines = src.split("\n");
    let lastImportIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 60); i++) {
      if (/^import .+ from .+;\s*$/.test(lines[i])) lastImportIdx = i;
    }
    if (lastImportIdx >= 0) {
      lines.splice(lastImportIdx + 1, 0, IMPORT_LINE);
      src = lines.join("\n");
      modified = true;
    }
  }

  // Walk every `export async function POST/PATCH/DELETE/PUT(...)` and inject
  // the guard at the first body line — but only if the handler doesn't
  // already begin with an assertSameOrigin call. CRLF-tolerant: `\r?\n`.
  const handlerRegex = /(export async function (?:POST|PATCH|DELETE|PUT)\([^)]*\)\s*\{)\r?\n/g;
  src = src.replace(handlerRegex, (match, sig, idx) => {
    const after = src.slice(idx + match.length, idx + match.length + 250);
    if (after.includes("assertSameOrigin")) return match;
    addedGuards++;
    return `${sig}\n${GUARD}`;
  });

  if (addedGuards > 0) modified = true;

  if (modified) {
    writeFileSync(fullPath, src);
    total++;
    totalGuards += addedGuards;
    console.log(`  patched ${file} (+${addedGuards} guard${addedGuards === 1 ? "" : "s"})`);
  } else {
    console.log(`  skipped ${file} (already covered)`);
  }
}

console.log("---");
console.log(`Files patched: ${total}`);
console.log(`Guards added:  ${totalGuards}`);
