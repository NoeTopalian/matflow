// Speed quick win 2d (6 Nov 2026): the Sentry browser SDK is no longer in the
// JavaScript every page loads. lib/sentry-client.ts loads it on demand — not at
// all when the build has no NEXT_PUBLIC_SENTRY_DSN — and error boundaries
// report through it, waiting for the SDK to be initialised before capturing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  configLoads: 0,
  initOrder: [] as string[],
  scope: { setTag: vi.fn(), setLevel: vi.fn() },
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: (s: typeof h.scope) => void) => fn(h.scope),
  captureException: (e: unknown) => {
    h.initOrder.push("capture");
    h.captureException(e);
  },
}));

async function fresh() {
  vi.resetModules();
  // Registered per fresh module graph, so each test counts its own loads.
  vi.doMock("@/sentry.client.config", () => {
    h.configLoads += 1;
    h.initOrder.push("init");
    return {};
  });
  return import("@/lib/sentry-client");
}

beforeEach(() => {
  h.configLoads = 0;
  h.initOrder = [];
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("without a DSN", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", ""));

  it("loads nothing and reports nothing", async () => {
    const { loadClientSentry, reportClientError } = await fresh();
    expect(await loadClientSentry()).toBeNull();
    reportClientError(new Error("x"), { reference: "MF-REF" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.configLoads).toBe(0);
    expect(h.captureException).not.toHaveBeenCalled();
  });
});

describe("with a DSN", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/1"));

  it("initialises once, then captures with the reference tag", async () => {
    const { loadClientSentry, reportClientError } = await fresh();
    const boom = new Error("boom");
    reportClientError(boom, { reference: "MF-REF" });
    await loadClientSentry();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.configLoads).toBe(1);
    expect(h.initOrder).toEqual(["init", "capture"]);
    expect(h.captureException).toHaveBeenCalledWith(boom);
    expect(h.scope.setTag).toHaveBeenCalledWith("error_reference", "MF-REF");
    expect(h.scope.setLevel).not.toHaveBeenCalled();
  });

  it("global-error's fatal level is carried", async () => {
    const { reportClientError, loadClientSentry } = await fresh();
    reportClientError(new Error("root"), { reference: null, level: "fatal" });
    await loadClientSentry();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.scope.setLevel).toHaveBeenCalledWith("fatal");
    expect(h.scope.setTag).not.toHaveBeenCalled();
  });

  it("many reports, one load", async () => {
    const { reportClientError, loadClientSentry } = await fresh();
    reportClientError(new Error("a"), { reference: null });
    reportClientError(new Error("b"), { reference: null });
    await loadClientSentry();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.configLoads).toBe(1);
    expect(h.captureException).toHaveBeenCalledTimes(2);
  });
});
