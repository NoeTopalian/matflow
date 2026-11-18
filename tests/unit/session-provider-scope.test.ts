// Round 8 (15 Nov 2026): the next-auth SessionProvider is mounted only where the session is read client-side.
// App-wide, it fetched /api/auth/session twice on every page load and again on every tab focus. A useSession()
// caller without a provider crashes in production (next-auth 5 beta returns no context there instead of throwing),
// so every file that calls useSession must mount its own provider.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : files(p);
    return /\.(tsx|ts)$/.test(name) ? [p] : [];
  });
}
const source = [...files(path.join(ROOT, "app")), ...files(path.join(ROOT, "components")), ...files(path.join(ROOT, "lib"))];

describe("session provider scope", () => {
  it("the root layout mounts no SessionProvider", () => {
    const layout = readFileSync(path.join(ROOT, "app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/<SessionProvider[\s>]/);
    expect(layout).not.toMatch(/from "next-auth\/react"/);
  });

  it("every useSession() caller mounts its own SessionProvider", () => {
    const callers = source.filter((f) => /\buseSession\(/.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort()).toEqual([
      "components/dashboard/ImportPanel.tsx",
    ]);
    for (const f of callers) expect(readFileSync(f, "utf8"), f).toMatch(/<SessionProvider[\s>]/);
  });
});
