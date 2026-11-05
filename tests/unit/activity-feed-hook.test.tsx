// @vitest-environment jsdom
// The Activity timeline's loading rules (components/activity/useActivityFeed.ts):
// the rows on screen are always the rows for the filters on screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useActivityFeed } from "@/components/activity/useActivityFeed";
import type { ActivityResponse, FeedEntry } from "@/lib/activity-types";

const entry = (id: string): FeedEntry => ({ id, at: "2026-11-05T10:00:00.000Z", dayKey: "2026-11-05", type: "checkin", parts: [{ text: id }], plain: id, detail: null, detailPlain: null, changes: null, source: { label: "Staff", staff: null, support: false }, undone: false });
const page = (ids: string[], nextCursor: string | null = null): ActivityResponse => ({
  entries: ids.map(entry),
  nextCursor,
  enriched: true,
  clock: { timeZone: "Europe/London", todayKey: "2026-11-05", minDayKey: "2025-11-05", clamped: false },
  filters: { types: { view: "club", keys: [] }, member: null, class: null, payment: null, tier: null, staff: null, dayKey: null },
  ignoredTypes: [],
  droppedTypes: [],
});

type Pending = { url: string; signal: AbortSignal; resolve: (status: number, body: unknown) => void; reject: (e: unknown) => void };
let pending: Pending[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((resolve, reject) => {
        const signal = init!.signal!;
        const p: Pending = { url, signal, resolve: (status, body) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }), reject };
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        pending.push(p);
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const A = "/api/activity?types=club";
const B = "/api/activity?types=money";
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const answer = async (p: Pending, status: number, body: unknown) => {
  await act(async () => {
    p.resolve(status, body);
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("useActivityFeed", () => {
  it("asks nothing until it is given a request, then asks once, at once", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string | null }) => useActivityFeed(url), { initialProps: { url: null as string | null } });
    await tick(1000);
    expect(pending).toHaveLength(0);
    expect(result.current.phase).toBe("loading");
    rerender({ url: A });
    await tick(0);
    expect(pending.map((p) => p.url)).toEqual([A]);
    await answer(pending[0], 200, page(["a1", "a2"]));
    expect(result.current.phase).toBe("ready");
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("two filter changes with the first response arriving last: the rows are the second filter's", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useActivityFeed(url), { initialProps: { url: A } });
    await tick(0);
    const first = pending[0];
    rerender({ url: B });
    // Still showing nothing of A; B is asked for after the pause.
    await tick(250);
    expect(pending.map((p) => p.url)).toEqual([A, B]);
    expect(first.signal.aborted).toBe(true);
    await answer(pending[1], 200, page(["b1"]));
    // A's answer turns up late (as if the abort had not reached it).
    await answer(first, 200, page(["a1"]));
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["b1"]);
    expect(result.current.phase).toBe("ready");
  });

  it("keeps the previous rows, marked as refreshing, while new filters load — never an empty list", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useActivityFeed(url), { initialProps: { url: A } });
    await tick(0);
    await answer(pending[0], 200, page(["a1"]));
    rerender({ url: B });
    expect(result.current.phase).toBe("refreshing");
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["a1"]);
    await tick(250);
    await answer(pending[1], 200, page([]));
    expect(result.current.phase).toBe("ready");
    expect(result.current.page?.entries).toEqual([]);
  });

  it("waits a quarter of a second after a change, so stepping through filters sends one request", async () => {
    const { rerender } = renderHook(({ url }: { url: string }) => useActivityFeed(url), { initialProps: { url: A } });
    await tick(0);
    await answer(pending[0], 200, page(["a1"]));
    for (const day of ["01", "02", "03", "04"]) {
      rerender({ url: `${A}&day=2026-11-${day}` });
      await tick(100);
    }
    await tick(250);
    expect(pending.map((p) => p.url)).toEqual([A, `${A}&day=2026-11-04`]);
  });

  it("a request it aborted itself is not an error", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useActivityFeed(url), { initialProps: { url: A } });
    await tick(0);
    rerender({ url: B });
    await tick(250);
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe("loading");
  });

  it("a failed first page is an error with the server's sentence and reference, and retry sends exactly one request", async () => {
    const { result } = renderHook(() => useActivityFeed(A));
    await tick(0);
    await answer(pending[0], 500, { error: "Couldn't load activity.", reference: "MF-ABC123" });
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toEqual({ url: A, message: "Couldn't load activity.", reference: "MF-ABC123" });
    expect(result.current.page).toBeNull();
    await act(async () => result.current.retry());
    expect(pending).toHaveLength(2);
    await answer(pending[1], 200, page(["a1"]));
    expect(result.current.phase).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("too many requests, a timeout from the server and a body that is not a page are all errors, never an empty list", async () => {
    for (const [status, body, message] of [
      [429, { ok: false, code: "rate_limited", error: "Too many requests. Try again in a moment." }, "Too many requests. Try again in a moment."],
      [504, { ok: false, code: "timeout", error: "That's too much to load at once. Jump to a date or narrow the filters." }, "That's too much to load at once. Jump to a date or narrow the filters."],
      [200, { hello: "world" }, "Couldn't load activity."],
      [502, null, "Couldn't load activity."],
    ] as const) {
      pending = [];
      const { result, unmount } = renderHook(() => useActivityFeed(A));
      await tick(0);
      await answer(pending[0], status, body);
      expect(result.current.phase, String(status)).toBe("error");
      expect(result.current.error?.message).toBe(message);
      unmount();
    }
  });

  it("a network failure and a request that never answers each say what happened", async () => {
    const offline = renderHook(() => useActivityFeed(A));
    await tick(0);
    await act(async () => {
      pending[0].reject(new TypeError("Failed to fetch"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(offline.result.current.error?.message).toBe("Couldn't reach MatFlow. Check your connection and try again.");
    offline.unmount();

    pending = [];
    const slow = renderHook(() => useActivityFeed(A));
    await tick(0);
    await tick(20_000);
    expect(slow.result.current.error?.message).toBe("This is taking too long. Try again.");
  });

  it("Show older appends without repeating a row and moves the cursor on", async () => {
    const { result } = renderHook(() => useActivityFeed(A));
    await tick(0);
    await answer(pending[0], 200, page(["a1", "a2"], "a2"));
    let added: unknown = null;
    await act(async () => {
      const done = result.current.loadOlder();
      await vi.advanceTimersByTimeAsync(0);
      expect(pending[1].url).toBe(`${A}&cursor=a2`);
      pending[1].resolve(200, page(["a2", "a3", "a4"], null));
      added = await done;
    });
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(result.current.page?.nextCursor).toBeNull();
    expect(result.current.older).toBe("idle");
    // "a2" was already on screen: two rows were added, and the first of them is where focus goes.
    expect(added).toEqual({ firstId: "a3", added: 2 });
  });

  it("a Show older that fails keeps the rows and can be tried again", async () => {
    const { result } = renderHook(() => useActivityFeed(A));
    await tick(0);
    await answer(pending[0], 200, page(["a1"], "a1"));
    await act(async () => {
      const done = result.current.loadOlder();
      await vi.advanceTimersByTimeAsync(0);
      pending[1].resolve(500, { error: "Couldn't load activity." });
      await done;
    });
    expect(result.current.older).toBe("error");
    expect(result.current.phase).toBe("ready");
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["a1"]);
  });

  it("a Show older that answers after the filters changed appends nothing", async () => {
    const { result, rerender } = renderHook(({ url }: { url: string }) => useActivityFeed(url), { initialProps: { url: A } });
    await tick(0);
    await answer(pending[0], 200, page(["a1"], "a1"));
    await act(async () => {
      void result.current.loadOlder();
      await vi.advanceTimersByTimeAsync(0);
    });
    const olderRequest = pending[1];
    rerender({ url: B });
    await tick(250);
    await answer(pending[2], 200, page(["b1"]));
    await answer(olderRequest, 200, page(["a2"]));
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["b1"]);
  });

  it("refreshes page one when the tab comes back after a minute — but not sooner, and not once the person has paged", async () => {
    const { result } = renderHook(() => useActivityFeed(A));
    await tick(0);
    await answer(pending[0], 200, page(["a1"], "a1"));
    const show = async () => {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    await tick(30_000);
    await show();
    expect(pending).toHaveLength(1);
    await tick(31_000);
    await show();
    expect(pending.map((p) => p.url)).toEqual([A, A]);
    await answer(pending[1], 200, page(["a0", "a1"], "a1"));
    expect(result.current.page?.entries.map((e) => e.id)).toEqual(["a0", "a1"]);
    // After paging, coming back does not reset the list.
    await act(async () => {
      const done = result.current.loadOlder();
      await vi.advanceTimersByTimeAsync(0);
      pending[2].resolve(200, page(["a2"], null));
      await done;
    });
    await tick(120_000);
    await show();
    expect(pending).toHaveLength(3);
  });

  it("patch changes rows on screen in place; refresh fetches page one quietly", async () => {
    const { result } = renderHook(() => useActivityFeed(A));
    await tick(0);
    await answer(pending[0], 200, page(["a1", "a2"]));
    act(() => result.current.patch((e) => (e.id === "a2" ? { ...e, undone: true } : e)));
    expect(result.current.page?.entries.map((e) => e.undone)).toEqual([false, true]);
    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending).toHaveLength(2);
    expect(result.current.phase).toBe("ready");
    expect(result.current.page?.entries).toHaveLength(2);
  });
});
