"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Client-side trigger for DSAR export (download JSON) + erasure (POST then refresh).
 * Both wired to the existing /api/admin/dsar/{export,erase} endpoints.
 */
export default function DsarActions({
  memberId,
  action,
  disabled,
}: {
  memberId: string;
  action: "export" | "erase";
  disabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function doExport() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/admin/dsar/export?memberId=${encodeURIComponent(memberId)}`);
      if (!res.ok) {
        setError(`Export failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `matflow-dsar-${memberId}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
      setTimeout(() => setDone(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function doErase() {
    if (!confirm("Erase this member? This cannot be undone.")) return;
    if (!confirm("Final confirmation — PII will be scrubbed irreversibly. Continue?")) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/admin/dsar/erase?memberId=${encodeURIComponent(memberId)}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Erase failed (${res.status})`);
        return;
      }
      setDone(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (action === "export") {
    return (
      <div>
        <button
          onClick={doExport}
          disabled={busy}
          className="px-4 py-2 rounded-xl font-semibold text-white text-sm disabled:opacity-50"
          style={{ background: "var(--color-primary)" }}
        >
          {busy ? "Exporting…" : "Download JSON"}
        </button>
        {done && <p className="mt-2 text-xs" style={{ color: "#10b981" }}>Downloaded ✓</p>}
        {error && <p className="mt-2 text-xs" style={{ color: "#ef4444" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={doErase}
        disabled={busy || disabled}
        className="px-4 py-2 rounded-xl font-semibold text-white text-sm disabled:opacity-30"
        style={{ background: "#dc2626" }}
      >
        {busy ? "Erasing…" : disabled ? "Already erased" : "Forget this member"}
      </button>
      {done && <p className="mt-2 text-xs" style={{ color: "#10b981" }}>Member erased ✓</p>}
      {error && <p className="mt-2 text-xs" style={{ color: "#ef4444" }}>{error}</p>}
    </div>
  );
}
