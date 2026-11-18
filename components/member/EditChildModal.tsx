"use client";

import { useId, useRef, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { useOverlay } from "@/components/ui/overlay";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";

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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { ask, dialogProps } = useConfirmDialog();

  // Round 11 (5.4): one stray tap on the backdrop, Escape or × threw a half-typed child
  // away. With something entered, each asks first. The shared overlay behaviour moves
  // focus in (the name field), keeps Tab inside and returns focus on close.
  const dirty = name !== (kid?.name ?? "") || dob !== (kid?.dateOfBirth ? kid.dateOfBirth.slice(0, 10) : "");
  async function requestClose() {
    if (saving) return;
    if (!dirty) return onClose();
    const discard = await ask({
      title: "Discard your changes?",
      body: "What you've entered here hasn't been saved.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
      navClearance: "member-nav",
    });
    if (discard) onClose();
    else focusBackInto(panelRef.current, nameRef.current);
  }
  useOverlay({ open: true, onClose: () => void requestClose(), panelRef, initialFocusRef: nameRef });

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

  // The question sits outside the backdrop: React clicks bubble through portals, so a
  // click on it inside the backdrop would ask again.
  return (
    <>
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-end md:items-center justify-center"
      style={{ paddingBottom: "var(--member-nav-clearance)" }}
      onClick={() => void requestClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-[var(--member-elevated)] border border-[var(--member-elevated-border)] rounded-t-3xl md:rounded-3xl w-full md:max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          {/* Round 11 (5.2): with two children, the title says whose details these are. */}
          <h2 id={titleId} className="text-white font-bold text-base">{kid ? `Edit ${kid.name}` : "Add a child"}</h2>
          <button
            onClick={() => void requestClose()}
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
            <input aria-label="Name"
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
            <input aria-label="Date of birth (optional)"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full rounded-lg px-3 py-2.5 text-white text-sm outline-none border"
              style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
            />
          </div>
          {error && <p role="alert" className="text-red-400 text-xs">{error}</p>}
        </div>

        <button
          onClick={submit}
          disabled={!canSave}
          className="w-full mt-4 py-3 rounded-2xl text-[var(--tx-on-accent)] font-semibold text-sm transition-all disabled:opacity-40 flex items-center justify-center gap-2"
          style={{ background: primaryColor, boxShadow: `0 6px 18px ${hex(primaryColor, 0.3)}` }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : kid ? "Save changes" : "Add child"}
        </button>
      </div>
    </div>
    <ConfirmDialog {...dialogProps} />
    </>
  );
}

/** After "Keep editing" the question hands focus back to what it saw on open; a backdrop tap left that as <body>. */
function focusBackInto(panel: HTMLElement | null, preferred?: HTMLElement | null) {
  setTimeout(() => {
    if (!panel || panel.contains(document.activeElement)) return;
    (preferred ?? panel.querySelector<HTMLElement>("input, textarea, button"))?.focus();
  }, 0);
}
