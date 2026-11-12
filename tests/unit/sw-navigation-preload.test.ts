// Speed quick win 2g (6 Nov 2026): public/sw.js — the service worker the
// production build registers — enables navigation preload, answers navigations
// with the preloaded response, and on activate deletes static caches from
// earlier versions. The worker is loaded as it ships (the file itself, run with
// a stand-in `self`), not re-implemented here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Listener = (event: Record<string, unknown>) => void;

function loadWorker() {
  const listeners: Record<string, Listener> = {};
  const deleted: string[] = [];
  const cacheNames = ["matflow-static-v1", "matflow-static-v2", "someone-elses-cache"];
  const enable = vi.fn(async () => {});
  const self = {
    location: { origin: "https://app.example.test" },
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    registration: { navigationPreload: { enable } },
  };
  const caches = {
    keys: vi.fn(async () => cacheNames),
    delete: vi.fn(async (name: string) => { deleted.push(name); return true; }),
    open: vi.fn(),
  };
  const fetchMock = vi.fn();
  const src = fs.readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", "Response", "URL", src)(self, caches, fetchMock, Response, URL);
  return { listeners, deleted, enable, fetchMock, self };
}

async function activate(w: ReturnType<typeof loadWorker>) {
  let done: Promise<unknown> = Promise.resolve();
  w.listeners.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
  await done;
}

function navigate(w: ReturnType<typeof loadWorker>, preloadResponse: Promise<unknown>) {
  let answer: Promise<Response> | null = null;
  w.listeners.fetch({
    request: { url: "https://app.example.test/dashboard", method: "GET", mode: "navigate" },
    preloadResponse,
    respondWith: (p: Promise<Response>) => { answer = p; },
  });
  return answer as Promise<Response> | null;
}

describe("public/sw.js activate", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => { w = loadWorker(); });

  it("enables navigation preload", async () => {
    await activate(w);
    expect(w.enable).toHaveBeenCalledTimes(1);
  });

  it("deletes earlier MatFlow static caches and keeps the current one and anyone else's", async () => {
    await activate(w);
    expect(w.deleted).toEqual(["matflow-static-v1"]);
  });

  it("still claims open pages", async () => {
    await activate(w);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it("a browser without navigation preload still activates", async () => {
    (w.self.registration as { navigationPreload?: unknown }).navigationPreload = undefined;
    await activate(w);
    expect(w.deleted).toEqual(["matflow-static-v1"]);
  });
});

describe("public/sw.js navigations", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => { w = loadWorker(); });

  it("answers with the preloaded response and makes no second request", async () => {
    const preloaded = new Response("<p>preloaded</p>", { status: 200 });
    const res = await navigate(w, Promise.resolve(preloaded));
    expect(res).toBe(preloaded);
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the network when there is no preload", async () => {
    const net = new Response("<p>network</p>", { status: 200 });
    w.fetchMock.mockResolvedValue(net);
    const res = await navigate(w, Promise.resolve(undefined));
    expect(res).toBe(net);
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("offline: the preload fails and the offline page is served", async () => {
    w.fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await navigate(w, Promise.reject(new TypeError("Failed to fetch")));
    expect(res?.status).toBe(503);
    expect(await res?.text()).toContain("You're offline");
  });

  it("non-navigation API requests are left to the browser", () => {
    let answered = false;
    w.listeners.fetch({
      request: { url: "https://app.example.test/api/members", method: "GET", mode: "cors" },
      preloadResponse: Promise.resolve(undefined),
      respondWith: () => { answered = true; },
    });
    expect(answered).toBe(false);
  });
});
