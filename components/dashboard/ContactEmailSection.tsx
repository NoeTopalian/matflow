"use client";

/**
 * Settings → Overview: the club's public contact email (1 Oct 2026).
 *
 * This is the one address members see and reply to. It is NOT a login:
 * owner alerts and password resets go to each staff member's own address.
 * Saved as `Tenant.contactEmail`; the billing and privacy contacts fall back
 * to it when they are empty, and every email MatFlow sends on the club's
 * behalf carries it as Reply-To (lib/email.ts).
 */
import { useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/Toast";

export function ContactEmailSection({ initialEmail }: { initialEmail: string | null }) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactEmail: email.trim() || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Couldn't save the contact email.");
        return;
      }
      toast(email.trim() ? "Contact email saved — members will see it and replies will reach it." : "Contact email cleared.", "success");
    } catch {
      setError("Couldn't reach MatFlow — nothing has changed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5 space-y-3" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" style={{ color: "var(--tx-3)" }} />
        <div>
          <p className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Contact email</p>
          <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>
            The club&apos;s public address — where members write to, and where their replies to receipts and reminders
            land. Emails still go out from MatFlow Studio; this is the reply address. It is not a login: your own
            alerts and password resets go to the email you sign in with.
          </p>
        </div>
      </div>
      <input
        aria-label="Contact email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="info@yourclub.com"
        className="w-full bg-transparent border rounded-xl px-3 py-2.5 text-sm placeholder:text-[var(--tx-4)] transition-colors"
        style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
        onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
      />
      {error && <p role="alert" className="text-xs text-[var(--hue-danger-ink)]">{error}</p>}
      <Button onClick={() => void save()} disabled={saving} size="compact">
        {saving ? "Saving…" : "Save contact email"}
      </Button>
    </div>
  );
}
