"use client";

/**
 * G5 (owner decision, 27 Oct 2026): "In app sign ins are optionally set up by
 * the gym owners, and they should be able to turn it off in their gym
 * settings. It should be on as default."
 *
 * One switch, saved through PATCH /api/settings (owner-only, audited as
 * tenant.settings.update with before/after, undoable from Activity). Off
 * refuses only the member's own path in POST /api/checkin, a parent checking
 * in a child included; the desk, the kiosk, the card scanner and the coach
 * register are unaffected.
 */
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingImpact } from "@/components/dashboard/SettingImpact";
import { useToast } from "@/components/ui/Toast";

export const MEMBER_APP_CHECKIN_LABEL = "Members can check themselves in from the app";
export const MEMBER_APP_CHECKIN_ON_HINT =
  "Members, and parents for their children, can check in to a class from the member app.";
export const MEMBER_APP_CHECKIN_OFF_HINT =
  "The member app hides its check-in button. Members check in at the desk or the kiosk; the timetable and class sign-up stay.";

export function MemberAppCheckinSetting({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save() {
    const next = !enabled;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberAppCheckin: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data?.error === "string" ? data.error : "Couldn't save the setting. Try again.");
        return;
      }
      setEnabled(next);
      toast(next ? "App check-in turned on" : "App check-in turned off", "success");
    } catch {
      setError("Couldn't save the setting. Check your connection and try again.");
    } finally {
      setSaving(false);
      setPending(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-3 mb-4 pb-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
      <div className="min-w-0">
        <p id="member-app-checkin-label" className="text-tx-1 font-semibold text-sm">{MEMBER_APP_CHECKIN_LABEL}</p>
        <p id="member-app-checkin-hint" className="text-tx-3 text-xs mt-1" data-testid="member-app-checkin-hint">
          {enabled ? MEMBER_APP_CHECKIN_ON_HINT : MEMBER_APP_CHECKIN_OFF_HINT}
        </p>
        {error && <p role="alert" className="text-xs mt-2 text-[var(--hue-danger-ink)]">{error}</p>}
      </div>
      <ConfirmDialog
        open={pending}
        onClose={() => { if (!saving) setPending(false); }}
        title={enabled ? "Turn off check-in from the app?" : "Let members check in from the app?"}
        description={
          enabled
            ? "Members and parents lose the check-in button in the app and check in at the desk or the kiosk instead."
            : "Members, and parents for their children, can check in to a class from the app again."
        }
        confirmLabel={saving ? "Saving…" : enabled ? "Turn off" : "Turn on"}
        loading={saving}
        onConfirm={save}
      >
        <SettingImpact settingKey="memberAppCheckin" />
      </ConfirmDialog>
      <Switch
        checked={enabled}
        onCheckedChange={() => setPending(true)}
        disabled={saving}
        aria-labelledby="member-app-checkin-label"
        aria-describedby="member-app-checkin-hint"
      />
    </div>
  );
}
