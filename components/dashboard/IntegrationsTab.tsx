"use client";

import { useEffect, useState } from "react";
import { Cloud, CheckCircle2, AlertCircle, Folder, Loader2, RefreshCw } from "lucide-react";
import ImportPanel from "@/components/dashboard/ImportPanel";
import KioskPanel from "@/components/dashboard/KioskPanel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Sheet } from "@/components/ui/sheet";

type Status = {
  connected: boolean;
  folderId?: string | null;
  folderName?: string | null;
  connectedAt?: string;
  lastIndexedAt?: string | null;
  fileCount?: number;
};

type DriveFolder = { id?: string | null; name?: string | null };

/**
 * Google's brand blue. UI-RULES §2 bans new hex literals for CHASSIS colour —
 * this is a third-party mark, not part of our palette, so it lives here once
 * rather than being repeated at each icon.
 */
const GOOGLE_BLUE = "#4285F4";

export default function IntegrationsTab({ primaryColor, role }: { primaryColor: string; role: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

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
      setConfirmDisconnect(false);
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
        <Card className="flex items-center gap-3">
          <Loader2 className="size-4 animate-spin text-tx-3" />
          <span className="text-sm text-tx-3">Loading integrations…</span>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)]"
              style={{ background: `color-mix(in srgb, ${GOOGLE_BLUE} 12%, transparent)` }}
            >
              <Cloud className="size-5" style={{ color: GOOGLE_BLUE }} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-tx-1">Google Drive</h2>
              <p className="mt-0.5 text-xs text-tx-3">
                Read-only access to one designated folder. Used by the AI report to correlate your marketing/ops files with metrics.
              </p>
            </div>
          </div>
          {status?.connected && status.folderId && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold"
              style={{
                background: "color-mix(in srgb, var(--hue-success) 12%, transparent)",
                color: "var(--hue-success)",
              }}
            >
              <CheckCircle2 className="size-3" />
              Connected
            </span>
          )}
        </div>

        {error && (
          <div
            className="mb-3 flex items-start gap-2 rounded-[var(--r-md)] border px-3 py-2"
            style={{
              borderColor: "color-mix(in srgb, var(--hue-danger) 25%, transparent)",
              background: "color-mix(in srgb, var(--hue-danger) 6%, transparent)",
              color: "var(--hue-danger)",
            }}
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {!status?.connected ? (
          <Button onClick={connect} disabled={busy} loading={busy}>
            {!busy && <Cloud className="size-4" />}
            Connect Google Drive
          </Button>
        ) : !status.folderId ? (
          <div className="flex items-center gap-3">
            <Button onClick={openPicker} disabled={busy}>
              <Folder className="size-4" />
              Choose folder
            </Button>
            <Button variant="ghost" size="compact" onClick={() => setConfirmDisconnect(true)} disabled={busy}>
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border border-bd-default bg-sf-2 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <Folder className="size-4 shrink-0" style={{ color: GOOGLE_BLUE }} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-tx-1">{status.folderName}</p>
                  <p className="text-[11px] text-tx-4">
                    {status.fileCount ?? 0} file(s) indexed
                    {status.lastIndexedAt ? ` · last ${new Date(status.lastIndexedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="compact" onClick={reindex} disabled={busy} loading={busy}>
                {!busy && <RefreshCw className="size-3.5" />}
                Re-index folder
              </Button>
              <Button variant="secondary" size="compact" onClick={openPicker} disabled={busy}>
                <Folder className="size-3.5" />
                Change folder
              </Button>
              <Button
                variant="ghost"
                size="compact"
                onClick={() => setConfirmDisconnect(true)}
                disabled={busy}
                className="ml-auto"
                style={{ color: "var(--hue-danger)" }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </Card>

      <KioskPanel primaryColor={primaryColor} role={role} />

      <ImportPanel primaryColor={primaryColor} />

      {/* Folder picker — Sheet, not a hand-rolled overlay (UI-RULES §4a.3):
          the folder list scrolls, which is the Sheet half of the standard. */}
      <Sheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Choose a folder"
        description="The AI report reads this folder only, and only for reading."
      >
        {foldersLoading ? (
          <div className="flex items-center gap-2 px-2 py-4 text-tx-3">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Listing folders…</span>
          </div>
        ) : folders.length === 0 ? (
          <p className="py-4 text-center text-sm text-tx-3">No folders found in your Drive.</p>
        ) : (
          <ul className="space-y-1">
            {/* Both fields are nullable in the Drive payload, and folder names
                are not unique — position is the only key that always holds. */}
            {folders.map((f, i) => (
              <li key={f.id ?? `folder-${i}`}>
                <Button
                  variant="ghost"
                  onClick={() => pickFolder(f)}
                  disabled={busy}
                  className="w-full justify-start"
                >
                  <Folder className="size-4 shrink-0" style={{ color: GOOGLE_BLUE }} />
                  <span className="truncate text-sm text-tx-1">{f.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={disconnect}
        title="Disconnect Google Drive?"
        description="Indexed file content will be removed and the AI report will run without external context."
        confirmLabel="Disconnect"
        destructive
        loading={busy}
      />
    </div>
  );
}
