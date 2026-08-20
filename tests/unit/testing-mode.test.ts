import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isTestingMode } from "@/lib/testing-mode";

describe("isTestingMode — 2FA bypass flag", () => {
  beforeEach(() => {
    vi.stubEnv("TESTING_MODE", "");
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when TESTING_MODE=true and NODE_ENV !== 'production'", () => {
    vi.stubEnv("TESTING_MODE", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect(isTestingMode()).toBe(true);
  });

  it("returns true when TESTING_MODE=true and NODE_ENV === 'test'", () => {
    vi.stubEnv("TESTING_MODE", "true");
    vi.stubEnv("NODE_ENV", "test");
    expect(isTestingMode()).toBe(true);
  });

  it("honours TESTING_MODE=true even in production (warning logged at module load — see auth.ts)", () => {
    vi.stubEnv("TESTING_MODE", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(isTestingMode()).toBe(true);
  });

  it("returns false when TESTING_MODE is unset", () => {
    expect(isTestingMode()).toBe(false);
  });

  it("returns false when TESTING_MODE='false'", () => {
    vi.stubEnv("TESTING_MODE", "false");
    expect(isTestingMode()).toBe(false);
  });

  it("returns false when TESTING_MODE has any value other than 'true' (case-sensitive)", () => {
    vi.stubEnv("TESTING_MODE", "TRUE");
    expect(isTestingMode()).toBe(false);
    vi.stubEnv("TESTING_MODE", "1");
    expect(isTestingMode()).toBe(false);
    vi.stubEnv("TESTING_MODE", "yes");
    expect(isTestingMode()).toBe(false);
  });
});

describe("isTestingMode — refuses the production DATABASE, whatever the environment is called", () => {
  const PROD = "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.eu-west-2.aws.neon.tech/neondb";
  const TEST = "postgresql://u:p@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb";

  beforeEach(() => {
    vi.stubEnv("TESTING_MODE", "true");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses when a PREVIEW deployment is pointed at the production database", () => {
    // The dangerous shape: VERCEL_ENV=preview legitimately honours TESTING_MODE,
    // so a preview whose DATABASE_URL is scoped to the production branch would
    // be a 2FA-free door into real member data on a URL nobody treats as
    // production. Environment names are convention; the connection string is
    // the fact.
    vi.stubEnv("DATABASE_URL", PROD);
    expect(isTestingMode()).toBe(false);
  });

  it("still honours a preview pointed at the test branch", () => {
    vi.stubEnv("DATABASE_URL", TEST);
    expect(isTestingMode()).toBe(true);
  });

  it("refuses on VERCEL_ENV=production regardless of the database", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DATABASE_URL", TEST);
    expect(isTestingMode()).toBe(false);
  });

  it("is unaffected when DATABASE_URL is unset (local dev)", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(isTestingMode()).toBe(true);
  });
});
