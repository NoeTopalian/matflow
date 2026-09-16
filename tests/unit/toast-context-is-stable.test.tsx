// @vitest-environment jsdom
//
// `ToastProvider` must not re-render every consumer in the dashboard each time a
// toast appears or dismisses.
//
// This is the ROOT CAUSE half of the payment-wipe bug. The provider passed
// `value={{ toast }}` — a fresh object on every render — so every `useToast()`
// consumer re-rendered whenever `toasts` state changed. One of those consumers
// was `OutstandingPanel`, which rebuilds the `member` prop inline, which
// re-triggered `RecordPaymentModal`'s reset effect and wiped a half-typed
// payment amount.
//
// **Why this file exists at all.** Commit 04d17e5 fixed both halves and its
// message claimed "reverting EITHER fix fails 3 of its 5". A supervisor audit
// mutation-tested that claim and it was FALSE: replacing the `useMemo` with a
// plain object literal left the entire unit suite green — 1368 passed, 0
// failed. The modal-side fix alone stops the data loss, so the product was
// still correct, but the provider fix was completely unguarded and a future
// "simplify this" would have silently restored the dashboard-wide re-render
// storm. A wrong claim in a commit message is worse than no claim, because it
// stops anyone checking.
//
// The assertion is a render COUNT, not a snapshot: the defect is not that the
// consumer renders wrongly, it is that it renders at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { ToastProvider, useToast } from "@/components/ui/Toast";

/**
 * Renders counted in an EFFECT, into a plain object.
 *
 * Three spellings were rejected before this one, and every rejection was fair:
 * bumping a `useRef` during render is "Cannot access refs during render";
 * reassigning an outer `let` is "Cannot reassign variables declared outside of
 * the component"; mutating an outer object during render is "This value cannot
 * be modified". All three are the same mistake — a side effect in the render
 * body, which React may replay. The lint rule's own suggestion is an effect,
 * and an effect with no dependency array runs after every commit, which is
 * precisely the thing being measured.
 */
const stats = { renders: 0 };

function Consumer() {
  const { toast } = useToast();
  // No dependency array: this runs after EVERY commit, which is exactly what
  // "how many times did this component render" means. Counting in the render
  // body is what the React compiler rules reject, and they are right to —
  // render must stay free of side effects React may replay.
  useEffect(() => {
    stats.renders += 1;
  });
  return (
    <button type="button" onClick={() => toast("hello")}>
      fire
    </button>
  );
}

function renderCount(): number {
  return stats.renders;
}

beforeEach(() => {
  stats.renders = 0;
});

describe("ToastProvider context value", () => {
  it("does not re-render consumers when a toast appears", () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Consumer />
        </ToastProvider>,
      );
      const before = renderCount();

      act(() => {
        screen.getByText("fire").click();
      });

      // The toast is on screen — the provider's own state definitely changed.
      expect(screen.getByText("hello")).toBeTruthy();

      expect(
        renderCount(),
        "a toast re-rendered every useToast() consumer in the app — this is the re-render storm that wiped a half-typed payment amount",
      ).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-render consumers when a toast auto-dismisses either", () => {
    // Dismissal is a second state change, and it happens 3.5s after the user
    // has moved on — i.e. exactly while they are typing something else.
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Consumer />
        </ToastProvider>,
      );
      act(() => {
        screen.getByText("fire").click();
      });
      const afterToast = renderCount();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.queryByText("hello")).toBeNull();
      expect(
        renderCount(),
        "an auto-dismissing toast re-rendered every consumer",
      ).toBe(afterToast);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still delivers the toast, so stability was not bought by breaking it", () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Consumer />
        </ToastProvider>,
      );
      act(() => {
        screen.getByText("fire").click();
      });
      expect(screen.getByText("hello")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("memoises the context value in source", () => {
    // Belt to the behavioural braces above. The render-count assertions are the
    // real proof; this one fails loudly at the exact line if someone inlines the
    // object again, which is a faster read than a render count going up by one.
    const src = readFileSync("components/ui/Toast.tsx", "utf8");
    expect(
      /const value = useMemo\(\(\) => \(\{ toast \}\), \[toast\]\)/.test(src),
      "ToastProvider's context value is no longer memoised — every useToast() consumer will re-render on every toast",
    ).toBe(true);
  });
});
