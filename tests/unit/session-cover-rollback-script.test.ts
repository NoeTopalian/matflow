// scripts/session-cover-rollback.mjs: what it refuses before it connects to anything.
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, resolveTarget } from "../../scripts/session-cover-rollback.mjs";

const TEST_HOST = "ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech";

describe("session-cover-rollback.mjs", () => {
  afterEach(() => {
    delete process.env.PGHOST;
  });

  it("needs an expected host and an export file; --delete is opt-in", () => {
    expect(() => parseArgs(["--export", "x.json"])).toThrow(/--expect-host/);
    expect(() => parseArgs(["--expect-host", "ep-hidden-salad"])).toThrow(/--export/);
    expect(parseArgs(["--expect-host", "ep-hidden-salad", "--export", "x.json"])).toEqual({ expectHost: "ep-hidden-salad", exportFile: "x.json", remove: false });
    expect(parseArgs(["--expect-host", "127.0.0.1", "--export", "x.json", "--delete"]).remove).toBe(true);
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
