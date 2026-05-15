"use client";

// F6 — multi-kid attendance disambiguation.
//
// When a parent taps their name at the kiosk and has one or more linked kids,
// we don't know who's actually training today. This component asks. It's
// presentational only — the caller wires it up to the real check-in endpoint.
//
// Designed for the iPad-at-the-door form factor: 44×44+ tap targets, no
// hover-dependent affordances, no keyboard-only flows. Same component will
// be reused on /dashboard/checkin and /member/checkin once those surfaces
// hook it in.

import { useMemo, useState } from "react";

export type PickerOption = {
  // Pre-signed kiosk token bound to this option's memberId. The caller posts
  // it to /api/kiosk/[token]/checkin to record attendance against the right
  // Member row. Not used for staff/dashboard variants — those pass memberId
  // directly and ignore this field.
  kioskMemberToken: string;
  memberId?: string;
  name: string;
  kind: "self" | "kid";
  ageGroup?: string | null;       // adult | junior | kids | parent
  dateOfBirth?: string | null;    // ISO yyyy-mm-dd
  waiverOk: boolean;
};

function computeAge(dateOfBirth: string | null | undefined): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthday =
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

export function WhoIsTrainingPicker({
  primaryColor,
  options,
  onConfirm,
  onCancel,
}: {
  primaryColor: string;
  options: PickerOption[];
  onConfirm: (selected: PickerOption[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [waiverToast, setWaiverToast] = useState<string | null>(null);

  function toggle(opt: PickerOption) {
    if (!opt.waiverOk) {
      // Greyed tile — surface the reason instead of silently no-op.
      setWaiverToast(`${opt.name}'s waiver isn't on file — speak to staff.`);
      setTimeout(() => setWaiverToast(null), 3500);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(opt.kioskMemberToken)) next.delete(opt.kioskMemberToken);
      else next.add(opt.kioskMemberToken);
      return next;
    });
  }

  function confirm() {
    if (selected.size === 0) return;
    const picked = options.filter((o) => selected.has(o.kioskMemberToken));
    onConfirm(picked);
  }

  const tint = useMemo(() => primaryColor + "33", [primaryColor]); // ~20% alpha
  const tintStrong = useMemo(() => primaryColor + "66", [primaryColor]);

  return (
    <div className="w-full max-w-md mx-auto space-y-4">
      <div className="text-center">
        <h2 className="text-2xl font-semibold mb-1">Who's training today?</h2>
        <p className="text-sm opacity-70">Tap each person who's training, then confirm.</p>
      </div>

      <div className="space-y-2">
        {options.map((opt) => {
          const isSelected = selected.has(opt.kioskMemberToken);
          const age = computeAge(opt.dateOfBirth ?? null);
          const disabled = !opt.waiverOk;
          return (
            <button
              key={opt.kioskMemberToken}
              type="button"
              onClick={() => toggle(opt)}
              className="w-full rounded-2xl border p-4 flex items-center gap-4 text-left transition-colors min-h-[64px]"
              style={{
                background: disabled
                  ? "rgba(255,255,255,0.04)"
                  : isSelected
                    ? tint
                    : "rgba(255,255,255,0.06)",
                borderColor: isSelected ? primaryColor : "rgba(255,255,255,0.15)",
                opacity: disabled ? 0.55 : 1,
              }}
              aria-pressed={isSelected}
              aria-disabled={disabled}
            >
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-base font-bold shrink-0"
                style={{
                  background: isSelected ? primaryColor : tintStrong,
                  color: isSelected ? "white" : primaryColor,
                }}
              >
                {opt.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-base truncate">
                  {opt.name}
                  {opt.kind === "self" && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider opacity-60">You</span>
                  )}
                </p>
                <p className="text-xs opacity-60 mt-0.5">
                  {age !== null ? `${age} yrs · ` : ""}
                  {opt.kind === "kid" ? "Child" : "Adult"}
                  {disabled && " · Waiver missing"}
                </p>
              </div>
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 border"
                style={{
                  borderColor: isSelected ? primaryColor : "rgba(255,255,255,0.25)",
                  background: isSelected ? primaryColor : "transparent",
                  color: "white",
                }}
                aria-hidden
              >
                {isSelected ? "✓" : ""}
              </div>
            </button>
          );
        })}
      </div>

      {waiverToast && (
        <div
          className="rounded-xl px-4 py-3 text-sm text-center"
          style={{ background: "rgba(245, 158, 11, 0.12)", color: "rgb(252, 211, 77)" }}
          role="status"
        >
          {waiverToast}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-2xl border px-4 py-3.5 text-base font-medium min-h-[52px]"
          style={{ borderColor: "rgba(255,255,255,0.15)" }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={selected.size === 0}
          className="flex-[2] rounded-2xl px-4 py-3.5 text-base font-semibold text-white disabled:opacity-50 min-h-[52px]"
          style={{ background: primaryColor }}
        >
          {selected.size === 0
            ? "Pick at least one"
            : `Sign in ${selected.size}`}
        </button>
      </div>
    </div>
  );
}
