// Speed quick wins 2a, 2d and 2e (6 Nov 2026), held in place.
//
// 2a: app/template.tsx wrapped every route in a client component that started
// at opacity 0 and only faded in after React had loaded (two animation frames
// after hydration), so the server-rendered page was invisible for as long as
// the JavaScript took — and, keyed on the pathname, it remounted the whole
// tree, staff shell included, on every navigation. The browser journey
// first-paint-visible proves the visible first view; this pins that nothing
// reintroduces the wrapper.
// 2d: Sentry and zod were in the JavaScript every page loads.
// 2e: an app-wide SessionProvider fetched the session on every load and every
// return to the tab.

import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

const ROOT = process.cwd();

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const SOURCES = [...files("app"), ...files("components"), ...files("lib")];
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** A "use client" directive as the file's first statement (comments allowed above it). */
function isClient(src: string): boolean {
  let s = src;
  for (;;) {
    s = s.trimStart();
    if (s.startsWith("//")) s = s.slice(s.indexOf("\n") === -1 ? s.length : s.indexOf("\n"));
    else if (s.startsWith("/*")) s = s.slice(s.indexOf("*/") === -1 ? s.length : s.indexOf("*/") + 2);
    else return s.startsWith('"use client"') || s.startsWith("'use client'");
  }
}
/** A "use server" file is a reference from the client, not bundled into it. */
const isServerActions = (src: string) => /^\s*["']use server["']/.test(src.replace(/^(\s*\/\/[^\n]*\n)*/, ""));

/** Every app/components/lib module reachable from a "use client" file by static, non-type imports. */
let graph: Set<string> | null = null;
function clientGraph(): Set<string> {
  if (graph) return graph;
  const resolve = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith(".")) base = join(from, "..", spec).replace(/\\/g, "/");
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (/\.(ts|tsx)$/.test(c) && existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()) return c;
    }
    return null;
  };
  const seen = new Set<string>();
  const queue = SOURCES.map((p) => p.replace(/\\/g, "/")).filter((p) => isClient(read(p)));
  while (queue.length) {
    const p = queue.pop()!;
    if (seen.has(p)) continue;
    const src = read(p);
    if (isServerActions(src)) continue;
    seen.add(p);
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g)) {
      const r = resolve(p, m[1]);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return (graph = seen);
}

/** A value import of zod or any zod subpath (zod/v4, zod/mini, …); `import type` is erased and allowed. */
const importsZod = (src: string) =>
  /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*["']zod(?:\/[^"']*)?["']/m.test(src) ||
  /^\s*import\s*["']zod(?:\/[^"']*)?["']/m.test(src);

const staticImport = (src: string, mod: string) =>
  new RegExp(`^\\s*import\\s[^;]*?from\\s*["']${mod.replace(/[/.]/g, "\\$&")}["']`, "m").test(src) ||
  new RegExp(`^\\s*import\\s*["']${mod.replace(/[/.]/g, "\\$&")}["']`, "m").test(src);

describe("2a: no route wrapper hides the server-rendered page", () => {
  it("there is no root template", () => {
    expect(existsSync(join(ROOT, "app/template.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "app/template.js"))).toBe(false);
  });
  it("no source renders the old page-transition wrapper", () => {
    expect(SOURCES.filter((p) => read(p).includes("data-page-transition"))).toEqual([]);
  });
});

describe("2a: the page swap is a CSS fade that never hides the page", () => {
  const css = read("app/globals.css").replace(/\r\n/g, "\n");
  const keyframes = css.match(/@keyframes page-fade\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";

  it("starts visible: the first frame is at least 0.5 opaque, and it ends at 1", () => {
    const from = Number(keyframes.match(/from\s*\{\s*opacity:\s*([\d.]+)/)?.[1]);
    const to = Number(keyframes.match(/to\s*\{\s*opacity:\s*([\d.]+)/)?.[1]);
    expect(from).toBeGreaterThanOrEqual(0.5);
    expect(to).toBe(1);
  });

  it("animates opacity only, with the motion tokens, and holds nothing after it ends", () => {
    expect(keyframes).not.toMatch(/transform|visibility|display/);
    const rule = css.match(/\n\.page-fade > \* \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/animation:\s*page-fade var\(--dur-[a-z]+\) var\(--ease-[a-z-]+\);/);
    // No fill-mode: once it ends nothing keeps an opacity (or a stacking context) on the page.
    expect(rule).not.toMatch(/\b(both|forwards|backwards)\b/);
  });

  it("is off under prefers-reduced-motion", () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
    expect(reduced).toMatch(/\.page-fade > \*[^{]*\{\s*animation:\s*none;/);
  });

  it("sits on the content wrappers only, so it replays per page and never on the persistent shell", () => {
    expect(read("app/dashboard/layout.tsx")).toMatch(/className="dash-content page-fade /);
    expect(read("app/member/layout.tsx")).toMatch(/className="page-fade /);
    expect(SOURCES.filter((p) => /\bpage-fade\b/.test(read(p))).map((p) => p.replace(/\\/g, "/")).sort()).toEqual(["app/dashboard/layout.tsx", "app/member/layout.tsx"]);
  });
});

describe("2d: what every page loads", () => {
  it("instrumentation-client.ts imports neither the Sentry SDK nor zod statically", () => {
    const src = read("instrumentation-client.ts");
    expect(staticImport(src, "@sentry/nextjs")).toBe(false);
    expect(staticImport(src, "./sentry.client.config")).toBe(false);
    expect(importsZod(src)).toBe(false);
  });
  it("nothing bundled for the browser imports zod directly (lib/zod-client sets jitless first)", () => {
    const offenders = [...clientGraph()].filter((p) => p !== "lib/zod-client.ts" && importsZod(read(p)));
    expect(offenders).toEqual([]);
  });
  it("nothing bundled for the browser imports the Sentry SDK statically", () => {
    expect([...clientGraph()].filter((p) => staticImport(read(p), "@sentry/nextjs"))).toEqual([]);
  });
  it("the zod check covers subpaths and ignores type-only imports", () => {
    expect(importsZod('import { z } from "zod";')).toBe(true);
    expect(importsZod('import { z } from "zod/v4";')).toBe(true);
    expect(importsZod('import * as z from "zod/mini";')).toBe(true);
    expect(importsZod('export { z } from "zod";')).toBe(true);
    expect(importsZod('import type { ZodType } from "zod";')).toBe(false);
    expect(importsZod('import { z } from "@/lib/zod-client";')).toBe(false);
  });
  it("the graph walk sees the modules it must (sanity)", () => {
    const g = clientGraph();
    for (const p of ["app/login/page.tsx", "lib/zod-client.ts", "lib/class-category.ts", "lib/billing-cycle.ts", "components/SegmentErrorBoundary.tsx", "lib/sentry-client.ts"]) expect(g.has(p), p).toBe(true);
  });
  it("the client pages that build schemas use lib/zod-client", () => {
    for (const p of ["app/login/page.tsx", "app/apply/page.tsx"]) expect(staticImport(read(p), "@/lib/zod-client"), p).toBe(true);
  });
  it("lib/zod-client turns jitless on in the browser and leaves the server's JIT alone", async () => {
    const before = z.config().jitless;
    try {
      vi.resetModules();
      const { z: serverZ } = await import("@/lib/zod-client");
      expect(serverZ).toBe(z);
      expect(z.config().jitless).toBe(before);
      vi.resetModules();
      vi.stubGlobal("window", {});
      await import("@/lib/zod-client");
      expect(z.config().jitless).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      z.config({ jitless: before });
    }
  });
});

describe("2e: the session provider is scoped to its two readers", () => {
  it("the root layout has no SessionProvider", () => {
    const src = read("app/layout.tsx");
    expect(staticImport(src, "next-auth/react")).toBe(false);
    expect(src).not.toMatch(/<SessionProvider/);
  });
  it("useSession() is called only where a provider is supplied", () => {
    const readers = SOURCES.filter((p) => /=\s*useSession\(/.test(read(p))).map((p) => relative(ROOT, join(ROOT, p)).replace(/\\/g, "/"));
    expect(readers.sort()).toEqual(["app/login/totp/setup/ForcedTotpSetup.tsx", "components/dashboard/ImportPanel.tsx"]);
    // ImportPanel wraps itself; ForcedTotpSetup's server page passes the session it already read.
    expect(read("components/dashboard/ImportPanel.tsx")).toMatch(/<SessionProvider refetchOnWindowFocus=\{false\}>/);
    expect(read("app/login/totp/setup/page.tsx")).toMatch(/<SessionProvider session=\{session\} refetchOnWindowFocus=\{false\}>/);
  });
});
