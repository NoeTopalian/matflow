"use client";

import { useEffect, useRef, useState } from "react";
import { X, Loader2, Send, Users, User as UserIcon } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";

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
 *                          a member with required body + optional push flag.
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
  const [assignedToId, setAssignedToId] = useState("");

  // Member mode state
  const [body, setBody] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [memberMatches, setMemberMatches] = useState<MemberOption[] | null>(null);
  const [chosenMember, setChosenMember] = useState<MemberOption | null>(prefilledMember ?? null);
  const [sendPush, setSendPush] = useState(true);
  const memberSearchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset on close
  useEffect(() => {
    if (open) return;
    setTitle("");
    setBody("");
    setMemberQuery("");
    setMemberMatches(null);
    setChosenMember(prefilledMember ?? null);
    setError("");
    setSubmitting(false);
    setMode(defaultMode);
  }, [open, defaultMode, prefilledMember]);

  // Staff list on open — only fetched when actually needed.
  useEffect(() => {
    if (!open || mode !== "staff") return;
    let cancelled = false;
    setError("");
    fetch("/api/staff/assignable")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: StaffOption[]) => {
        if (cancelled) return;
        const filtered = list.filter((s) => s.id !== currentUserId);
        setStaff(filtered);
        if (filtered.length > 0 && !assignedToId) setAssignedToId(filtered[0].id);
      })
      .catch(() => {
        if (!cancelled) setStaff([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, currentUserId]);

  // Debounced member search. Fires when query >= 2 chars; clears matches
  // otherwise. Cancels a pending search if the user keeps typing.
  useEffect(() => {
    if (!open || mode !== "member") return;
    if (chosenMember) return;
    if (memberSearchDebounce.current) clearTimeout(memberSearchDebounce.current);
    const trimmed = memberQuery.trim();
    if (trimmed.length < 2) {
      setMemberMatches(null);
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
              sendPush,
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

  if (!open) return null;

  const titleLabel = mode === "staff" ? "What needs doing?" : "Headline (what should the member do?)";
  const titlePlaceholder =
    mode === "staff" ? "e.g. Order new mats from supplier" : "e.g. Sign your new waiver";
  const ctaLabel = mode === "staff" ? "Send task" : "Send action";

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Add a task"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md rounded-2xl border shadow-2xl"
        style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
      >
        <div
          className="flex items-center justify-between gap-4 px-5 py-4 border-b"
          style={{ borderColor: "var(--bd-default)" }}
        >
          <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>
            {mode === "staff" ? "Add a task" : "Send action to member"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl flex items-center justify-center border transition-colors hover:border-white/20"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
            aria-label="Close add task"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
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
                  color: mode === "staff" ? "#ffffff" : "var(--tx-2)",
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
                  color: mode === "member" ? "#ffffff" : "var(--tx-2)",
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
              autoFocus
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
              {staff === null ? (
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
                              className="w-full flex items-center gap-2 justify-between px-3 py-2 text-left text-sm hover:bg-white/5"
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

              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={sendPush}
                  onChange={(e) => setSendPush(e.target.checked)}
                  className="rounded border-white/20"
                />
                <span className="text-xs" style={{ color: "var(--tx-2)" }}>
                  Also send a push notification (members can opt out in Profile)
                </span>
              </label>
            </>
          )}

          {error && (
            <p className="text-sm" style={{ color: "#ef4444" }}>
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={
              submitting ||
              !title.trim() ||
              (mode === "staff"
                ? !assignedToId || staff === null || staff.length === 0
                : !chosenMember || !body.trim())
            }
            className="w-full py-3 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 transition-opacity disabled:opacity-40"
            style={{ background: primaryColor }}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {ctaLabel}
          </button>
        </div>
      </div>
    </>
  );
}
