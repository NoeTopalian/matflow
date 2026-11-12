// scripts/loadtest/guard.mjs: the load test refuses production and the shared test branch, and accepts only a
// pooled Neon child branch of the test branch named as such with --child-branch (same region, the test branch's own
// roles and passwords, the same Neon project on a timeline of its own). No network: the live read-only lineage
// rows are judged by checkLineage.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkTargetUrl,
  checkLineage,
  checkSharedLimits,
  assertNoProduction,
  onTargetHost,
  resolveTarget,
  endpointOf,
  GuardRefusal,
  CHILD_FLAG,
  SHARED_LIMITS,
} from "../../scripts/loadtest/guard.mjs";

const REGION = "eu-west-2.aws.neon.tech";
/** A postgres URL built field by field (no credential-shaped literal in the source). */
function pgUrl(host: string, { user = "neondb_owner", pass = "pwA", db = "neondb", proto = "postgresql" } = {}) {
  const u = new URL(`${proto}://placeholder@localhost/`);
  u.hostname = host;
  u.username = user;
  u.password = pass;
  u.pathname = `/${db}`;
  u.search = "sslmode=require&channel_binding=require";
  return u.toString();
}
const TEST_HOST = `ep-hidden-salad-a1b2c3-pooler.${REGION}`;
const CHILD_HOST = `ep-quiet-river-z9y8x7-pooler.${REGION}`;
const PROD_HOST = `ep-bold-wave-q1w2e3-pooler.${REGION}`;
const TEST = { owner: pgUrl(TEST_HOST), restricted: pgUrl(TEST_HOST, { user: "matflow_app", pass: "pwB" }), env: {} };
const CHILD = { childBranch: true };
const P1 = "88b0f5176c227dbeffa63ec8e5f95d92";
const T1 = "184ba5d287b8be8f81b346f640f9981b";
const T2 = "aaaabbbbccccddddeeeeffff00001111";

const refused = (fn: () => unknown, msg: RegExp) => {
  let err: unknown;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(GuardRefusal);
  expect(String((err as Error).message)).toMatch(/^refusing: /);
  expect(String((err as Error).message)).toMatch(msg);
  // A refusal never repeats a password.
  expect(String((err as Error).message)).not.toMatch(/pwA|pwB|pwC/);
};

describe("checkTargetUrl: production is refused, always", () => {
  it("refuses the production endpoint (pooled and direct), with or without the shared-branch flag", () => {
    for (const host of [PROD_HOST, `ep-bold-wave-q1w2e3.${REGION}`]) {
      refused(() => checkTargetUrl(pgUrl(host), TEST), /production endpoint ep-bold-wave/);
      refused(() => checkTargetUrl(pgUrl(host), TEST, { allowShared: true }), /production endpoint/);
    }
  });
  it("refuses a URL that mentions production anywhere, not only in the host", () => {
    refused(() => checkTargetUrl(`${pgUrl(CHILD_HOST)}&options=ep-bold-wave`, TEST), /production endpoint/);
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST).replace("neondb", "EP-BOLD-WAVE"), TEST), /production endpoint/);
  });
  it("refuses when the test branch settings themselves point at production", () => {
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST), { owner: pgUrl(PROD_HOST) }), /production endpoint/);
  });
});

describe("checkTargetUrl: the shared test branch", () => {
  it("is refused without --allow-shared-test-branch", () => {
    refused(() => checkTargetUrl(pgUrl(TEST_HOST), TEST), /SHARED test branch/);
    refused(() => checkTargetUrl(pgUrl(TEST_HOST, { user: "matflow_app", pass: "pwB" }), TEST), /SHARED test branch/);
  });
  it("is accepted with the flag, marked shared", () => {
    expect(checkTargetUrl(pgUrl(TEST_HOST), TEST, { allowShared: true })).toMatchObject({ shared: true, endpoint: "ep-hidden-salad-a1b2c3" });
  });
});

describe("checkTargetUrl: a child branch of the test branch", () => {
  it("accepts the pooled child URL with the test branch's owner or restricted role", () => {
    expect(checkTargetUrl(pgUrl(CHILD_HOST), TEST, CHILD)).toEqual({ endpoint: "ep-quiet-river-z9y8x7", host: CHILD_HOST, shared: false, role: "neondb_owner" });
    expect(checkTargetUrl(pgUrl(CHILD_HOST, { user: "matflow_app", pass: "pwB" }), TEST, CHILD).role).toBe("matflow_app");
    expect(checkTargetUrl(pgUrl(CHILD_HOST, { proto: "postgres" }), TEST, CHILD).shared).toBe(false);
  });
  it("is refused without --child-branch: the operator must say it is the throwaway child", () => {
    expect(CHILD_FLAG).toBe("--child-branch");
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST), TEST), /pass --child-branch/);
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST), TEST, { allowShared: true }), /pass --child-branch/);
  });
  it("refuses --child-branch on the shared test branch, and production even with both flags", () => {
    refused(() => checkTargetUrl(pgUrl(TEST_HOST), TEST, { allowShared: true, childBranch: true }), /--child-branch was given but/);
    refused(() => checkTargetUrl(pgUrl(TEST_HOST), TEST, CHILD), /SHARED test branch/);
    refused(() => checkTargetUrl(pgUrl(PROD_HOST), TEST, { childBranch: true, allowShared: true }), /production endpoint/);
  });
  it("refuses the direct (non-pooled) endpoint", () => {
    refused(() => checkTargetUrl(pgUrl(`ep-quiet-river-z9y8x7.${REGION}`), TEST, CHILD), /not the pooled endpoint/);
  });
  it("refuses anything that is not a Neon endpoint", () => {
    for (const host of ["localhost", "127.0.0.1", "db.example.test", `quiet-river.${REGION}`]) refused(() => checkTargetUrl(pgUrl(host), TEST, CHILD), /not a Neon endpoint/);
  });
  it("refuses another region", () => {
    refused(() => checkTargetUrl(pgUrl("ep-quiet-river-z9y8x7-pooler.us-east-2.aws.neon.tech"), TEST, CHILD), /region/);
  });
  it("refuses credentials that are not the test branch's own roles", () => {
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST, { pass: "pwC" }), TEST, CHILD), /password for "neondb_owner" is not the test branch's/);
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST, { user: "someone_else" }), TEST, CHILD), /not one of the test branch's roles/);
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST, { user: "matflow_app", pass: "pwA" }), TEST, CHILD), /password for "matflow_app"/);
  });
  it("refuses another database name", () => {
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST, { db: "otherdb" }), TEST, CHILD), /database \/otherdb/);
  });
  it("refuses an empty, malformed or non-postgres target", () => {
    refused(() => checkTargetUrl("", TEST), /no target URL/);
    refused(() => checkTargetUrl("not a url", TEST), /not a URL/);
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST).replace("postgresql:", "mysql:"), TEST), /not a postgres URL/);
  });
  it("refuses when .env.test is not the shared test branch", () => {
    refused(() => checkTargetUrl(pgUrl(CHILD_HOST), { owner: pgUrl(`ep-other-thing-000000-pooler.${REGION}`) }), /not the shared test branch/);
  });
});

describe("endpointOf and onTargetHost", () => {
  it("reads the endpoint id with or without -pooler", () => {
    expect(endpointOf(TEST_HOST)).toBe("ep-hidden-salad-a1b2c3");
    expect(endpointOf(`ep-hidden-salad-a1b2c3.${REGION}`)).toBe("ep-hidden-salad-a1b2c3");
    expect(endpointOf("example.com")).toBeNull();
  });
  it("moves a test-branch role onto the child host, keeping role and database", () => {
    const u = new URL(onTargetHost(TEST.restricted, pgUrl(CHILD_HOST)));
    expect(u.hostname).toBe(CHILD_HOST);
    expect(u.username).toBe("matflow_app");
    expect(u.pathname).toBe("/neondb");
  });
  it("never derives a production URL", () => {
    refused(() => onTargetHost(TEST.owner, pgUrl(PROD_HOST)), /production endpoint/);
  });
});

describe("checkLineage: read-only proof from the two connections", () => {
  const test = { project: P1, timeline: T1 };
  it("accepts a child: the test branch's Neon project, a timeline of its own", () => {
    expect(checkLineage({ project: P1, timeline: T2 }, test, { shared: false })).toEqual({ project: P1, timeline: T2, testTimeline: T1 });
  });
  it("accepts the shared test branch only on the test branch's own timeline", () => {
    expect(checkLineage(test, test, { shared: true }).timeline).toBe(T1);
    refused(() => checkLineage({ project: P1, timeline: T2 }, test, { shared: true }), /on another timeline/);
  });
  it("refuses the test branch under another host name (same timeline)", () => {
    refused(() => checkLineage({ project: P1, timeline: T1 }, test, { shared: false }), /IS the shared test branch/);
  });
  it("refuses a database in another Neon project", () => {
    refused(() => checkLineage({ project: "0".repeat(32), timeline: T2 }, test, { shared: false }), /not in the test branch's Neon project/);
  });
  it("refuses a connection that reports no Neon project or timeline", () => {
    refused(() => checkLineage({ project: null, timeline: T2 }, test, { shared: false }), /target reports no Neon/);
    refused(() => checkLineage({ project: P1, timeline: "xyz" }, test, { shared: false }), /target reports no Neon/);
    refused(() => checkLineage(undefined, test, { shared: false }), /target reports no Neon/);
    refused(() => checkLineage({ project: P1, timeline: T2 }, { project: P1, timeline: null }, { shared: false }), /test branch reports no Neon/);
  });
});

describe("assertNoProduction and checkSharedLimits", () => {
  it("names the variable that mentions production, never its value", () => {
    refused(() => assertNoProduction({ DATABASE_URL: pgUrl(PROD_HOST, { pass: "pwC" }), OTHER: "fine" }), /^refusing: DATABASE_URL mentions/);
    expect(() => assertNoProduction({ DATABASE_URL: pgUrl(CHILD_HOST), n: undefined })).not.toThrow();
  });
  it("keeps a shared-test-branch run tiny, and leaves a child branch alone", () => {
    const tiny = { shared: true, members: 20, clubs: 2, secondsPerScenario: 10, vus: 5 };
    expect(() => checkSharedLimits(tiny)).not.toThrow();
    refused(() => checkSharedLimits({ ...tiny, members: SHARED_LIMITS.maxMembers + 1 }), /at most 50 members/);
    refused(() => checkSharedLimits({ ...tiny, clubs: 10 }), /clubs/);
    refused(() => checkSharedLimits({ ...tiny, secondsPerScenario: 600 }), /s per scenario/);
    refused(() => checkSharedLimits({ ...tiny, vus: 5000 }), /virtual users/);
    expect(() => checkSharedLimits({ shared: false, members: 5000, clubs: 10, secondsPerScenario: 600, vus: 5000 })).not.toThrow();
  });
});

describe("resolveTarget: where the URL comes from", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  const envFile = (body: string | null) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lt-guard-"));
    dirs.push(d);
    const f = path.join(d, ".env.loadtest");
    if (body !== null) fs.writeFileSync(f, body);
    return f;
  };
  it("without .env.loadtest, refuses and states Noe's one step", () => {
    refused(() => resolveTarget({ envFile: envFile(null), test: TEST }), /Noe's one step: create a Neon child branch of the test branch and paste its pooled URL/);
  });
  it("without .env.loadtest but with the flag, targets the shared test branch", () => {
    expect(resolveTarget({ envFile: envFile(null), test: TEST, allowShared: true })).toMatchObject({ shared: true, appRole: "matflow_app" });
  });
  it("with the child URL, seeds as the owner and serves as the restricted role on the child host", () => {
    const t = resolveTarget({ envFile: envFile(`LOADTEST_DATABASE_URL="${pgUrl(CHILD_HOST)}"\n`), test: TEST, childBranch: true });
    expect(t.shared).toBe(false);
    expect(new URL(t.ownerUrl).hostname).toBe(CHILD_HOST);
    expect(new URL(t.appUrl).hostname).toBe(CHILD_HOST);
    expect(new URL(t.appUrl).username).toBe("matflow_app");
  });
  it("the child URL without --child-branch is refused", () => {
    refused(() => resolveTarget({ envFile: envFile(`LOADTEST_DATABASE_URL=${pgUrl(CHILD_HOST)}\n`), test: TEST }), /pass --child-branch/);
  });
  it("a production URL in .env.loadtest is refused even with both flags", () => {
    refused(() => resolveTarget({ envFile: envFile(`LOADTEST_DATABASE_URL=${pgUrl(PROD_HOST)}\n`), test: TEST, allowShared: true, childBranch: true }), /production endpoint/);
  });
  it("the shared test branch pasted into .env.loadtest is refused without the flag", () => {
    refused(() => resolveTarget({ envFile: envFile(`LOADTEST_DATABASE_URL=${pgUrl(TEST_HOST)}\n`), test: TEST }), /SHARED test branch/);
  });
});
