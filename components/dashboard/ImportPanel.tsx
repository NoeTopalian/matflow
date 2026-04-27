"use client";

import { useState } from "react";
import { Upload, FileText, Loader2, CheckCircle2, AlertCircle, Database } from "lucide-react";

const SOURCES = [
  { value: "generic", label: "Generic CSV", hint: "Standard headers: name, email, phone, dob, membership, status, joined" },
  { value: "mindbody", label: "MindBody", hint: "Client export from MindBody" },
  { value: "glofox", label: "Glofox", hint: "Member export from Glofox" },
  { value: "wodify", label: "Wodify", hint: "Athlete export from Wodify" },
] as const;

type Source = typeof SOURCES[number]["value"];

type Job = {
  id: string;
  source: string;
  fileName: string;
  status: string;
  totalRows: number;
  processedRows: number;
  importedRows: number;
  skippedRows: number;
  errorRows: number;
  errorLog: { row: number; reason: string }[] | null;
  dryRunSummary: PreviewSummary | null;
};

type PreviewSummary = {
  totalRows: number;
  validRows: number;
  errorRows: number;
  existingMatches: number;
  willImport: number;
  willSkip: number;
  sampleDrafts: { name: string; email: string; membershipType?: string }[];
  sampleErrors: { row: number; reason: string }[];
};

export default function ImportPanel({ primaryColor }: { primaryColor: string }) {
  const [source, setSource] = useState<Source>("generic");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [preview, setPreview] = useState<PreviewSummary | null>(null);
  const [busy, setBusy] = useState<"upload" | "preview" | "commit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function uploadAndPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy("upload");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("source", source);
      const upRes = await fetch("/api/admin/import/upload", { method: "POST", body: fd });
      const upData = await upRes.json();
      if (!upRes.ok) {
        setError(upData.error ?? "Upload failed");
        return;
      }
      setJob(upData);

      setBusy("preview");
      const prevRes = await fetch(`/api/admin/import/${upData.id}/preview`, { method: "POST" });
      const prevData = await prevRes.json();
      if (!prevRes.ok) {
        setError(prevData.error ?? "Preview failed");
      } else {
        setPreview(prevData);
      }
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!job) return;
    if (!confirm(`Import ${preview?.willImport ?? 0} members? Existing emails will be skipped.`)) return;
    setBusy("commit");
    setError(null);
    try {
      const res = await fetch(`/api/admin/import/${job.id}/commit`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Import failed");
      } else {
        const refreshed = await fetch(`/api/admin/import/${job.id}`).then((r) => r.json());
        setJob(refreshed);
      }
    } finally {
      setBusy(null);
    }
  }

  function reset() {
    setFile(null);
    setJob(null);
    setPreview(null);
    setError(null);
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-2" style={{ color: "var(--tx-1)" }}>
            <Database className="w-4 h-4" />
            Member CSV import
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            Migrate members from MindBody, Glofox, Wodify, or any CSV. Dry-run preview before commit. Existing emails are skipped, never overwritten.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!job ? (
        <form onSubmit={uploadAndPreview} className="space-y-3">
          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as Source)}
              className="w-full px-3 py-2.5 rounded-xl text-sm bg-transparent border outline-none"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            <p className="text-[11px] mt-1" style={{ color: "var(--tx-4)" }}>
              {SOURCES.find((s) => s.value === source)?.hint}
            </p>
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--tx-3)" }}>CSV file (max 10MB)</label>
            <input
              required
              type="file"
              accept=".csv,text/csv,application/csv,application/vnd.ms-excel"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
              style={{ color: "var(--tx-2)" }}
            />
          </div>

          <button
            type="submit"
            disabled={!file || busy !== null}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {busy === "upload" ? "Uploading…" : busy === "preview" ? "Parsing preview…" : "Upload + preview"}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border p-3 flex items-center justify-between gap-3" style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.02)" }}>
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} />
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>{job.fileName}</p>
                <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>
                  Source: {job.source} · Status: {job.status}
                </p>
              </div>
            </div>
            <button onClick={reset} className="text-[11px] hover:underline" style={{ color: "var(--tx-3)" }}>Start over</button>
          </div>

          {preview && job.status !== "complete" && (
            <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.02)" }}>
              <p className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Preview</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                <Stat label="Total rows" value={preview.totalRows} />
                <Stat label="Will import" value={preview.willImport} accent="#22c55e" />
                <Stat label="Existing (skip)" value={preview.existingMatches} accent="#f59e0b" />
                <Stat label="Errors" value={preview.errorRows} accent={preview.errorRows > 0 ? "#ef4444" : "var(--tx-3)"} />
              </div>

              {preview.sampleDrafts.length > 0 && (
                <details>
                  <summary className="text-xs cursor-pointer" style={{ color: "var(--tx-3)" }}>First 5 members</summary>
                  <ul className="mt-2 text-xs space-y-1">
                    {preview.sampleDrafts.map((d) => (
                      <li key={d.email} style={{ color: "var(--tx-2)" }}>
                        <strong>{d.name}</strong> · {d.email}{d.membershipType ? ` · ${d.membershipType}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {preview.sampleErrors.length > 0 && (
                <details>
                  <summary className="text-xs cursor-pointer" style={{ color: "#f87171" }}>{preview.sampleErrors.length} sample errors</summary>
                  <ul className="mt-2 text-xs space-y-1">
                    {preview.sampleErrors.map((e, i) => (
                      <li key={i} style={{ color: "#fda5a5" }}>Row {e.row}: {e.reason}</li>
                    ))}
                  </ul>
                </details>
              )}

              <button
                onClick={commit}
                disabled={busy !== null || preview.willImport === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
                style={{ background: primaryColor }}
              >
                {busy === "commit" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {busy === "commit" ? "Importing…" : `Import ${preview.willImport} members`}
              </button>
            </div>
          )}

          {job.status === "complete" && (
            <div className="rounded-xl border p-4" style={{ borderColor: "rgba(34,197,94,0.25)", background: "rgba(34,197,94,0.06)" }}>
              <p className="font-semibold text-sm flex items-center gap-2" style={{ color: "#22c55e" }}>
                <CheckCircle2 className="w-4 h-4" />
                Import complete
              </p>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <Stat label="Imported" value={job.importedRows} accent="#22c55e" />
                <Stat label="Skipped" value={job.skippedRows} accent="#f59e0b" />
                <Stat label="Errors" value={job.errorRows} accent={job.errorRows > 0 ? "#ef4444" : "var(--tx-3)"} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--tx-4)" }}>{label}</p>
      <p className="text-lg font-bold tabular-nums" style={{ color: accent ?? "var(--tx-1)" }}>{value}</p>
    </div>
  );
}
