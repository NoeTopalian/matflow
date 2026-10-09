import { describe, it, expect } from "vitest";
import { resolveDbTarget, TargetRefused, PRODUCTION_ENDPOINT_ID } from "../../scripts/readiness/db-target.mjs";

/**
 * Review of lane F (R, 9 Oct 2026): a host guard that reads `new URL(url).hostname` let three forms through
 * while pg still targeted production. The shared guard refuses each of them and compares case-insensitively.
 */
const TEST = "ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech";
const PROD = `${PRODUCTION_ENDPOINT_ID}-pooler.eu-west-2.aws.neon.tech`;
const url = (host: string, qs = "") => `postgresql://u:p@${host}/neondb?sslmode=require${qs}`;

describe("resolveDbTarget", () => {
  it("accepts the TEST branch and returns the normalised host", () => {
    expect(resolveDbTarget(url(TEST), { expectHost: "ep-hidden-salad" })).toBe(TEST);
    expect(resolveDbTarget(url(TEST.toUpperCase()), { expectHost: "EP-HIDDEN-SALAD" })).toBe(TEST);
  });

  it("refuses production unless explicitly allowed, including an UPPER-CASE host", () => {
    expect(() => resolveDbTarget(url(PROD), { expectHost: "ep-" })).toThrow(TargetRefused);
    expect(() => resolveDbTarget(url(PROD.toUpperCase()), { expectHost: "ep-" })).toThrow(/production/);
    expect(resolveDbTarget(url(PROD), { expectHost: "ep-bold-wave", allowProduction: true })).toBe(PROD);
  });

  it("refuses the three override forms outright", () => {
    expect(() => resolveDbTarget(url(TEST, `&host=${PROD}`), { expectHost: "ep-hidden-salad" })).toThrow(/host= parameter/);
    expect(() => resolveDbTarget(url(TEST, `&hostaddr=10.0.0.1`), { expectHost: "ep-hidden-salad" })).toThrow(/hostaddr= parameter/);
    expect(() => resolveDbTarget(url(TEST, `&options=endpoint%3D${PRODUCTION_ENDPOINT_ID}`), { expectHost: "ep-hidden-salad" })).toThrow(/options= parameter/);
  });

  it("refuses a host that does not contain the expected substring, and garbage", () => {
    expect(() => resolveDbTarget(url(TEST), { expectHost: "ep-bold-wave" })).toThrow(/does not contain/);
    expect(() => resolveDbTarget("", { expectHost: "x" })).toThrow(TargetRefused);
    expect(() => resolveDbTarget("not a url", { expectHost: "x" })).toThrow(TargetRefused);
  });

  it("refuses PGOPTIONS / PGHOST / PGHOSTADDR in the environment (pg would apply them) — lane F2", () => {
    for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR"]) {
      process.env[k] = k === "PGOPTIONS" ? `endpoint=${PRODUCTION_ENDPOINT_ID}` : "elsewhere";
      try {
        expect(() => resolveDbTarget(url(TEST), { expectHost: "ep-hidden-salad" })).toThrow(new RegExp(k));
      } finally {
        delete process.env[k];
      }
    }
    expect(resolveDbTarget(url(TEST), { expectHost: "ep-hidden-salad" })).toBe(TEST);
  });
});
