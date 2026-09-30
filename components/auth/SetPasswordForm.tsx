"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { describeSaveFailure } from "@/lib/save-failure";

export default function SetPasswordForm({ name }: { name: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 10 && confirm === password && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(describeSaveFailure(res.status, body, "Save password").message);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError(describeSaveFailure(0, null, "Save password").message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4" style={{ background: "var(--sf-0)" }}>
      <form onSubmit={submit} className="w-full max-w-[420px] rounded-[var(--r-lg)] border border-bd-default bg-sf-1 p-6 space-y-4" aria-labelledby="set-password-title">
        <div>
          <h1 id="set-password-title" className="text-xl font-semibold text-tx-1">Choose your password</h1>
          <p className="mt-1 text-sm text-tx-3">
            {name ? `${name}, you` : "You"} signed in with a temporary password. Pick your own before continuing — at least 10 characters with an upper-case letter, a lower-case letter and a number, and not one you have used here before.
          </p>
        </div>
        {error && (
          <p role="alert" className="rounded-[var(--r-md)] px-3 py-2 text-sm" style={{ background: "var(--hue-danger-soft, rgba(239,68,68,0.10))", color: "var(--hue-danger-ink)" }}>
            {error}
          </p>
        )}
        <label className="block text-sm">
          <span className="mb-1.5 block text-xs font-medium text-tx-3">New password</span>
          <input
            type="password"
            aria-label="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            required
            className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-0 px-3 py-2.5 text-sm text-tx-1 outline-none focus-visible:ring-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block text-xs font-medium text-tx-3">Confirm password</span>
          <input
            type="password"
            aria-label="Confirm password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? "set-password-mismatch" : undefined}
            className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-0 px-3 py-2.5 text-sm text-tx-1 outline-none focus-visible:ring-2"
          />
          {mismatch && <span id="set-password-mismatch" className="mt-1 block text-xs" style={{ color: "var(--hue-danger-ink)" }}>The two passwords don&apos;t match.</span>}
        </label>
        <Button type="submit" disabled={!ready} loading={saving} className="w-full">
          Save password and continue
        </Button>
      </form>
    </main>
  );
}
