"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ConfirmDialog primitive — see docs/UI-RULES.md §5 (item 4), §8 and §11.
 *
 * The replacement for every `window.confirm()` in the app. Token-driven, so it
 * reads correctly on the light staff shell and the dark member shell alike
 * (UI-RULES §1: no hardcoded polarity in shared components).
 *
 * Accessibility: `role="alertdialog"` + `aria-modal`, labelled by its title and
 * described by its body, Escape cancels, Tab is trapped inside the panel, focus
 * lands on the safe action (Cancel) on open and returns to the trigger on close.
 * Body scroll is locked while open.
 *
 * Mobile: bottom sheet under `sm:`, padded clear of the fixed bottom nav with
 * `--member-nav-clearance` (safe-area + 64px) so the actions are never hidden
 * behind the tab bar (UI-RULES §5 item 3, ratified 2026-08-16).
 *
 * Two ways to use it:
 *
 * 1. Imperative (the direct `confirm()` replacement — no provider needed):
 *
 *    const { ask, dialogProps } = useConfirmDialog();
 *    …
 *    if (!(await ask({ title: "Delete this rank?", body: "…", destructive: true }))) return;
 *    …
 *    <ConfirmDialog {...dialogProps} />
 *
 * 2. Declarative, when the confirm action is async and its failure should be
 *    reported inside the dialog: pass an `onConfirm` that returns a promise.
 *    A rejection re-enables both buttons and renders the error — the user is
 *    never trapped in a spinner they cannot escape.
 */

export interface ConfirmOptions {
  /** Sentence-case question or statement, e.g. "Remove Alex Chen?" */
  title: string;
  /** What will actually happen, and what cannot be undone. */
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button + warning icon. Use for anything irreversible. */
  destructive?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  /** May return a promise; a rejection is shown in the dialog, not swallowed. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  className?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
  className,
}: ConfirmDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => setMounted(true), []);

  // Reset transient state whenever the dialog is re-opened.
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  // Remember the trigger, move focus in, return it on close.
  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-confirm-initial-focus]");
    (first ?? panel)?.focus();
    return () => {
      triggerRef.current?.focus?.();
    };
  }, [open]);

  // Scroll lock.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        // Escape always works, even mid-request — never trap the user.
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === panel,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  async function handleConfirm() {
    setError(null);
    try {
      const result = onConfirm();
      if (result instanceof Promise) {
        setBusy(true);
        await result;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center px-4 pb-[var(--member-nav-clearance)] sm:items-center sm:pb-0"
      style={{ background: "color-mix(in srgb, var(--tx-1) 45%, transparent)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={cn(
          "w-full max-w-sm rounded-[var(--r-lg)] border p-5 shadow-2xl outline-none",
          className,
        )}
        style={{
          background: "var(--sf-3)",
          borderColor: "var(--bd-default)",
          animation: "confirm-dialog-in var(--dur-normal) var(--ease-out)",
        }}
      >
        <div className="flex items-start gap-3">
          {destructive && (
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
              style={{ background: "color-mix(in srgb, var(--hue-danger) 14%, transparent)" }}
            >
              <AlertTriangle className="size-4" style={{ color: "var(--hue-danger)" }} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
              {title}
            </h2>
            {body && (
              <div id={bodyId} className="mt-1.5 text-[13px] leading-relaxed" style={{ color: "var(--tx-2)" }}>
                {body}
              </div>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs" style={{ color: "var(--hue-danger)" }}>
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            data-confirm-initial-focus
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "primary"}
            loading={busy}
            onClick={() => void handleConfirm()}
          >
            {confirmLabel}
          </Button>
        </div>

        <style>{`
          @keyframes confirm-dialog-in {
            from { opacity: 0; transform: translateY(12px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
          }
        `}</style>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Imperative wrapper — the drop-in shape for replacing `window.confirm()`.
 *
 * `ask()` resolves `true` on confirm and `false` on cancel, dismissal or
 * unmount, so an awaiting caller can never hang.
 */
export function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const ask = useCallback((next: ConfirmOptions) => {
    // A second ask() supersedes the first; the stale caller gets a clean "no".
    resolverRef.current?.(false);
    resolverRef.current = null;
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(value);
  }, []);

  // Unmounting while a question is open resolves it as "no" rather than
  // leaving the awaiting caller pending forever.
  useEffect(
    () => () => {
      resolverRef.current?.(false);
      resolverRef.current = null;
    },
    [],
  );

  const dialogProps: ConfirmDialogProps = {
    open: options !== null,
    title: options?.title ?? "",
    body: options?.body,
    confirmLabel: options?.confirmLabel,
    cancelLabel: options?.cancelLabel,
    destructive: options?.destructive,
    onConfirm: () => settle(true),
    onCancel: () => settle(false),
  };

  return { ask, dialogProps };
}

export default ConfirmDialog;
