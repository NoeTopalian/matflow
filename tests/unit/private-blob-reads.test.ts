/**
 * Static guard: nothing fetches a Vercel Blob through `head().downloadUrl`.
 *
 * `downloadUrl` carries NO credential — @vercel/blob builds it as the plain
 * blob URL with `?download=1` appended, while its own reader `get()` sends
 * `authorization: Bearer <BLOB_READ_WRITE_TOKEN>`. Every blob this app writes
 * is `access: "private"` (app/api/upload, app/api/admin/import/upload,
 * lib/waiver-signature-upload), so `fetch(head(url).downloadUrl)` is a
 * guaranteed 403 dressed up as a working read.
 *
 * app/api/blob-image/route.ts learned that the hard way (every avatar in the
 * product rendered blank). Three more call sites were still written the old
 * way in 2026-09 — the membership-import preview, the import commit and the
 * waiver signature proxy — so the whole of the import feature and every
 * rendered signature 403'd. This test is the ratchet that stops the pattern
 * coming back anywhere, in a form that does not need a live Blob store.
 *
 * Comments are stripped before matching: prose ABOUT the defect (this file,
 * the route docblocks, blob-image's own explanation) is not the defect.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components", "lib"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "generated",
  "playwright-report",
  "test-results",
  ".worktrees",
]);
const SOURCE_EXTS = new Set([".ts", ".tsx"]);

/** The three routes this ratchet was written for. */
const PRIVATE_BLOB_READERS = [
  "app/api/blob-image/route.ts",
  "app/api/admin/import/[id]/preview/route.ts",
  "app/api/admin/import/[id]/commit/route.ts",
  "app/api/waiver/[signedWaiverId]/signature/route.ts",
];

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXTS.has(name.slice(dot))) out.push(full);
    }
  }
}

function collectSourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of SCAN_DIRS) walk(join(ROOT, entry), files);
  return files;
}

// Line comments come off FIRST, deliberately. The other order corrupts this
// very scan: app/api/blob-image/route.ts explains itself in a line comment
// containing the content-type glob "image" + slash + star, and a block-comment
// pass run first reads that as an opening delimiter and swallows everything up
// to the next block terminator — the file's imports included. Strip the line
// comments first and the false delimiter goes with them.
function stripComments(src: string): string {
  return src.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

const toRelPosix = (abs: string) => abs.slice(ROOT.length + 1).replace(/\\/g, "/");

describe("private blob reads", () => {
  it("no source file reads a blob's downloadUrl", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles()) {
      if (/\bdownloadUrl\b/.test(stripComments(readFileSync(file, "utf8")))) {
        offenders.push(toRelPosix(file));
      }
    }
    expect(
      offenders,
      "downloadUrl carries no credential — read private blobs with get(url, { access: 'private' })",
    ).toEqual([]);
  });

  it("every private-blob reader uses get(url, { access: \"private\" })", () => {
    for (const rel of PRIVATE_BLOB_READERS) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect(src, `${rel} should import get from @vercel/blob`).toMatch(
        /import\s*\{[^}]*\bget\b[^}]*\}\s*from\s*["']@vercel\/blob["']/,
      );
      expect(src, `${rel} should call get() with access: "private"`).toMatch(
        /get\(\s*[^)]*access:\s*["']private["']/,
      );
    }
  });
});
