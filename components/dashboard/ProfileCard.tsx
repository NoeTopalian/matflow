"use client";

// Settings → Account → Profile (8 Oct 2026, account-editing lane R, C1).
//
// The signed-in staff user's own display name — the only personal field on a
// staff account. Login email, password and authenticator are separate cards
// with their own checks. Saved through PATCH /api/account/profile, which
// re-issues this device's session so the top bar shows the new name; when it
// cannot (the response says sessionRefreshed: false) the per-request session
// check still brings the new name in on the next page load (8 Oct 2026).
//
// A plain input element with a wired label: there is no Input primitive in
// components/ui yet (docs/UI-RULES.md lists it as planned); same treatment as
// LoginEmailCard.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";

type Profile = { name: string; email: string; role: string };

const ROLE_LABEL: Record<string, string> = { owner: "Owner", manager: "Manager", coach: "Coach", admin: "Admin" };

export default function ProfileCard() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/account/profile", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as Profile;
      setProfile(data);
      setName(data.name);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trimmed = name.trim();
  const dirty = !!profile && trimmed !== profile.name;
  const canSave = dirty && !saving && trimmed.length > 0 && trimmed.length <= 100;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Your name could not be saved.");
        return;
      }
      setProfile((p) => (p ? { ...p, name: String(data.name) } : p));
      setName(String(data.name));
      setNotice(
        data.sessionRefreshed === false
          ? "Saved. Your new name appears in the top bar when the page next loads."
          : "Saved.",
      );
      // Re-render the server layout so the top bar picks up the re-issued session.
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Nothing was changed — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <h2 className="font-semibold text-sm mb-1" style={{ color: "var(--tx-1)" }}>Profile</h2>
      <p className="text-xs mb-4" style={{ color: "var(--tx-3)" }}>
        Your name as your club and its members see it. Your login email, password and authenticator are changed separately below.
      </p>

      {loadError ? (
        <ErrorState message="Couldn't load your profile." onRetry={() => void load()} />
      ) : !profile ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <form onSubmit={save} className="space-y-3" noValidate>
          <div>
            <label htmlFor="profile-name" className="block text-xs font-medium mb-1" style={{ color: "var(--tx-2)" }}>Name</label>
            <input
              id="profile-name"
              type="text"
              autoComplete="name"
              maxLength={100}
              value={name}
              onChange={(e) => { setName(e.target.value); setNotice(null); }}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
            />
          </div>
          <p className="text-xs" style={{ color: "var(--tx-3)" }}>
            Role: {ROLE_LABEL[profile.role] ?? profile.role}. Your role is not changed here.
          </p>
          {error && <p role="alert" className="text-xs" style={{ color: "var(--hue-danger-ink)" }}>{error}</p>}
          {notice && <p role="status" className="text-xs" style={{ color: "var(--tx-2)" }}>{notice}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="compact" disabled={!canSave} loading={saving}>Save name</Button>
          </div>
        </form>
      )}
    </div>
  );
}
