// The CSP must allow the Sentry region the project actually lives in.
//
// Sentry puts the DATA REGION in the ingest hostname as its own label:
//
//   EU     o4512090970587136.ingest.de.sentry.io
//   US     o4512090970587136.ingest.us.sentry.io
//   legacy o4512090970587136.ingest.sentry.io
//
// A CSP host wildcard only matches the labels BEFORE the literal suffix, so
// `https://*.ingest.sentry.io` does NOT permit an EU host — `de` sits between
// `ingest` and `sentry.io`, so the host does not end with `.ingest.sentry.io`.
//
// The MatFlow project is on the EU region. Before this, connect-src listed only
// the legacy and US forms, so the browser would have blocked every event while
// the DSN sat correctly configured in Vercel: Sentry present, wired, deployed —
// and permanently silent. Exactly the shape of "a webhook endpoint with no
// signing secret": everything looks set up and nothing is delivered.
//
// Silent-and-looks-fine is the failure mode this codebase keeps producing, so
// it gets a test rather than a comment.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** The connect-src line from the real CSP, as shipped. */
function connectSrc(): string {
  const config = readFileSync("next.config.ts", "utf8");
  const line = config.split("\n").find((l) => l.includes("connect-src"));
  if (!line) throw new Error("no connect-src directive found in next.config.ts");
  return line;
}

/**
 * CSP host-source matching, for the part that matters here: `*.a.b` permits a
 * host only when that host ENDS WITH `.a.b`.
 */
function cspAllowsHost(directive: string, host: string): boolean {
  const sources = directive.match(/https:\/\/[^\s'`]+/g) ?? [];
  return sources.some((src) => {
    const pattern = src.replace(/^https:\/\//, "");
    if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

describe("CSP connect-src and Sentry", () => {
  it("allows the EU ingest host this project actually uses", () => {
    expect(
      cspAllowsHost(connectSrc(), "o4512090970587136.ingest.de.sentry.io"),
      "the EU Sentry host is blocked — events are dropped by the browser and Sentry stays silent while looking configured",
    ).toBe(true);
  });

  it("allows the US and legacy hosts too, so moving region cannot re-break it", () => {
    const directive = connectSrc();
    expect(cspAllowsHost(directive, "o123.ingest.us.sentry.io")).toBe(true);
    expect(cspAllowsHost(directive, "o123.ingest.sentry.io")).toBe(true);
  });

  it("proves the wildcard really is region-specific, not a formality", () => {
    // If this were false, the test above would pass for the wrong reason and
    // the original bug would have been invisible.
    expect(
      cspAllowsHost("https://*.ingest.sentry.io", "o123.ingest.de.sentry.io"),
      "a bare *.ingest.sentry.io must NOT match an EU host, or there was never anything to fix",
    ).toBe(false);
  });

  it("still refuses somewhere else entirely", () => {
    expect(cspAllowsHost(connectSrc(), "evil.example.com")).toBe(false);
    expect(cspAllowsHost(connectSrc(), "ingest.de.sentry.io.evil.com")).toBe(false);
  });
});
