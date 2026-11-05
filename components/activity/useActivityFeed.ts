"use client";

/**
 * Loads the Activity timeline, one page at a time, without ever showing the
 * wrong rows. The rules it keeps (each has a test in
 * tests/unit/activity-feed-hook.test.tsx):
 *
 *  1. One list request at a time: a new one aborts the previous one.
 *  2. A response is applied only if it is the latest request AND it is for the
 *     filters the page is showing now. A slow answer to an old filter is dropped.
 *  3. A request this hook aborted is not an error: nothing is shown for it.
 *  4. A change of filters waits a quarter of a second before fetching, so
 *     stepping through days does not fire a request per click.
 *  5. "Show older" appends, never repeating a row; if the filters changed while
 *     it was in flight, its answer is dropped.
 *  6. A failed first page is an error, never an empty list. A failed "Show
 *     older" keeps the rows already loaded.
 *  7. No polling. When the tab becomes visible again after a minute or more,
 *     page one is fetched once — unless the person has paged, whose place in
 *     the list a refresh would lose.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ActivityResponse, FeedEntry } from "@/lib/activity-types";

export type FeedError = { message: string; reference?: string | null };

type Loaded = { url: string; page: ActivityResponse };
export type OlderResult = { firstId: string | null; added: number };
type State = { loaded: Loaded | null; error: (FeedError & { url: string }) | null; older: "idle" | "loading" | "error" };

const CLIENT_TIMEOUT_MS = 20_000;
const STALE_AFTER_MS = 60_000;
const UNREACHABLE = "Couldn't reach MatFlow. Check your connection and try again.";
const TOO_SLOW = "This is taking too long. Try again.";
const TIMED_OUT = "timed-out";

function isPage(body: unknown): body is ActivityResponse {
  return !!body && typeof body === "object" && Array.isArray((body as { entries?: unknown }).entries);
}

/**
 * @param url The request for page one of the current filters (lib/activity-url `apiQuery`), or null while the page is
 *            not ready to ask (the person's saved default view has not been read yet).
 */
export function useActivityFeed(url: string | null, { debounceMs = 250 }: { debounceMs?: number } = {}) {
  const [state, setState] = useState<State>({ loaded: null, error: null, older: "idle" });
  /** A list request is in flight (of any kind): "Show older" waits for it. */
  const [pending, setPending] = useState(false);
  const current = useRef(url);
  const sequence = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  /** The latest page set, readable outside a render: "how many rows did Show older add?" needs it at once. */
  const latestLoaded = useRef<Loaded | null>(null);
  const loadedAt = useRef(0);
  const paged = useRef(false);
  const first = useRef(true);

  /** @param quiet A refresh nobody asked for (after an undo, on returning to the tab): if it fails, the rows on screen stay and nothing is said. */
  const request = useCallback(async (target: string, cursor: string | null, quiet = false): Promise<OlderResult | null> => {
    inFlight.current?.abort();
    setPending(true);
    const controller = new AbortController();
    inFlight.current = controller;
    const mine = ++sequence.current;
    const timer = setTimeout(() => controller.abort(TIMED_OUT), CLIENT_TIMEOUT_MS);
    const latest = () => mine === sequence.current && current.current === target;
    const older = cursor !== null;
    try {
      const res = await fetch(older ? `${target}&cursor=${encodeURIComponent(cursor)}` : target, { signal: controller.signal });
      const body: unknown = await res.json().catch(() => null);
      if (!latest()) return null;
      if (!res.ok || !isPage(body)) {
        const told = body && typeof body === "object" ? (body as { error?: unknown; reference?: unknown }) : {};
        const message = typeof told.error === "string" ? told.error : "Couldn't load activity.";
        if (older) setState((s) => ({ ...s, older: "error" }));
        else if (!quiet) setState((s) => ({ ...s, error: { url: target, message, reference: typeof told.reference === "string" ? told.reference : null } }));
        return null;
      }
      loadedAt.current = Date.now();
      if (!older) {
        paged.current = false;
        latestLoaded.current = { url: target, page: body };
        setState({ loaded: latestLoaded.current, error: null, older: "idle" });
        return null;
      }
      const base = latestLoaded.current;
      if (!base || base.url !== target) return null;
      paged.current = true;
      const seen = new Set(base.page.entries.map((e) => e.id));
      const fresh = body.entries.filter((e) => !seen.has(e.id));
      latestLoaded.current = { url: target, page: { ...base.page, entries: [...base.page.entries, ...fresh], nextCursor: body.nextCursor } };
      setState({ loaded: latestLoaded.current, error: null, older: "idle" });
      return { firstId: fresh[0]?.id ?? null, added: fresh.length };
    } catch {
      if (!latest()) return null;
      // Aborted because something newer replaced it: say nothing. Aborted by the timer, or the network failed: say so.
      if (controller.signal.aborted && controller.signal.reason !== TIMED_OUT) return null;
      const message = controller.signal.aborted ? TOO_SLOW : UNREACHABLE;
      if (older) setState((s) => ({ ...s, older: "error" }));
      else if (!quiet) setState((s) => ({ ...s, error: { url: target, message } }));
      return null;
    } finally {
      clearTimeout(timer);
      if (mine === sequence.current) setPending(false);
    }
  }, []);

  // A new set of filters: page one, after a short pause (none on the very first load).
  useEffect(() => {
    current.current = url;
    if (!url) return;
    const delay = first.current ? 0 : debounceMs;
    first.current = false;
    const timer = setTimeout(() => void request(url, null), delay);
    return () => clearTimeout(timer);
  }, [url, debounceMs, request]);

  // Leaving the page: stop whatever is in flight.
  useEffect(() => () => inFlight.current?.abort(), []);

  // Back to the tab after a while: one quiet refresh of page one.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !current.current || paged.current) return;
      if (loadedAt.current && Date.now() - loadedAt.current >= STALE_AFTER_MS) void request(current.current, null, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [request]);

  const showing = state.loaded && state.loaded.url === url;
  const failed = state.error && state.error.url === url ? state.error : null;

  return {
    /** The page to draw. While new filters load, this is still the previous rows (drawn dimmed), never an empty list. */
    page: state.loaded?.page ?? null,
    /** `loading`: nothing to show yet. `refreshing`: showing the previous filters' rows while the new ones load. */
    phase: (failed ? "error" : !state.loaded ? "loading" : showing ? "ready" : "refreshing") as "loading" | "ready" | "refreshing" | "error",
    error: failed as FeedError | null,
    older: state.older,
    /** Try page one again (after an error). */
    retry: useCallback(() => {
      if (!current.current) return;
      setState((s) => ({ ...s, error: null }));
      void request(current.current, null);
    }, [request]),
    /** Fetch the next page. Resolves to how many rows it added and the first of them, so the caller can announce it and move focus there. */
    loadOlder: useCallback(async (): Promise<OlderResult | null> => {
      const target = current.current;
      const cursor = state.loaded?.url === target ? state.loaded.page.nextCursor : null;
      if (!target || !cursor) return null;
      // From here the person is paging: a refresh of page one would lose their place, or cancel this very request.
      paged.current = true;
      setState((s) => ({ ...s, older: "loading" }));
      return request(target, cursor);
    }, [request, state.loaded]),
    /** Page one again, keeping the rows on screen until it lands (after an undo). Skipped once the person has paged. */
    refresh: useCallback(() => {
      if (current.current && !paged.current) void request(current.current, null, true);
    }, [request]),
    /** A list request is in flight. */
    pending,
    /** Change rows already on screen (an undone row is struck through at once, without a reload). */
    patch: useCallback((change: (entry: FeedEntry) => FeedEntry) => {
      const base = latestLoaded.current;
      if (!base) return;
      latestLoaded.current = { ...base, page: { ...base.page, entries: base.page.entries.map(change) } };
      const next = latestLoaded.current;
      setState((s) => ({ ...s, loaded: next }));
    }, []),
  };
}
