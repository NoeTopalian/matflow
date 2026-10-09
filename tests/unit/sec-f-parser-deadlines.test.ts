// SEC-074 regex / parser CPU exhaustion — bounded property tests with deadlines (security campaign lane F, 9 Oct 2026).
//
// Every user-facing text parser and normaliser is fed seeded adversarial input in a DOUBLING series (start small, ×2
// per step) and the series stops as soon as one step costs more than STEP_BUDGET_MS. A linear or n·log n parser walks
// the whole series to its cap; a quadratic one stalls a few steps short (×4 per step) and an exponential (ReDoS) one
// stalls at the first steps. Synchronous code cannot be cancelled from a test, so this escalation IS the cancellation
// threshold: the worst case for a quadratic parser is one step of ~4 × STEP_BUDGET_MS (the planted-quadratic control
// below proves the harness catches one). Honest limit: a truly EXPONENTIAL regex could still block one step for
// minutes at n ≈ 32 before the budget check runs; the backstops are vitest/CI job timeouts. The static scan for nested
// quantifiers (evidence/F/F-03) found one candidate in app/ and lib/, which is dot-anchored and linear.
//
// Ceilings: largest CSV input 1 MiB (the attendance upload accepts 25 MiB in chunks, the members CSV route 5 MB — the
// parser cost per byte is what is measured here, not the HTTP ceiling); largest scalar input 256 KiB; per-step budget
// 1.5 s; whole file well under 60 s. Inputs are synthetic; no I/O.
//
// Scope: lib/importers/index.ts parseCSV + parseImport (members, all sources), lib/importers/teamup.ts parseTeamUp,
// lib/importers/attendance.ts parseAttendanceCsv + parseOffsetInstant, lib/importers/sniff.ts sniffCsvKind,
// lib/email-normalise.ts emailField / normaliseEmail, lib/club-code.ts, lib/recovery-codes.ts normaliseUserCode,
// lib/error-reference.ts, lib/login-fingerprint.ts normaliseIp, lib/pagination.ts parsePagination, lib/color.ts
// readableOn, lib/blob-url.ts isVercelBlobUrl (the one nested-quantifier regex in app/ and lib/: `([a-z0-9-]+\.)*`).
// Image decoding (sharp/libvips) is lane D's measurement (tests/unit/sec-d-image-bounds.test.ts).
import { describe, it, expect } from "vitest";
import { parseCSV, parseImport } from "@/lib/importers";
import { parseTeamUp } from "@/lib/importers/teamup";
import { parseAttendanceCsv, parseOffsetInstant } from "@/lib/importers/attendance";
import { sniffCsvKind } from "@/lib/importers/sniff";
import { emailField, normaliseEmail } from "@/lib/email-normalise";
import { normaliseClubCode } from "@/lib/club-code";
import { normaliseUserCode } from "@/lib/recovery-codes";
import { normaliseErrorReference } from "@/lib/error-reference";
import { normaliseIp } from "@/lib/login-fingerprint";
import { parsePagination } from "@/lib/pagination";
import { readableOn } from "@/lib/color";
import { isVercelBlobUrl } from "@/lib/blob-url";

const STEP_BUDGET_MS = 1_500;

/** Small deterministic PRNG (mulberry32) so a failure reproduces exactly. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

/** Build an n-character string from adversarial tokens (seeded). */
function fromTokens(n: number, tokens: readonly string[], seed: number): string {
  const r = rng(seed);
  let s = "";
  while (s.length < n) s += pick(r, tokens);
  return s.slice(0, n);
}

const CSV_TOKENS = ['"', '""', ",", "\n", "\r\n", " ", "a", "é", "\t", '","', '"\n"', "=", "@", "1", ";", "\u0000"] as const;
const SCALAR_TOKENS = ["a", ".", "@", "-", " ", "+", "_", "!", "\t", "é", "0", ":", "/", "%", "\\"] as const;
const ATT_HEADER =
  "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp";
const MEMBER_HEADER = "Customer ID,First Name,Last Name,Email,Phone,Date of Birth,Status,Membership";

/**
 * Doubling series from `start` to `cap`; stops at the first step over budget. Returns the sizes reached and the
 * per-step timings so a failure message shows the growth curve.
 */
function series(label: string, start: number, cap: number, run: (n: number) => void) {
  const steps: Array<[number, number]> = [];
  for (let n = start; n <= cap; n *= 2) {
    const t0 = performance.now();
    run(n);
    const ms = performance.now() - t0;
    steps.push([n, Math.round(ms)]);
    if (ms > STEP_BUDGET_MS) break;
  }
  const reached = steps[steps.length - 1][0];
  const last = steps[steps.length - 1][1];
  expect(
    reached === cap && last <= STEP_BUDGET_MS,
    `${label}: stalled at n=${reached} (${last} ms); curve ${JSON.stringify(steps)}`,
  ).toBe(true);
  return steps;
}

const CSV_CAP = 1 << 20; // 1 MiB
const SCALAR_CAP = 1 << 18; // 256 KiB

describe("SEC-074 — CSV/import parsers stay linear on adversarial input", () => {
  for (const seed of [1, 7, 42]) {
    it(`parseCSV (seed ${seed})`, () => {
      series("parseCSV", 256, CSV_CAP, (n) => void parseCSV(fromTokens(n, CSV_TOKENS, seed)));
    });
  }

  it("parseCSV: one unterminated quote swallowing the whole file", () => {
    series("parseCSV-unterminated", 256, CSV_CAP, (n) => void parseCSV('a,"' + "x,\n".repeat(Math.ceil(n / 3))));
  });

  it("parseCSV: a single enormous line of commas (column explosion)", () => {
    series("parseCSV-commas", 256, CSV_CAP, (n) => void parseCSV(",".repeat(n)));
  });

  for (const source of ["generic", "teamup"] as const) {
    it(`parseImport(${source}) with a real-shaped header and adversarial body`, () => {
      series(`parseImport-${source}`, 256, CSV_CAP, (n) => void parseImport(source, `${MEMBER_HEADER}\n${fromTokens(n, CSV_TOKENS, 3)}`));
    });
  }

  it("parseTeamUp with adversarial body", () => {
    series("parseTeamUp", 256, CSV_CAP, (n) => void parseTeamUp(`${MEMBER_HEADER}\n${fromTokens(n, CSV_TOKENS, 5)}`));
  });

  it("parseAttendanceCsv with the TeamUp attendance header and adversarial body", () => {
    series("parseAttendanceCsv", 256, CSV_CAP, (n) => void parseAttendanceCsv(`${ATT_HEADER}\n${fromTokens(n, CSV_TOKENS, 9)}`));
  });

  it("parseAttendanceCsv with many well-formed rows (the realistic large file)", () => {
    const row = 'Synthetic Person,secf@example.test,2026-10-01T18:00:00+01:00,Gi,Main,Coach,App,,,,Web,Attended,';
    series("parseAttendanceCsv-rows", 256, CSV_CAP, (n) => void parseAttendanceCsv(`${ATT_HEADER}\n${(row + "\n").repeat(Math.ceil(n / row.length))}`));
  });

  it("sniffCsvKind on a long first line", () => {
    series("sniffCsvKind", 256, CSV_CAP, (n) => void sniffCsvKind(fromTokens(n, CSV_TOKENS, 11)));
  });
});

describe("SEC-074 — scalar normalisers and validators stay linear", () => {
  const scalarCases: Array<[string, (s: string) => unknown]> = [
    ["emailField (zod .email before .max)", (s) => emailField().safeParse(s)],
    ["normaliseEmail", (s) => normaliseEmail(s)],
    ["normaliseClubCode", (s) => normaliseClubCode(s)],
    ["normaliseUserCode", (s) => normaliseUserCode(s)],
    ["normaliseErrorReference", (s) => normaliseErrorReference(s)],
    ["normaliseIp", (s) => normaliseIp(s)],
    ["parseOffsetInstant", (s) => parseOffsetInstant(s)],
    ["readableOn", (s) => { try { return readableOn(s); } catch { return null; } }],
    ["isVercelBlobUrl", (s) => isVercelBlobUrl(`https://${s}blob.vercel-storage.com/x`)],
  ];
  for (const [label, fn] of scalarCases) {
    it(`${label}: seeded adversarial strings`, () => {
      series(label, 16, SCALAR_CAP, (n) => {
        for (const seed of [2, 3]) fn(fromTokens(n, SCALAR_TOKENS, seed));
      });
    });
    it(`${label}: classic ReDoS shapes (repeated near-matches with a failing tail)`, () => {
      series(`${label}-redos`, 16, SCALAR_CAP, (n) => {
        fn("a".repeat(n) + "!");
        fn("a.".repeat(n / 2) + "@");
        fn("a@" + "a.".repeat(n / 2) + "!");
        fn("a-".repeat(n / 2) + "-.");
        fn(" ".repeat(n) + "x");
      });
    });
  }

  it("isVercelBlobUrl: the nested quantifier is anchored by the dot (label-dot repeats)", () => {
    series("isVercelBlobUrl-labels", 64, SCALAR_CAP, (n) => void isVercelBlobUrl(`https://${"a.".repeat(n / 2)}blob.vercel-storage.com.evil/x`));
  });

  it("parsePagination: huge and hostile query strings", () => {
    series("parsePagination", 64, SCALAR_CAP, (n) => {
      parsePagination(new URLSearchParams(`take=${"9".repeat(n)}&cursor=${"a".repeat(n)}`));
      parsePagination(new URLSearchParams("take=1&".repeat(Math.ceil(n / 7))));
    });
  });
});

describe("harness control (the method detects super-linear cost)", () => {
  it("a planted quadratic scan stalls before the cap and the assertion fires", () => {
    // O(n^2): for every position, search the rest of the string for a character that is never there.
    const quadratic = (str: string) => { let hits = 0; for (let i = 0; i < str.length; i++) hits += str.indexOf("!", i) === -1 ? 0 : 1; return hits; };
    expect(() => series("planted-quadratic", 256, CSV_CAP, (n) => void quadratic("a".repeat(n)))).toThrow(/stalled at n=/);
  });
});
