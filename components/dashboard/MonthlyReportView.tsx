"use client";

import { useEffect, useState } from "react";
import { Sparkles, RefreshCw, FileText, AlertCircle, Loader2, ChevronDown, ChevronUp } from "lucide-react";

type Report = {
  id: string;
  periodStart: string;
  periodEnd: string;
  generationType: string;
  modelUsed: string;
  costPence: number;
  summary: string;
  wins: string;
  watchOuts: string;
  recommendations: string;
  generatedAt: string;
};

function formatPeriod(start: string, end: string) {
  const s = new Date(start);
  return `${s.toLocaleString("en-GB", { month: "long", year: "numeric" })}`;
}

function MarkdownBullets({ text }: { text: string }) {
  if (!text || text.trim() === "—") return <p className="text-sm" style={{ color: "var(--tx-3)" }}>—</p>;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    <ul className="space-y-1.5 text-sm" style={{ color: "var(--tx-2)" }}>
      {lines.map((line, i) => {
        const stripped = line.replace(/^[-*•]\s*/, "");
        return (
          <li key={i} className="flex gap-2">
            <span className="shrink-0" style={{ color: "var(--tx-4)" }}>•</span>
            <span>{stripped}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function MonthlyReportView({ primaryColor }: { primaryColor: string }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/reports/generate")
      .then((r) => r.ok ? r.json() : [])
      .then((d) => {
        if (Array.isArray(d)) {
          setReports(d);
          if (d.length > 0) setExpandedId(d[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function generateNow() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/generate", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Generation failed");
      } else {
        setReports((prev) => [data, ...prev]);
        setExpandedId(data.id);
      }
    } catch {
      setError("Network error");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-2" style={{ color: "var(--tx-1)" }}>
            <Sparkles className="w-4 h-4" />
            AI Monthly Report
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            Causal analysis correlating your initiatives with growth, attendance, and revenue.
          </p>
        </div>
        <button
          onClick={generateNow}
          disabled={generating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-white text-xs font-semibold transition-colors disabled:opacity-60"
          style={{ background: primaryColor }}
        >
          {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {generating ? "Generating…" : "Generate now"}
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: "rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.06)", color: "#f87171" }}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading reports…</span>
        </div>
      ) : reports.length === 0 ? (
        <div className="py-8 text-center text-sm" style={{ color: "var(--tx-3)" }}>
          No reports yet. Click <span className="font-semibold" style={{ color: "var(--tx-2)" }}>Generate now</span> to create your first AI causal-analysis report.
        </div>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => {
            const isOpen = expandedId === r.id;
            return (
              <li
                key={r.id}
                className="rounded-xl border overflow-hidden"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "var(--bd-default)" }}
              >
                <button
                  onClick={() => setExpandedId(isOpen ? null : r.id)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{formatPeriod(r.periodStart, r.periodEnd)}</p>
                      <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
                        {r.generationType === "auto" ? "Auto" : "On-demand"} · {r.modelUsed} · {(r.costPence / 100).toFixed(2)}p
                      </p>
                    </div>
                  </div>
                  {isOpen ? <ChevronUp className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} /> : <ChevronDown className="w-4 h-4 shrink-0" style={{ color: "var(--tx-3)" }} />}
                </button>
                {isOpen && (
                  <div className="px-4 pb-4 space-y-4 border-t" style={{ borderColor: "var(--bd-default)" }}>
                    <Section title="Summary" body={r.summary} />
                    <Section title="Wins" bullets={r.wins} />
                    <Section title="Watch-outs" bullets={r.watchOuts} />
                    <Section title="Recommendations" bullets={r.recommendations} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Section({ title, body, bullets }: { title: string; body?: string; bullets?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider font-semibold mb-1.5 mt-3" style={{ color: "var(--tx-3)" }}>{title}</p>
      {body !== undefined ? (
        <p className="text-sm leading-relaxed" style={{ color: "var(--tx-2)" }}>{body || "—"}</p>
      ) : bullets !== undefined ? (
        <MarkdownBullets text={bullets} />
      ) : null}
    </div>
  );
}
