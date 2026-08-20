/**
 * Static guard: every browser call site that posts an image to /api/upload
 * must shrink it first through lib/downscale-image.ts.
 *
 * Why a tripwire rather than trust: the route's ingress cap sat at 2MB while
 * a phone photo is 3–12MB, so every mobile upload was refused — and the fix
 * only works if it is applied at ALL of them. The brief for this fix named
 * five call sites; there were eight. A ninth added later without the helper
 * would reintroduce the bug on exactly one surface, which is the hardest
 * kind to notice.
 *
 * Known blind spot, stated rather than papered over: this proves the module
 * is imported and called in each file, not that it is called on the specific
 * File that reaches FormData. A call site could import it and still post the
 * original. Reading the diff is still required; this only stops a NEW surface
 * appearing with no downscaling at all.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "generated",
  "playwright-report",
  "test-results",
  ".worktrees",
]);

/**
 * A POST of an image to the upload route. `/api/upload/delete-orphan` is
 * excluded deliberately — it posts JSON, not a file.
 */
const UPLOAD_FETCH = /fetch\(\s*["'`]\/api\/upload(\?[^"'`]*)?["'`]/;

/**
 * The files carrying a call site — six files, seven call sites, because
 * MemberProfile.tsx has two. Adding one is a deliberate act.
 *
 * app/member/profile/page.tsx left this list when its hand-rolled copy of the
 * upload flow was deleted in favour of <AvatarUploader>. Losing a call site is
 * the right direction: it is one fewer place that can drift out of step with
 * the pipeline, and that copy already had — it rendered the raw private blob
 * URL and skipped the orphan-blob cleanup on a failed PUT.
 */
const EXPECTED_CALL_SITES = [
  "components/dashboard/AnnouncementsView.tsx",
  "components/dashboard/MemberProfile.tsx",
  "components/dashboard/SettingsPage.tsx",
  "components/member/KidPhotosAndWaiver.tsx",
  "components/onboarding/OwnerOnboardingWizard.tsx",
  "components/ui/AvatarUploader.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const callSites = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => UPLOAD_FETCH.test(readFileSync(f, "utf8")))
  .map((f) => relative(ROOT, f).split(sep).join("/"))
  .sort();

describe("/api/upload call sites", () => {
  it("is the known set — a new one must be added here deliberately", () => {
    expect(callSites).toEqual(EXPECTED_CALL_SITES);
  });

  it.each(EXPECTED_CALL_SITES)("%s downscales in the browser first", (rel) => {
    const src = readFileSync(join(ROOT, rel), "utf8");
    expect(src).toContain('from "@/lib/downscale-image"');
    expect(src).toMatch(/downscaleImage\(/);
  });
});
