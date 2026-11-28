// scripts/session-cover-rollback.mjs: what it refuses before it connects to anything.
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCTION_DELETE_FLAG, parseArgs, resolveTarget } from "../../scripts/session-cover-rollback.mjs";

const TEST_HOST = "ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech";
// A host string only: nothing in this file connects to anything.
const PROD_HOST = "ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech";

describe("session-cover-rollback.mjs", () => {
  afterEach(() => {
    delete process.env.PGHOST;
  });

  it("needs an expected host and an export file; --delete is opt-in", () => {
    expect(() => parseArgs(["--export", "x.json"])).toThrow(/--expect-host/);
    expect(() => parseArgs(["--expect-host", "ep-hidden-salad"])).toThrow(/--export/);
    expect(parseArgs(["--expect-host", "ep-hidden-salad", "--export", "x.json"])).toEqual({ expectHost: "ep-hidden-salad", exportFile: "x.json", remove: false, productionDelete: false });
    expect(parseArgs(["--expect-host", "127.0.0.1", "--export", "x.json", "--delete"]).remove).toBe(true);
    expect(parseArgs(["--expect-host", "ep-bold-wave", "--export", "x.json", "--delete", PRODUCTION_DELETE_FLAG]).productionDelete).toBe(true);
  });

  it("--delete never reaches production without the extra flag; the read-only export may", () => {
    const prod = `postgresql://u:p@${PROD_HOST}/db`;
    expect(() => resolveTarget(prod, "ep-bold-wave", { remove: true })).toThrow(/production endpoint/);
    expect(() => resolveTarget(prod, "ep-bold-wave", { remove: true, productionDelete: false })).toThrow(/REFUSED/);
    expect(resolveTarget(prod, "ep-bold-wave", { remove: false })).toBe(PROD_HOST);
    expect(resolveTarget(prod, "ep-bold-wave", { remove: true, productionDelete: true })).toBe(PROD_HOST);
    // The test branch and a local rehearsal need no extra flag to delete.
    expect(resolveTarget(`postgresql://u:p@${TEST_HOST}/db`, "ep-hidden-salad", { remove: true })).toBe(TEST_HOST);
    expect(resolveTarget("postgresql://u:p@127.0.0.1:5432/db", "127.0.0.1", { remove: true })).toBe("127.0.0.1");
  });

  it("a Neon target goes through the shared allowlist", () => {
    expect(resolveTarget(`postgresql://u:p@${TEST_HOST}/db`, "ep-hidden-salad")).toBe(TEST_HOST);
    expect(() => resolveTarget(`postgresql://u:p@${TEST_HOST}/db`, "ep-bold-wave")).toThrow(/REFUSED/);
  });

  it("a loopback target must be exactly the host named, with no override", () => {
    expect(resolveTarget("postgresql://u:p@127.0.0.1:5432/db", "127.0.0.1")).toBe("127.0.0.1");
    expect(() => resolveTarget(`postgresql://u:p@${TEST_HOST}/db`, "127.0.0.1")).toThrow(/host is not 127.0.0.1/);
    expect(() => resolveTarget("postgresql://u:p@127.0.0.1:5432/db?host=elsewhere", "127.0.0.1")).toThrow(/host=/);
    process.env.PGHOST = "elsewhere";
    expect(() => resolveTarget("postgresql://u:p@127.0.0.1:5432/db", "127.0.0.1")).toThrow(/PGHOST/);
  });
});
