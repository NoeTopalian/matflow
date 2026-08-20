"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "./button";
import { Dialog } from "./dialog";
import type { NavClearance } from "./overlay";

/**
 * ConfirmDialog — the replacement for every `window.confirm()` and `alert()`
 * in the app (docs/UI-RULES.md §5.4). Built on `Dialog`, so it inherits the
 * whole accessibility contract: role="dialog", aria-modal, Escape, focus
 * trap, scroll lock.
 *
 * This is the ONE implementation (§5.4, §11). A second, hand-rolled confirm
 * primitive lived alongside it until 2026-08-18; it portalled itself and wrote
 * `document.body.style.overflow` directly instead of going through
 * `overlay.tsx`, so it took part in neither the ref-counted scroll lock nor
 * the Escape stack. Nested inside a Sheet that broke both invariants — closing
 * out of order stranded the scrollport at `overflow: hidden`, and one Escape
 * closed both layers. Everything it offered now lives here: the declarative
 * props below, and the imperative `useConfirmDialog()` hook at the foot of
 * this file.
 *
 * Copy is British English and the defaults are deliberately minimal: the
 * caller supplies a verb-first action label ("Remove member", "Cancel
 * membership"), we supply "Cancel". Cancel is the secondary button on the
 * left, the action is right-aligned, and `destructive` swaps it to the danger
 * variant.
 *
 * `confirmPhrase` turns on typed confirmation — the action stays disabled
 * until the user types the phrase exactly. Use it for anything that destroys
 * data irreversibly.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** May return a promise — the confirm button shows in-flight state until it settles. */
  onConfirm: () => void | Promise<void>;
  title: string;
  /** Body copy: what is about to happen, and whether it can be undone. */
  description?: ReactNode;
  /** Extra content rendered under the body copy. */
  children?: ReactNode;
  /** Verb-first, e.g. "Remove member". */
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Force the in-flight state when the caller owns the async work. */
  loading?: boolean;
  /** When set, the action stays disabled until the user types this exactly. */
  confirmPhrase?: string;
  /** Overrides the default "Type X to confirm" prompt. */
  confirmPhraseHint?: string;
  navClearance?: NavClearance;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  confirmPhrase,
  confirmPhraseHint,
  navClearance,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [typed, setTyped] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  const phraseInputId = useId();

  // Clear the typed confirmation whenever the dialog is dismissed, so
  // reopening it never arrives pre-armed. Adjusted during render rather than
  // in an effect — the parent usually closes this dialog itself once the
  // action succeeds, so a close handler would miss the commonest path, and a
  // reset effect would cascade an extra render on every open.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setTyped("");
  }

  const busy = loading || pending;
  const phraseSatisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  function handleConfirm() {
    if (busy || !phraseSatisfied) return;
    const result = onConfirm();
    // Only enter the in-flight state for genuinely async work. A synchronous
    // onConfirm that closes the dialog itself must not flash a spinner or
    // disable Cancel for a tick. Errors stay the caller's to handle — the
    // dialog only owns the spinner.
    if (!result || typeof result.then !== "function") return;
    setPending(true);
    // Errors stay the caller's to surface (their own toast is the UX), but the
    // rejection must be absorbed here — a bare `.finally()` leaves it
    // unhandled and trips `unhandledrejection`. Close-state is unchanged:
    // only the spinner is cleared.
    void result
      .catch((error: unknown) =>
        console.error("[ConfirmDialog] onConfirm failed", error),
      )
      .finally(() => setPending(false));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      navClearance={navClearance}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "primary"}
            onClick={handleConfirm}
            loading={busy}
            disabled={!phraseSatisfied}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description ? <div className="text-sm text-tx-2">{description}</div> : null}
      {children}
      {confirmPhrase ? (
        <div className="mt-4 space-y-1.5">
          <label
            htmlFor={phraseInputId}
            className="block text-[13px] font-medium text-tx-2"
          >
            {confirmPhraseHint ?? `Type ${confirmPhrase} to confirm`}
          </label>
          <input
            id={phraseInputId}
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-[var(--r-sm)] border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1 outline-none transition-colors focus:border-bd-active"
          />
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * What `ask()` takes. `body` is the prose under the title — the same field the
 * old hand-rolled primitive called `body`, kept under that name so the call
 * sites read as questions ("title") plus consequences ("body"); it lands on
 * the declarative `description` prop.
 */
export interface ConfirmOptions {
  /** Sentence-case question or statement, e.g. "Remove Alex Chen?" */
  title: string;
  /** What will actually happen, and what cannot be undone. */
  body?: ReactNode;
  /** Verb-first. Defaults to "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger-filled confirm button. Use for anything irreversible. */
  destructive?: boolean;
  /** Member surfaces pass "member-nav" to clear the fixed bottom nav (§5.3). */
  navClearance?: NavClearance;
}

/**
 * Imperative wrapper — the drop-in shape for replacing `window.confirm()`,
 * for the callers whose question is asked mid-`async` rather than driven by a
 * piece of component state:
 *
 *   const { ask, dialogProps } = useConfirmDialog();
 *   …
 *   if (!(await ask({ title: "Remove this photo?", destructive: true }))) return;
 *   …
 *   <ConfirmDialog {...dialogProps} />
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
    description: options?.body,
    confirmLabel: options?.confirmLabel ?? "Confirm",
    cancelLabel: options?.cancelLabel,
    destructive: options?.destructive,
    navClearance: options?.navClearance,
    onConfirm: () => settle(true),
    onClose: () => settle(false),
  };

  return { ask, dialogProps };
}

export default ConfirmDialog;
