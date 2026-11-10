"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Megaphone, Plus, Trash2, Paperclip, Calendar, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";

const TYPES = [
  { value: "marketing", label: "Marketing campaign", color: "#EB3163" },
  { value: "new_class", label: "New class added", color: "#67BA90" },
  { value: "price_change", label: "Price change", color: "#F59E0B" },
  { value: "holiday", label: "Holiday / closure", color: "#38BDF8" },
  { value: "coach_hired", label: "Coach hired", color: "#A78BFA" },
  { value: "other", label: "Other", color: "#94A3B8" },
] as const;

type Attachment = {
  id: string;
  blobUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

type Initiative = {
  id: string;
  type: string;
  startDate: string;
  endDate: string | null;
  notes: string | null;
  createdAt: string;
  attachments: Attachment[];
};

function typeMeta(type: string) {
  return TYPES.find((t) => t.value === type) ?? TYPES[TYPES.length - 1];
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function InitiativesPanel({ primaryColor }: { primaryColor: string }) {
  const formId = useId();
  const [items, setItems] = useState<Initiative[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ type: "marketing", startDate: "", endDate: "", notes: "" });
  // Three outcomes the list must tell apart (UI-RULES §7): loading, loaded and
  // empty, and failed to load. A failed read is never shown as "No initiatives
  // yet"; it is said, with a Retry that only re-reads.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Create and delete say when they fail and keep what was typed. Neither is
  // retried automatically: a lost response may have committed, so the message
  // says the outcome is unknown and offers a re-read of the list instead.
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { ask, dialogProps } = useConfirmDialog();
  // The Save button is disabled while it is loading, so the browser drops focus
  // to <body>. After a refused save, focus goes to the message instead, which
  // keeps it inside the dialog and reads the sentence out.
  const createErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (createError) createErrorRef.current?.focus();
  }, [createError]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/initiatives");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d: unknown = await res.json();
      if (!Array.isArray(d)) throw new Error("Unexpected response");
      setItems(d as Initiative[]);
    } catch {
      setLoadError("Couldn't load initiatives.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createInitiative(e: React.FormEvent) {
    e.preventDefault();
    if (!form.startDate) return;
    setCreating(true);
    setCreateError(null);
    let outcomeKnown = false;
    try {
      const res = await fetch("/api/initiatives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: form.type,
          startDate: form.startDate,
          endDate: form.endDate || null,
          notes: form.notes || null,
        }),
      });
      outcomeKnown = true;
      if (res.ok) {
        const created = (await res.json()) as Initiative;
        setItems((prev) => [created, ...prev]);
        setDrawerOpen(false);
        setForm({ type: "marketing", startDate: "", endDate: "", notes: "" });
      } else {
        // The route answers { error } with a plain sentence; its `details` are never shown.
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const reason = typeof body?.error === "string" ? body.error : null;
        setCreateError(reason ? `Couldn't save: ${reason}. Your entries are kept.` : "Couldn't save the initiative. Your entries are kept.");
      }
    } catch {
      // No response: it may or may not have been saved. Never say "nothing changed".
      setCreateError(
        outcomeKnown
          ? "Couldn't read the server's reply. Your entries are kept; check the list before saving again."
          : "No reply from the server, so it isn't known whether this was saved. Your entries are kept; check the list before saving again.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function deleteInitiative(id: string) {
    // §5.4: still gated — the native box became a destructive ConfirmDialog.
    const confirmed = await ask({
      title: "Delete this initiative?",
      body: "Its attachments will be removed too. This cannot be undone.",
      confirmLabel: "Delete initiative",
      destructive: true,
    });
    if (!confirmed) return;
    setDeleteError(null);
    setDeletingId(id);
    try {
      const res = await fetch(`/api/initiatives/${id}`, { method: "DELETE" });
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== id));
      } else if (res.status === 404) {
        // Already gone (another tab, or a repeat): re-read rather than guess.
        setDeleteError({ id, message: "This initiative was no longer there. The list has been refreshed." });
        void load();
      } else {
        setDeleteError({ id, message: "Couldn't delete this initiative. It is still here." });
      }
    } catch {
      setDeleteError({ id, message: "No reply from the server, so it isn't known whether this was deleted. Refresh the list to check." });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    // §1.5.1 / §4a.5: `rgba(255,255,255,0.025)` is a dark-theme leftover —
    // 2.5% white over the --sf-bg staff shell resolves to the shell, so the
    // card painted nothing and hung off its hairline border alone.
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-2" style={{ color: "var(--tx-1)" }}>
            <Megaphone className="w-4 h-4" />
            Initiatives
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            Record what you did so the AI report can correlate it with growth, attendance, and revenue.
          </p>
        </div>
        <button
          onClick={() => setDrawerOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[var(--tx-on-accent)] text-xs font-semibold transition-colors"
          style={{ background: primaryColor }}
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 py-4 px-3 rounded-xl border text-sm" style={{ borderColor: "var(--bd-default)", color: "var(--hue-danger-ink)" }} data-testid="initiatives-load-error">
          <span>{loadError}</span>
          <Button type="button" variant="secondary" size="compact" onClick={() => void load()}>Retry</Button>
        </div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center text-sm" style={{ color: "var(--tx-3)" }}>
          No initiatives yet. Click <span className="font-semibold" style={{ color: "var(--tx-2)" }}>Add</span> to record marketing, new classes, or other events.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => {
            const meta = typeMeta(it.type);
            return (
              <li
                key={it.id}
                className="rounded-xl border p-3 flex flex-col gap-2"
                style={{ background: "var(--sf-2)", borderColor: "var(--bd-default)" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ background: meta.color }} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{meta.label}</p>
                      <p className="text-xs flex items-center gap-1.5 mt-0.5" style={{ color: "var(--tx-3)" }}>
                        <Calendar className="w-3 h-3" />
                        {formatDate(it.startDate)}{it.endDate ? ` → ${formatDate(it.endDate)}` : ""}
                      </p>
                      {it.notes && <p className="text-xs mt-1.5" style={{ color: "var(--tx-2)" }}>{it.notes}</p>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteInitiative(it.id)}
                    disabled={deletingId === it.id}
                    className="p-1.5 rounded-lg transition-colors hover:bg-sf-2 disabled:opacity-50"
                    style={{ color: "var(--tx-3)" }}
                    aria-label={`Delete ${meta.label} initiative from ${formatDate(it.startDate)}`}
                  >
                    {deletingId === it.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
                {deleteError?.id === it.id && (
                  <div role="alert" className="flex items-center justify-between gap-3 text-xs" style={{ color: "var(--hue-danger-ink)" }} data-testid="initiative-delete-error">
                    <span>{deleteError.message}</span>
                    <Button type="button" variant="ghost" size="compact" onClick={() => void load()}>Refresh list</Button>
                  </div>
                )}
                {it.attachments.length > 0 && <AttachmentsRow attachments={it.attachments} />}
                <AttachmentUploader
                  initiativeId={it.id}
                  onUploaded={(att) => setItems((prev) => prev.map((p) => p.id === it.id ? { ...p, attachments: [...p.attachments, att] } : p))}
                />
              </li>
            );
          })}
        </ul>
      )}

      {/*
        Dialog (§4a.3): a short create form. The primitive supplies aria-modal,
        Escape, the focus trap and scroll lock; `createInitiative` is unchanged.
      */}
      <Dialog
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Add initiative"
        footer={
          <Button type="submit" form={formId} loading={creating} disabled={!form.startDate}>
            Save initiative
          </Button>
        }
      >
            {createError && (
              <p ref={createErrorRef} tabIndex={-1} role="alert" className="mb-3 text-sm outline-none" style={{ color: "var(--hue-danger-ink)" }} data-testid="initiative-create-error">
                {createError}
              </p>
            )}
            <form id={formId} onSubmit={createInitiative} className="space-y-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Type</label>
                <select aria-label="Type"
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                >
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Start date</label>
                  <input aria-label="Start date"
                    type="date"
                    required
                    value={form.startDate}
                    onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>End date (optional)</label>
                  <input aria-label="End date (optional)"
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                    className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Notes</label>
                <textarea aria-label="Notes"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  placeholder="Optional context for the AI (budget, channel, target audience…)"
                  className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none resize-none placeholder-gray-600"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />
              </div>
            </form>
      </Dialog>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// Audit iter-1-dashboard A4H-3: guard the blob URL against javascript:/data:
// protocols. The blobUrl comes from the API (ultimately the DB); if the
// upload route ever lets an attacker inject "javascript:..." here we'd ship
// a stored-XSS via this anchor. Only allow http/https; fall through to "#".
function safeBlobUrl(url: string | null | undefined): string {
  if (!url) return "#";
  try {
    const parsed = new URL(url, "https://example.com");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : "#";
  } catch {
    return "#";
  }
}

function AttachmentsRow({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <a
          key={a.id}
          href={safeBlobUrl(a.blobUrl)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-sf-0"
          style={{ background: "var(--sf-2)", color: "var(--tx-2)" }}
        >
          {a.mimeType.startsWith("image/") ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
          <span className="truncate max-w-[140px]">{a.filename}</span>
        </a>
      ))}
    </div>
  );
}

function AttachmentUploader({ initiativeId, onUploaded }: { initiativeId: string; onUploaded: (a: Attachment) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/initiatives/${initiativeId}/attachments`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Upload failed");
      } else {
        onUploaded(data);
      }
    } catch {
      setError("Network error");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-sf-2 disabled:opacity-50"
        style={{ color: "var(--tx-3)" }}
      >
        {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paperclip className="w-3 h-3" />}
        {uploading ? "Uploading…" : "Attach file"}
      </button>
      <input
        ref={inputRef}
        aria-label="Attach a file to this initiative"
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        onChange={handleFile}
        className="hidden"
      />
      {error && <span role="alert" className="text-xs text-[var(--hue-danger-ink)]">{error}</span>}
    </div>
  );
}
