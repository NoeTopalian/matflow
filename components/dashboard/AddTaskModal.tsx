"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Users, User as UserIcon } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/ErrorState";

type StaffOption = { id: string; name: string; role: string };
type MemberOption = {
  id: string;
  name: string;
  email?: string | null;
  // feat/member-profile-pictures Track A Phase A5: rendered as a chip avatar
  // in the combobox + chosen-member badge. Null falls back to initials.
  profilePictureUrl?: string | null;
};
type Mode = "staff" | "member";

export type CreatedTask = {
  id: string;
  title: string;
  body?: string | null;
  kind?: "staff_task" | "member_note";
  status: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  assignedTo?: { id: string; name: string } | null;
  assigneeMember?: { id: string; name: string } | null;
};

/**
 * Modal launched from the dashboard's "+ Add task" button.
 *
 * Two modes, picked by a toggle at the top:
 *   - "Send to staff"   → existing staff_task flow (title + assignee dropdown)
 *   - "Send to member"  → feat/member-tickable-notes Phase 5: tickable note to
 *                          a member with a required body.
 *
 * Posts to /api/tasks with the matching discriminated payload. Hands the
 * created task back to the parent for optimistic insertion.
 */
export default function AddTaskModal({
  open,
  onClose,
  onCreated,
  primaryColor,
  currentUserId,
  defaultMode = "staff",
  prefilledMember,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (task: CreatedTask) => void;
  primaryColor: string;
  currentUserId: string;
  /**
   * Phase 5: opens directly into "Send to member" mode when launched from
   * the member detail page. Defaults to "staff" everywhere else for back-compat.
   */
  defaultMode?: Mode;
  /**
   * Phase 5: pre-selects a member when launched from their profile. The
   * combobox is replaced with a chip showing the chosen member's name.
   */
  prefilledMember?: MemberOption;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);

  // Common state
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Staff mode state
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  // null = still loading; staffError = the lookup failed. "No other staff" is
  // only ever printed when the server actually said so (UI-RULES §7).
  const [staffError, setStaffError] = useState(false);
  const [assignedToId, setAssignedToId] = useState("");

  // Member mode state
  const [body, setBody] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberMatches, setMemberMatches] = useState<MemberOption[] | null>(null);
  const [chosenMember, setChosenMember] = useState<MemberOption | null>(prefilledMember ?? null);
  const memberSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The overlay focuses its own first focusable child on open, which beats a
  // plain `autoFocus` on the title input. Hand the primitive the ref instead so
  // the caret lands in the field the user is here to type in.
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Reset on close.
  //
  // Deferred off the synchronous effect body, as app/member/progress/page.tsx
  // does: eight setStates in a row cascade a second render pass every time the
  // modal closes (react-hooks/set-state-in-effect). The modal is already
  // hidden by then, so a microtask later is indistinguishable to the user.
  //
  // These three lint errors were latent, not new: the file previously carried
  // an `eslint-disable-next-line react-hooks/*` comment, and the React
  // Compiler rules skip any component containing one. Removing the disable in
  // the §7 fix above revealed them. Fixed rather than re-masked.
  useEffect(() => {
    if (open) return;
    queueMicrotask(() => {
      setTitle("");
      setBody("");
      setMemberQuery("");
      setMemberMatches(null);
      setChosenMember(prefilledMember ?? null);
      setError("");
      setSubmitting(false);
      setMode(defaultMode);
    });
  }, [open, defaultMode, prefilledMember]);

  // UI-RULES §7: `r.ok ? r.json() : []` plus `.catch(() => setStaff([]))`
  // rendered "No other staff in this gym yet" whenever the lookup failed, on a
  // gym with a full team — and the task could not be assigned to anyone.
  const loadStaff = useCallback(() => {
    setError("");
    setStaffError(false);
    setStaff(null);
    fetch("/api/staff/assignable")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((list: StaffOption[]) => {
        const filtered = Array.isArray(list) ? list.filter((s) => s.id !== currentUserId) : [];
        setStaff(filtered);
        if (filtered.length > 0) setAssignedToId((cur) => cur || filtered[0].id);
      })
      .catch(() => setStaffError(true));
  }, [currentUserId]);

  // Staff list on open — only fetched when actually needed.
  useEffect(() => {
    if (!open || mode !== "staff") return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) loadStaff(); });
    return () => { cancelled = true; };
  }, [open, mode, loadStaff]);

  // Debounced member search. Fires when query >= 2 chars; clears matches
  // otherwise. Cancels a pending search if the user keeps typing.
  useEffect(() => {
    if (!open || mode !== "member") return;
    if (chosenMember) return;
    if (memberSearchDebounce.current) clearTimeout(memberSearchDebounce.current);
    const trimmed = memberQuery.trim();
    if (trimmed.length < 2) {
      queueMicrotask(() => setMemberMatches(null));
      return;
    }
    memberSearchDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/members?take=20&search=${encodeURIComponent(trimmed)}`);
        if (!res.ok) {
          setMemberMatches([]);
          return;
        }
        const json = (await res.json()) as { members: MemberOption[] };
        setMemberMatches(json.members ?? []);
      } catch {
        setMemberMatches([]);
      }
    }, 200);
    return () => {
      if (memberSearchDebounce.current) clearTimeout(memberSearchDebounce.current);
    };
  }, [memberQuery, mode, open, chosenMember]);

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }

    if (mode === "staff") {
      if (!assignedToId) {
        setError("Pick a teammate to assign this to.");
        return;
      }
    } else {
      if (!chosenMember) {
        setError("Pick a member to send this to.");
        return;
      }
      if (!body.trim()) {
        setError("Add a short description so the member knows what to do.");
        return;
      }
    }

    setSubmitting(true);
    setError("");
    try {
      const payload =
        mode === "staff"
          ? { kind: "staff_task" as const, title: trimmedTitle, assignedToId }
          : {
              kind: "member_note" as const,
              title: trimmedTitle,
              body: body.trim(),
              assigneeMemberId: chosenMember!.id,
            };
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && data?.existingTask) {
          setError(
            `A similar action is already open for ${chosenMember?.name ?? "this member"}. Wait for them to tick it before re-sending.`,
          );
        } else {
          setError(data?.error ?? "Could not send. Please try again.");
        }
        setSubmitting(false);
        return;
      }
      const task: CreatedTask = await res.json();
      onCreated(task);
      onClose();
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  const titleLabel = mode === "staff" ? "What needs doing?" : "Headline (what should the member do?)";
  const titlePlaceholder =
    mode === "staff" ? "e.g. Order new mats from supplier" : "e.g. Sign your new waiver";
  const ctaLabel = mode === "staff" ? "Send task" : "Send action";

  return (
    // Dialog (§4a.3): a short two-mode form — centred, capped at max-w-lg, a
    // bottom sheet below `sm:`. The primitive supplies aria-modal, Escape, the
    // focus trap and scroll lock that the hand-rolled panel only half had
    // (it declared role="dialog" and nothing else). Every handler is unchanged.
    <Dialog
      open={open}
      onClose={onClose}
      initialFocusRef={titleInputRef}
      title={mode === "staff" ? "Add a task" : "Send action to member"}
      footer={
        <Button
          onClick={submit}
          loading={submitting}
          disabled={
            !title.trim() ||
            (mode === "staff"
              ? !assignedToId || staff === null || staff.length === 0
              : !chosenMember || !body.trim())
          }
        >
          {!submitting && <Send className="w-4 h-4" />}
          {ctaLabel}
        </Button>
      }
    >
        <div className="space-y-4">
          {/* feat/member-tickable-notes Phase 5: top toggle. Hidden when
              the modal was launched from a member's profile (prefilledMember
              forces member mode — no point letting them switch off). */}
          {!prefilledMember && (
            <div
              className="grid grid-cols-2 rounded-xl border p-1 gap-1"
              style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}
              role="tablist"
              aria-label="Send to"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "staff"}
                onClick={() => setMode("staff")}
                className="flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{
                  background: mode === "staff" ? primaryColor : "transparent",
                  color: mode === "staff" ? "var(--tx-on-accent)" : "var(--tx-2)",
                }}
              >
                <Users className="w-3.5 h-3.5" /> Send to staff
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "member"}
                onClick={() => setMode("member")}
                className="flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{
                  background: mode === "member" ? primaryColor : "transparent",
                  color: mode === "member" ? "var(--tx-on-accent)" : "var(--tx-2)",
                }}
              >
                <UserIcon className="w-3.5 h-3.5" /> Send to member
              </button>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="task-title" className="text-xs font-semibold" style={{ color: "var(--tx-2)" }}>
              {titleLabel}
            </label>
            <input
              id="task-title"
              ref={titleInputRef}
              type="text"
              value={title}
              maxLength={140}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={titlePlaceholder}
              className="w-full px-4 py-2.5 rounded-xl border outline-none transition-colors"
              style={{
                background: "var(--sf-1)",
                borderColor: "var(--bd-default)",
                color: "var(--tx-1)",
              }}
            />
          </div>

          {mode === "staff" ? (
            <div className="space-y-1.5">
              <label
                htmlFor="task-assignee"
                className="text-xs font-semibold"
                style={{ color: "var(--tx-2)" }}
              >
                Send to
              </label>
              {staffError ? (
                <ErrorState
                  message="Couldn't load your team — tap to retry"
                  onRetry={loadStaff}
                />
              ) : staff === null ? (
                <div
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm"
                  style={{
                    background: "var(--sf-1)",
                    borderColor: "var(--bd-default)",
                    color: "var(--tx-3)",
                  }}
                >
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading team…
                </div>
              ) : staff.length === 0 ? (
                <p className="text-sm" style={{ color: "var(--tx-3)" }}>
                  No other staff in this gym yet.
                </p>
              ) : (
                <select
                  id="task-assignee"
                  value={assignedToId}
                  onChange={(e) => setAssignedToId(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border outline-none transition-colors"
                  style={{
                    background: "var(--sf-1)",
                    borderColor: "var(--bd-default)",
                    color: "var(--tx-1)",
                  }}
                >
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.role})
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label htmlFor="task-member" className="text-xs font-semibold" style={{ color: "var(--tx-2)" }}>
                  Send to member
                </label>
                {chosenMember ? (
                  <div
                    className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border"
                    style={{
                      background: "var(--sf-1)",
                      borderColor: "var(--bd-default)",
                      color: "var(--tx-1)",
                    }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar
                        pictureUrl={chosenMember.profilePictureUrl ?? null}
                        name={chosenMember.name}
                        colorSeed={chosenMember.id}
                        size="sm"
                      />
                      <span className="text-sm truncate">{chosenMember.name}</span>
                    </div>
                    {!prefilledMember && (
                      <button
                        type="button"
                        onClick={() => {
                          setChosenMember(null);
                          setMemberQuery("");
                          setMemberMatches(null);
                        }}
                        className="text-xs underline"
                        style={{ color: "var(--tx-3)" }}
                      >
                        Change
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <input
                      id="task-member"
                      type="text"
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                      placeholder="Search by name or email…"
                      className="w-full px-4 py-2.5 rounded-xl border outline-none transition-colors"
                      style={{
                        background: "var(--sf-1)",
                        borderColor: "var(--bd-default)",
                        color: "var(--tx-1)",
                      }}
                    />
                    {memberMatches && memberMatches.length > 0 && (
                      <ul
                        className="mt-1 rounded-xl border overflow-hidden max-h-56 overflow-y-auto"
                        style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}
                      >
                        {memberMatches.map((m) => (
                          <li key={m.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setChosenMember(m);
                                setMemberMatches(null);
                              }}
                              className="w-full flex items-center gap-2 justify-between px-3 py-2 text-left text-sm hover:bg-sf-2"
                              style={{ color: "var(--tx-1)" }}
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <Avatar
                                  pictureUrl={m.profilePictureUrl ?? null}
                                  name={m.name}
                                  colorSeed={m.id}
                                  size="sm"
                                />
                                <span className="truncate">{m.name}</span>
                              </span>
                              {m.email && (
                                <span className="text-xs truncate ml-3 shrink-0" style={{ color: "var(--tx-3)" }}>
                                  {m.email}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {memberMatches && memberMatches.length === 0 && memberQuery.trim().length >= 2 && (
                      <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
                        No members match &quot;{memberQuery}&quot;.
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="task-body" className="text-xs font-semibold" style={{ color: "var(--tx-2)" }}>
                  What should they do? <span style={{ color: "var(--tx-3)" }}>(1–1000 chars)</span>
                </label>
                <textarea
                  id="task-body"
                  value={body}
                  maxLength={1000}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  placeholder="e.g. Drop by reception this week to sign the new 2026 waiver — takes 2 minutes."
                  className="w-full px-4 py-2.5 rounded-xl border outline-none transition-colors resize-none"
                  style={{
                    background: "var(--sf-1)",
                    borderColor: "var(--bd-default)",
                    color: "var(--tx-1)",
                    lineHeight: 1.55,
                  }}
                />
                <p className="text-[11px] text-right" style={{ color: "var(--tx-4)" }}>
                  {body.length} / 1000
                </p>
              </div>

            </>
          )}

          {error && (
            <p className="text-sm" style={{ color: "#ef4444" }}>
              {error}
            </p>
          )}
        </div>
    </Dialog>
  );
}
