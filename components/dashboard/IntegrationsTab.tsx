"use client";

import { useEffect, useState } from "react";
import { Cloud, CheckCircle2, AlertCircle, Folder, Loader2, RefreshCw, X } from "lucide-react";

type Status = {
  connected: boolean;
  folderId?: string | null;
  folderName?: string | null;
  connectedAt?: string;
  lastIndexedAt?: string | null;
  fileCount?: number;
};

type DriveFolder = { id?: string | null; name?: string | null };

export default function IntegrationsTab({ primaryColor }: { primaryColor: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshStatus() {
    setLoading(true);
    try {
      const res = await fetch("/api/drive/status");
      const data = await res.json();
      setStatus(data);
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/drive/connect");
      const data = await res.json();
      if (!res.ok || !data.url) {
        setError(data.error ?? "Could not start Google OAuth");
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network error");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect Google Drive? Indexed file content will be removed and the AI report will run without external context.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/drive/disconnect", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Disconnect failed");
      } else {
        await refreshStatus();
      }
    } finally {
      setBusy(false);
    }
  }

  async function openPicker() {
    setPickerOpen(true);
    setFoldersLoading(true);
    try {
      const res = await fetch("/api/drive/folders");
      const data = await res.json();
      setFolders(Array.isArray(data) ? data : []);
    } catch {
      setFolders([]);
    } finally {
      setFoldersLoading(false);
    }
  }

  async function pickFolder(folder: DriveFolder) {
    if (!folder.id || !folder.name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/drive/select-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: folder.id, folderName: folder.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to select folder");
      } else {
        setPickerOpen(false);
        await refreshStatus();
      }
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/drive/index", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Re-index failed");
      } else {
        await refreshStatus();
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border p-5 flex items-center gap-3" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--tx-3)" }} />
          <span className="text-sm" style={{ color: "var(--tx-3)" }}>Loading integrations…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "rgba(66,133,244,0.12)" }}>
              <Cloud className="w-5 h-5" style={{ color: "#4285F4" }} />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Google Drive</h2>
              <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
                Read-only access to one designated folder. Used by the AI report to correlate your marketing/ops files with metrics.
              </p>
            </div>
          </div>
          {status?.connected && status.folderId && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold" style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e" }}>
              <CheckCircle2 className="w-3 h-3" />
              Connected
            </span>
          )}
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {!status?.connected ? (
          <button
            onClick={connect}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors disabled:opacity-60"
            style={{ background: primaryColor }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
            Connect Google Drive
          </button>
        ) : !status.folderId ? (
          <div className="flex items-center gap-3">
            <button
              onClick={openPicker}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold transition-colors disabled:opacity-60"
              style={{ background: primaryColor }}
            >
              <Folder className="w-4 h-4" />
              Choose folder
            </button>
            <button
              onClick={disconnect}
              disabled={busy}
              className="text-xs hover:underline"
              style={{ color: "var(--tx-3)" }}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border px-3 py-2.5 flex items-center justify-between gap-3" style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.02)" }}>
              <div className="flex items-center gap-2 min-w-0">
                <Folder className="w-4 h-4 shrink-0" style={{ color: "#4285F4" }} />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{status.folderName}</p>
                  <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
                    {status.fileCount ?? 0} file(s) indexed
                    {status.lastIndexedAt ? ` · last ${new Date(status.lastIndexedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={reindex}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors hover:bg-white/[0.04] disabled:opacity-60"
                style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Re-index folder
              </button>
              <button
                onClick={openPicker}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors hover:bg-white/[0.04] disabled:opacity-60"
                style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
              >
                <Folder className="w-3.5 h-3.5" />
                Change folder
              </button>
              <button
                onClick={disconnect}
                disabled={busy}
                className="ml-auto text-xs hover:underline disabled:opacity-60"
                style={{ color: "#f87171" }}
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>

      {pickerOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setPickerOpen(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:bottom-auto md:w-full md:max-w-md z-50 rounded-t-3xl md:rounded-3xl border max-h-[80vh] flex flex-col"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
          >
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
              <h3 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Choose a folder</h3>
              <button onClick={() => setPickerOpen(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {foldersLoading ? (
                <div className="flex items-center gap-2 px-2 py-4" style={{ color: "var(--tx-3)" }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Listing folders…</span>
                </div>
              ) : folders.length === 0 ? (
                <p className="text-sm py-4 text-center" style={{ color: "var(--tx-3)" }}>No folders found in your Drive.</p>
              ) : (
                <ul className="space-y-1">
                  {folders.map((f) => (
                    <li key={f.id ?? Math.random()}>
                      <button
                        onClick={() => pickFolder(f)}
                        disabled={busy}
                        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl text-left transition-colors hover:bg-white/[0.04] disabled:opacity-60"
                      >
                        <Folder className="w-4 h-4 shrink-0" style={{ color: "#4285F4" }} />
                        <span className="text-sm truncate" style={{ color: "var(--tx-1)" }}>{f.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
