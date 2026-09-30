"use client";

/**
 * Sign-in lockout controls for the staff dashboard.
 *
 * Ten wrong passwords lock a staff account (`User.lockedUntil`) or a member
 * account (`Member.lockedUntil`) for an hour. Both unlock routes existed and
 * worked — `POST /api/auth/staff-unlock/[id]` (owner only) and
 * `POST /api/members/[id]/unlock` (owner + manager) — but nothing on screen
 * called either, so a coach locked out ten minutes before class showed in
 * Settings → Staff with no indicator and no way back in (verifier lane 1,
 * 30 Sep 2026). These are the callers.
 *
 * The route's own sentence is shown on failure (UI-RULES §7: an HTTP error is
 * never an empty state and never a generic "something went wrong" when the
 * server said something specific).
 */

import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useHydrated } from "@/components/ui/overlay";
import { formatTime } from "@/lib/date";

/** True when `lockedUntil` is set and still in the future. */
export function isSignInLocked(lockedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!lockedUntil) return false;
  const t = new Date(lockedUntil).getTime();
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * "Locked until 14:05". The time is in the viewer's own clock, so it is only
 * rendered after hydration — the server's clock (UTC) would otherwise be baked
 * into the HTML and disagree with the browser's.
 */
export function LockedPill({ lockedUntil, prefix = "Locked until" }: { lockedUntil: string; prefix?: string }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{
        background: "color-mix(in srgb, var(--hue-warning) 14%, transparent)",
        color: "var(--hue-warning-ink)",
      }}
    >
      <Lock className="h-3 w-3" aria-hidden="true" />
      {prefix} {formatTime(lockedUntil)}
    </span>
  );
}

type UnlockResult = { ok: true; message: string } | { ok: false; error: string };

/** POST an unlock route and turn the answer into one sentence either way. */
export async function postUnlock(url: string, fallbackError: string): Promise<UnlockResult> {
  try {
    const res = await fetch(url, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? fallbackError };
    return { ok: true, message: data.message ?? "Unlocked." };
  } catch {
    return { ok: false, error: "Couldn't reach MatFlow — nothing has changed." };
  }
}

/**
 * Settings → Staff: the "Locked until HH:MM" pill and an Unlock button for one
 * person. Renders nothing when they are not locked.
 */
export function StaffUnlockControl({
  staffId,
  name,
  lockedUntil,
  onUnlocked,
}: {
  staffId: string;
  name: string;
  lockedUntil: string | null | undefined;
  onUnlocked: (message: string) => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrated = useHydrated();

  // "Is it still locked?" reads the clock, so it waits for the browser's.
  if (!hydrated || !lockedUntil || !isSignInLocked(lockedUntil)) return null;

  async function unlock() {
    setBusy(true);
    setError(null);
    const result = await postUnlock(
      `/api/auth/staff-unlock/${encodeURIComponent(staffId)}`,
      "Couldn't unlock this account — they are still locked out.",
    );
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onUnlocked(result.message);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <LockedPill lockedUntil={lockedUntil} />
        <Button variant="secondary" size="compact" onClick={() => { setError(null); setConfirming(true); }}>
          Unlock
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs" style={{ color: "var(--hue-danger-ink)" }}>
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => { if (!busy) setConfirming(false); }}
        title={`Unlock ${name}?`}
        description="They can sign in straight away with their current password."
        confirmLabel="Unlock"
        loading={busy}
        onConfirm={unlock}
      />
    </div>
  );
}

/**
 * Member profile: the confirm step behind the "Unlock sign-in" item in the
 * More actions menu. The parent owns `open`; on success it is told the route's
 * sentence so it can toast and clear its own `lockedUntil`.
 */
export function MemberUnlockDialog({
  memberId,
  name,
  open,
  onClose,
  onUnlocked,
  onError,
}: {
  memberId: string;
  name: string;
  open: boolean;
  onClose: () => void;
  onUnlocked: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    const result = await postUnlock(
      `/api/members/${encodeURIComponent(memberId)}/unlock`,
      "Couldn't unlock this member — they are still locked out.",
    );
    setBusy(false);
    onClose();
    if (result.ok) onUnlocked(result.message);
    else onError(result.error);
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={`Unlock ${name}?`}
      description="They can sign in straight away with their current password."
      confirmLabel="Unlock sign-in"
      loading={busy}
      onConfirm={unlock}
    />
  );
}
