// Security campaign iteration 2, lane B — the TEST-only target guard used by the SF-62 harness, the proposal
// validator, the stale-bypass DB test and the two role/RLS scripts. Synthetic URLs only; nothing connects.
import { describe, it, expect, afterEach } from "vitest";
import { vetTestUrl, directTestUrl, TEST_HOST_RE } from "../../scripts/readiness/rls-test-target.mjs";

const TEST_POOLED = "postgresql://matflow_app:x@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const TEST_DIRECT = "postgresql://matflow_app:x@ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const PROD = "postgresql://neondb_owner:x@ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";

describe("rls-test-target guard", () => {
  afterEach(() => { delete process.env.PGOPTIONS; delete process.env.PGHOST; });

  it("accepts the TEST endpoint (pooled and direct) and returns an explicit config with no URL parameters", () => {
    const p = vetTestUrl(TEST_POOLED, { expectUser: "matflow_app" });
    expect(p.host).toBe("ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech");
    expect(p).not.toHaveProperty("connectionString");
    expect(p).not.toHaveProperty("options");
    expect(p.ssl).toEqual({ rejectUnauthorized: true, servername: p.host });
    expect(vetTestUrl(TEST_POOLED, { direct: true }).host).toBe("ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech");
    expect(vetTestUrl(TEST_DIRECT).host).toBe("ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech");
    expect(new URL(directTestUrl(TEST_POOLED)).hostname).toBe("ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech");
  });

  it.each([
    ["production", PROD],
    ["production, upper-case host", PROD.replace("ep-bold-wave-abt39t7x", "EP-BOLD-WAVE-ABT39T7X")],
    ["TEST host with ?host= pointing at production", `${TEST_POOLED}&host=ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech`],
    ["TEST host with ?options=endpoint=production", `${TEST_POOLED}&options=endpoint%3Dep-bold-wave-abt39t7x`],
    ["TEST host with ?hostaddr=", `${TEST_POOLED}&hostaddr=10.0.0.1`],
    ["another Neon endpoint", TEST_POOLED.replace("ep-hidden-salad-abom7cg4", "ep-other-thing-1234")],
    ["look-alike host containing the TEST id", TEST_POOLED.replace("ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech", "ep-hidden-salad-abom7cg4.evil.example")],
    ["not a URL", "ep-hidden-salad"],
  ])("refuses %s", (_label, url) => {
    expect(() => vetTestUrl(url)).toThrow(/REFUSED|not a URL|no connection/);
  });

  it("refuses an inherited PGOPTIONS / PGHOST (node-postgres falls back to them when a field is empty)", () => {
    process.env.PGOPTIONS = "endpoint=ep-bold-wave-abt39t7x";
    expect(() => vetTestUrl(TEST_POOLED)).toThrow(/PG\* environment/);
    delete process.env.PGOPTIONS;
    process.env.PGHOST = "ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech";
    expect(() => vetTestUrl(TEST_POOLED)).toThrow(/PG\* environment/);
  });

  it("refuses the wrong login role when one is expected", () => {
    expect(() => vetTestUrl(TEST_POOLED.replace("matflow_app", "neondb_owner"), { expectUser: "matflow_app" })).toThrow(/expected login role/);
  });

  it("the allowlist pattern is anchored", () => {
    expect(TEST_HOST_RE.test("ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech")).toBe(true);
    expect(TEST_HOST_RE.test("x.ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech")).toBe(false);
    expect(TEST_HOST_RE.test("ep-hidden-salad-abom7cg4.eu-west-2.aws.neon.tech.evil")).toBe(false);
  });
});
