"use client";

import { useEffect, useState } from "react";
import { X, Loader2, Send } from "lucide-react";

type StaffOption = { id: string; name: string; role: string };

export type CreatedTask = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  createdBy: { id: string; name: string };
  assignedTo: { id: string; name: string };
};

/**
 * Small modal launched from the dashboard's "+ Add task" button. Fetches the
 * assignable staff list on open, posts the task on submit, and hands the
 * created task back to the parent for optimistic insertion.
 */
export default function AddTaskModal({
  open,
  onClose,
  onCreated,
  primaryColor,
  currentUserId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (task: CreatedTask) => void;
  primaryColor: string;
  currentUserId: string;
}) {
  const [staff, setStaff] = useState<StaffOption[] | null>(null);
  const [title, setTitle] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError("");
    fetch("/api/staff/assignable")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: StaffOption[]) => {
        if (cancelled) return;
        // Exclude the caller — sending a task to yourself isn't the point.
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
  }, [open, currentUserId]);

  useEffect(() => {
    if (!open) {
      setTitle("");
      setError("");
      setSubmitting(false);
    }
  }, [open]);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Title is required.");
      return;
    }
    if (!assignedToId) {
      setError("Pick someone to assign this to.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed, assignedToId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not create task.");
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

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-50" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Add a task"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md rounded-2xl border shadow-2xl"
        style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
      >
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>Add a task</h2>
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
          <div className="space-y-1.5">
            <label htmlFor="task-title" className="text-xs font-semibold" style={{ color: "var(--tx-2)" }}>
              What needs doing?
            </label>
            <input
              id="task-title"
              type="text"
              value={title}
              maxLength={140}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Order new mats from supplier"
              className="w-full px-4 py-2.5 rounded-xl border outline-none transition-colors"
              style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="task-assignee" className="text-xs font-semibold" style={{ color: "var(--tx-2)" }}>
              Send to
            </label>
            {staff === null ? (
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
                <Loader2 className="w-4 h-4 animate-spin" /> Loading team…
              </div>
            ) : staff.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--tx-3)" }}>No other staff in this gym yet.</p>
            ) : (
              <select
                id="task-assignee"
                value={assignedToId}
                onChange={(e) => setAssignedToId(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border outline-none transition-colors"
                style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.role})</option>
                ))}
              </select>
            )}
          </div>

          {error && (
            <p className="text-sm" style={{ color: "#ef4444" }}>{error}</p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={submitting || !title.trim() || !assignedToId || staff === null || staff.length === 0}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm flex items-center justify-center gap-2 transition-opacity disabled:opacity-40"
            style={{ background: primaryColor }}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Send task
          </button>
        </div>
      </div>
    </>
  );
}
