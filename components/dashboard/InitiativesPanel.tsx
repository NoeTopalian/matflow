"use client";

import { useEffect, useRef, useState } from "react";
import { Megaphone, Plus, Trash2, Paperclip, Calendar, X, FileText, Image as ImageIcon, Loader2 } from "lucide-react";

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
  const [items, setItems] = useState<Initiative[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ type: "marketing", startDate: "", endDate: "", notes: "" });

  useEffect(() => {
    fetch("/api/initiatives")
      .then((r) => r.json())
      .then((d) => Array.isArray(d) && setItems(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function createInitiative(e: React.FormEvent) {
    e.preventDefault();
    if (!form.startDate) return;
    setCreating(true);
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
      if (res.ok) {
        const created = await res.json();
        setItems((prev) => [created, ...prev]);
        setDrawerOpen(false);
        setForm({ type: "marketing", startDate: "", endDate: "", notes: "" });
      }
    } finally {
      setCreating(false);
    }
  }

  async function deleteInitiative(id: string) {
    if (!confirm("Delete this initiative? Attachments will also be removed.")) return;
    const res = await fetch(`/api/initiatives/${id}`, { method: "DELETE" });
    if (res.ok) setItems((prev) => prev.filter((i) => i.id !== id));
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-white text-xs font-semibold transition-colors"
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
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "var(--bd-default)" }}
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
                    onClick={() => deleteInitiative(it.id)}
                    className="p-1.5 rounded-lg transition-colors hover:bg-white/5"
                    style={{ color: "var(--tx-3)" }}
                    aria-label="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
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

      {drawerOpen && (
        <>
          <div className="fixed inset-0 bg-black/60 z-40" onClick={() => setDrawerOpen(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:bottom-auto md:w-full md:max-w-md z-50 rounded-t-3xl md:rounded-3xl border"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
          >
            <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
              <h3 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Add initiative</h3>
              <button onClick={() => setDrawerOpen(false)} className="text-gray-400 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={createInitiative} className="p-4 space-y-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Type</label>
                <select
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
                  <input
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
                  <input
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
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  placeholder="Optional context for the AI (budget, channel, target audience…)"
                  className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none resize-none placeholder-gray-600"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />
              </div>
              <button
                type="submit"
                disabled={creating || !form.startDate}
                className="w-full py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {creating ? "Saving…" : "Save initiative"}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

function AttachmentsRow({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <a
          key={a.id}
          href={a.blobUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-white/5"
          style={{ background: "rgba(255,255,255,0.04)", color: "var(--tx-2)" }}
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
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors hover:bg-white/5 disabled:opacity-50"
        style={{ color: "var(--tx-3)" }}
      >
        {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paperclip className="w-3 h-3" />}
        {uploading ? "Uploading…" : "Attach file"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,application/pdf"
        onChange={handleFile}
        className="hidden"
      />
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
