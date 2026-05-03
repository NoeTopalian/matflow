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
