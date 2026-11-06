// @vitest-environment jsdom
//
// Speed quick win 2d (6 Nov 2026): the Sentry browser SDK is no longer in the
// JavaScript every page loads. lib/sentry-client.ts loads it on demand — not at
// all when the build has no NEXT_PUBLIC_SENTRY_DSN — and error boundaries
// report through it, waiting for the SDK to be initialised before capturing.
// Uncaught errors that happen while the SDK loads are held and reported once
// it is ready (startClientSentry, called by instrumentation-client.ts).

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

describe("errors before the SDK is ready (startClientSentry)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("without a DSN: no listeners, nothing loaded", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const add = vi.spyOn(window, "addEventListener");
    const { startClientSentry } = await fresh();
    startClientSentry();
    await settle();
    expect(add.mock.calls.filter(([t]) => t === "error" || t === "unhandledrejection")).toEqual([]);
    expect(h.configLoads).toBe(0);
    add.mockRestore();
  });

  it("with a DSN: an uncaught error and a rejection before init are reported after init, then the listeners go", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/1");
    const remove = vi.spyOn(window, "removeEventListener");
    const { startClientSentry, loadClientSentry } = await fresh();
    startClientSentry();
    // Both fire before the dynamic import has resolved.
    const early = new Error("early");
    window.dispatchEvent(new ErrorEvent("error", { error: early, message: "early" }));
    const reason = new Error("rejected");
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = reason;
    window.dispatchEvent(rejection);
    await loadClientSentry();
    await settle();
    expect(h.initOrder).toEqual(["init", "capture", "capture"]);
    expect(h.captureException).toHaveBeenNthCalledWith(1, early);
    expect(h.captureException).toHaveBeenNthCalledWith(2, reason);
    // After hand-over Sentry's own global handlers own uncaught errors; ours are removed.
    expect(remove.mock.calls.map(([t]) => t)).toEqual(expect.arrayContaining(["error", "unhandledrejection"]));
    expect(h.captureException).toHaveBeenCalledTimes(2);
    remove.mockRestore();
  });

  it("holds at most EARLY_ERROR_LIMIT errors", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://key@o1.ingest.de.sentry.io/1");
    const { startClientSentry, loadClientSentry, EARLY_ERROR_LIMIT } = await fresh();
    startClientSentry();
    for (let i = 0; i < EARLY_ERROR_LIMIT + 5; i++) {
      window.dispatchEvent(new ErrorEvent("error", { error: new Error(`e${i}`), message: `e${i}` }));
    }
    await loadClientSentry();
    await settle();
    expect(h.captureException).toHaveBeenCalledTimes(EARLY_ERROR_LIMIT);
  });
});
