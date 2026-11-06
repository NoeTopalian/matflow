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

import { describe, it, expect } from "vitest";
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

describe("2d: what every page loads", () => {
  it("instrumentation-client.ts imports neither the Sentry SDK nor zod statically", () => {
    const src = read("instrumentation-client.ts");
    expect(staticImport(src, "@sentry/nextjs")).toBe(false);
    expect(staticImport(src, "./sentry.client.config")).toBe(false);
    expect(staticImport(src, "zod")).toBe(false);
  });
  it("no client component imports the Sentry SDK statically (report through lib/sentry-client)", () => {
    const offenders = SOURCES.filter((p) => isClient(read(p)) && staticImport(read(p), "@sentry/nextjs"));
    expect(offenders).toEqual([]);
  });
  it("no client component imports zod directly (lib/zod-client sets jitless first)", () => {
    const offenders = SOURCES.filter((p) => isClient(read(p)) && staticImport(read(p), "zod"));
    expect(offenders).toEqual([]);
  });
  it("the client pages that build schemas use lib/zod-client", () => {
    for (const p of ["app/login/page.tsx", "app/apply/page.tsx"]) expect(staticImport(read(p), "@/lib/zod-client"), p).toBe(true);
  });
  it("lib/zod-client turns jitless on before handing out z", async () => {
    const { z: clientZ } = await import("@/lib/zod-client");
    expect(clientZ).toBe(z);
    expect(z.config().jitless).toBe(true);
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
