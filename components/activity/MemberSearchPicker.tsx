"use client";

/**
 * Find one member by name or email — the Member filter on the Activity page.
 *
 * An ARIA combobox on the Input primitive: type two characters, pick from up
 * to eight matches with the mouse or the arrow keys. Once someone is picked
 * the field becomes a same-size box with their name and a clear button, so the
 * filter row never changes shape.
 *
 * What is typed stays in this component: only the picked member's id ever
 * reaches the address bar. The list keeps name, id and email — nothing else of
 * what the members endpoint returns.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

export type PickedMember = { id: string; name: string };
type Option = { id: string; name: string; email: string; status: string };

const MIN_CHARS = 2;
const MAX_RESULTS = 8;
const DEBOUNCE_MS = 300;

type State = { kind: "idle" } | { kind: "searching" } | { kind: "results"; options: Option[] } | { kind: "error" };

/** The second line of an option: the address, or what the account is when it has none of its own. */
function secondLine(option: Option): string {
  const who = isSynthesisedEmail(option.email) ? "Child account" : option.email;
  const status = option.status === "cancelled" ? "Cancelled" : option.status === "inactive" ? "Inactive" : null;
  return status ? `${who} · ${status}` : who;
}

export function MemberSearchPicker({
  value,
  onChange,
  disabled = false,
}: {
  /** The picked member, or null. A name of null means the id is not a member of this club any more. */
  value: { id: string; name: string | null } | null;
  onChange: (member: PickedMember | null) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  /** Where the keyboard goes once the field has changed shape: to the clear button after a pick, back to the field after a clear. */
  const focusNext = useRef<"clear" | "field" | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const term = text.trim();

  // One request at a time: a newer keystroke aborts the older search, and a
  // response is used only if it is still the latest.
  useEffect(() => {
    if (term.length < MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        // includeArchived: the Activity log is history, and archived members are in it (PR 3).
        const res = await fetch(`/api/members?search=${encodeURIComponent(term)}&take=${MAX_RESULTS}&includeArchived=1`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { members?: Option[] };
        if (controller.signal.aborted) return;
        setState({ kind: "results", options: (data.members ?? []).slice(0, MAX_RESULTS).map((m) => ({ id: m.id, name: (m as { archivedAt?: string | null }).archivedAt ? `${m.name} (archived)` : m.name, email: m.email, status: m.status })) });
        setActive(0);
      } catch {
        // A failed search is said to be one — never shown as "no member matches".
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, attempt]);

  // The field and the picked box are different elements: focus follows the person across the swap, once the swap has happened.
  const pickedId = value?.id ?? null;
  useEffect(() => {
    if (focusNext.current === "clear" && pickedId) clearRef.current?.focus();
    else if (focusNext.current === "field" && !pickedId) inputRef.current?.focus();
    else return;
    focusNext.current = null;
  }, [pickedId]);

  const options = state.kind === "results" && term.length >= MIN_CHARS ? state.options : [];

  function pick(option: Option) {
    setText("");
    setOpen(false);
    setState({ kind: "idle" });
    focusNext.current = "clear";
    onChange({ id: option.id, name: option.name });
  }

  function retry() {
    setState({ kind: "searching" });
    setAttempt((n) => n + 1);
  }

  if (value) {
    return (
      <div data-testid="member-picked" className="ui-fixed-size ui-field flex h-9 w-full items-center gap-1 rounded-[var(--r-md)] border border-bd-default bg-sf-1 pl-3 pr-1 text-sm text-tx-1">
        <span className="min-w-0 flex-1 truncate">{value.name ?? "Removed member"}</span>
        <Button
          ref={clearRef}
          type="button"
          variant="ghost"
          size="compact"
          className="w-8 px-0"
          aria-label={`Clear member filter: ${value.name ?? "removed member"}`}
          disabled={disabled}
          onClick={() => {
            focusNext.current = "field";
            onChange(null);
          }}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  const showList = open && !disabled;
  const searched = term.length >= MIN_CHARS;
  // What a screen reader is told as the list changes. The visible lines say the same to everyone else.
  const spoken = !showList || !searched ? "" : state.kind === "error" ? "Couldn't search members. Press Enter to try again." : state.kind !== "results" ? "Searching" : options.length === 0 ? `No member matches ${term}` : `${options.length} ${options.length === 1 ? "member" : "members"} found`;
  const NOTE = "px-3 py-2 text-xs text-tx-3";

  return (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-tx-3" aria-hidden="true" />
      <Input
        ref={inputRef}
        role="combobox"
        aria-label="Member"
        aria-expanded={showList}
        aria-controls={showList && options.length ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showList && options[active] ? `${listId}-${options[active].id}` : undefined}
        autoComplete="off"
        placeholder="Name or email"
        className="pl-8"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setOpen(true);
          // The matches on screen are for what was typed before: never offer them for new text. A space at the end
          // is not new text — the search does not run again for it, so the matches stay.
          if (next.trim() !== term) setState(next.trim().length >= MIN_CHARS ? { kind: "searching" } : { kind: "idle" });
        }}
        onFocus={() => setOpen(true)}
        // Leaving the field closes the list; a click on an option lands first because options act on mousedown.
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            if (options.length) setActive((i) => (i + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          } else if (event.key === "Enter" && showList && options[active]) {
            event.preventDefault();
            pick(options[active]);
          } else if (event.key === "Enter" && showList && searched && state.kind === "error") {
            // The "Try again" button cannot be reached without leaving the field, which closes the list.
            event.preventDefault();
            retry();
          } else if (event.key === "Escape" && showList) {
            // Closes the list and keeps what was typed.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <p className="sr-only" role="status" data-testid="member-search-status">
        {spoken}
      </p>
      {showList ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-[var(--r-md)] border border-bd-default bg-sf-4 py-1 shadow-lg" data-testid="member-search-popup">
          {!searched ? (
            <p className={NOTE}>Type at least {MIN_CHARS} characters</p>
          ) : state.kind === "error" ? (
            <div className="flex items-center justify-between gap-2 px-3 py-1.5">
              <p className="text-xs text-tx-2">Couldn&apos;t search members</p>
              {/* mousedown, so the field's blur does not close the list before the click arrives. */}
              <Button type="button" variant="ghost" size="compact" tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={retry}>
                Try again
              </Button>
            </div>
          ) : state.kind !== "results" ? (
            <p className={NOTE}>Searching…</p>
          ) : options.length === 0 ? (
            <p className={NOTE}>No member matches &ldquo;{term}&rdquo;</p>
          ) : (
            <>
              {/* Only options live in the listbox; notes about the list sit beside it. */}
              <div id={listId} role="listbox" aria-label="Members">
                {options.map((option, index) => (
                  <div
                    key={option.id}
                    id={`${listId}-${option.id}`}
                    role="option"
                    aria-selected={index === active}
                    className={`cursor-pointer px-3 py-1.5 ${index === active ? "bg-sf-2" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(option);
                    }}
                  >
                    <p className="truncate text-sm text-tx-1">{option.name}</p>
                    <p className="truncate text-xs text-tx-3">{secondLine(option)}</p>
                  </div>
                ))}
              </div>
              {options.length === MAX_RESULTS ? <p className="px-3 py-1.5 text-xs text-tx-3">Showing the first {MAX_RESULTS} — keep typing to narrow</p> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default MemberSearchPicker;
