"use client";

import { useEffect, useRef, useState } from "react";
import { X, Loader2 } from "lucide-react";

/**
 * EditChildModal — shared modal used by FamilySection for both:
 *   - Create: opened with kid=null; on submit POSTs /api/member/children
 *   - Edit:   opened with an existing kid; on submit PATCHes /api/member/children/[id]
 *
 * Parent-side only. Only `name` and `dateOfBirth` are editable here — the
 * server PATCH allowlist drops anything else.
 */

export type EditableChild = {
  id: string;
  name: string;
  dateOfBirth: string | null;
};

interface Props {
  primaryColor: string;
  kid: EditableChild | null; // null => create
  onClose: () => void;
  onSaved: (kid: EditableChild) => void;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function EditChildModal({ primaryColor, kid, onClose, onSaved }: Props) {
  const [name, setName] = useState(kid?.name ?? "");
  const [dob, setDob] = useState(kid?.dateOfBirth ? kid.dateOfBirth.slice(0, 10) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && !saving;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const isEdit = !!kid;
      const url = isEdit ? `/api/member/children/${kid!.id}` : `/api/member/children`;
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          dateOfBirth: dob ? dob : null,
          ...(isEdit ? {} : { accountType: "kids" }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error ?? "Couldn't save. Try again.");
        setSaving(false);
        return;
      }
      const data = await res.json();
      onSaved({
        id: data.id ?? kid?.id ?? "",
        name: data.name ?? trimmed,
        dateOfBirth: data.dateOfBirth ?? (dob || null),
      });
    } catch {
      setError("Network error. Try again.");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="bg-[var(--member-elevated)] border border-[var(--member-elevated-border)] rounded-t-3xl md:rounded-3xl w-full md:max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-bold text-base">{kid ? "Edit child" : "Add a child"}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: "var(--member-surface)" }}
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-gray-500 text-xs uppercase tracking-wider block mb-1">Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sam"
              className="w-full rounded-lg px-3 py-2.5 text-white text-sm outline-none border placeholder-gray-600"
              style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
            />
          </div>
          <div>
            <label className="text-gray-500 text-xs uppercase tracking-wider block mb-1">
              Date of birth <span className="normal-case text-gray-600">(optional)</span>
            </label>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 text-white text-sm outline-none border"
              style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
            />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>

        <button
          onClick={submit}
          disabled={!canSave}
          className="w-full mt-4 py-3 rounded-2xl text-white font-semibold text-sm transition-all disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ background: primaryColor, boxShadow: `0 6px 18px ${hex(primaryColor, 0.3)}` }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : kid ? "Save changes" : "Add child"}
        </button>
      </div>
    </div>
  );
}
