"use client";

import { useState, useRef, useEffect } from "react";
import {
  BrainCircuit,
  TrendingUp,
  TrendingDown,
  Users,
  CalendarCheck,
  Dumbbell,
  Send,
  RefreshCw,
  Download,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import DonutChart, { DonutLegend, type DonutSlice } from "@/components/dashboard/charts/DonutChart";
import Sparkline from "@/components/dashboard/charts/Sparkline";

const HERO_PALETTE = ["#67BA90", "#EB3163", "#C9F990", "#8E1F57", "#224541"];
const STATUS_COLORS: Record<string, string> = { active: "#67BA90", taster: "#C9F990", inactive: "#EB3163", cancelled: "#8E1F57" };

// ─── Types ────────────────────────────────────────────────────────────────────

interface Metrics {
  totalMembers: number;
  newThisMonth: number;
  newLastMonth: number;
  checkinsThisMonth: number;
  checkinsLastMonth: number;
  activeClasses: number;
  monthLabel: string;
  gymName: string;
  membersByStatus?: { status: string; label: string; count: number }[];
  monthlyTrend?: { label: string; value: number }[];
}

interface Props {
  metrics: Metrics;
  primaryColor: string;
}

type Stage = "idle" | "interview" | "generating" | "report";

interface QA { question: string; answer: string }

// ─── Interview questions ───────────────────────────────────────────────────────

const QUESTIONS = [
  "How many new members joined through word-of-mouth or referrals this month?",
  "Did you run any special events, promotions, or challenges? If so, what happened?",
  "What's the biggest challenge you're facing right now — retention, marketing, space, staff?",
  "How would you rate the energy and morale in the gym this month (1–10)? What's driving that?",
  "What's your main goal for next month?",
];

// ─── Report generator ─────────────────────────────────────────────────────────

function buildReport(metrics: Metrics, answers: string[]): string {
  const growthDir = metrics.newThisMonth >= metrics.newLastMonth ? "up" : "down";
  const growthDiff = Math.abs(metrics.newThisMonth - metrics.newLastMonth);
  const checkinDir = metrics.checkinsThisMonth >= metrics.checkinsLastMonth ? "up" : "down";
  const checkinDiff = Math.abs(metrics.checkinsThisMonth - metrics.checkinsLastMonth);
  const engagementRate = metrics.totalMembers > 0
    ? Math.round((metrics.checkinsThisMonth / metrics.totalMembers) * 100)
    : 0;

  const referrals = answers[0] || "not specified";
  const events = answers[1] || "none reported";
  const challenges = answers[2] || "none reported";
  const morale = answers[3] || "not rated";
  const goal = answers[4] || "not specified";

  const lines: string[] = [];

  lines.push(`# Monthly Analysis — ${metrics.monthLabel}`);
  lines.push(`**${metrics.gymName}**`);
  lines.push("");
  lines.push("## Overview");
  lines.push(
    `This month ${metrics.gymName} maintained ${metrics.totalMembers} active members across ${metrics.activeClasses} classes. ` +
    `You recorded ${metrics.checkinsThisMonth} check-ins — ${checkinDir === "up" ? `${checkinDiff} more than` : `${checkinDiff} fewer than`} last month — ` +
    `giving an engagement rate of approximately ${engagementRate}% of your membership base.`
  );
  lines.push("");
  lines.push("## Member Growth");
  lines.push(
    `**${metrics.newThisMonth} new members** joined this month, compared to ${metrics.newLastMonth} last month ` +
    `(${growthDir === "up" ? `+${growthDiff} ↑` : `-${growthDiff} ↓`}). ` +
    (metrics.newThisMonth > 0
      ? `You reported that approximately ${referrals} of these came via referrals or word-of-mouth, which is a strong signal of community health.`
      : `No new members were added this month. This is worth investigating — consider a referral campaign or introductory offer.`)
  );
  lines.push("");
  lines.push("## Attendance & Engagement");
  lines.push(
    `With ${metrics.checkinsThisMonth} total check-ins and ${metrics.totalMembers} active members, ` +
    `the average member attended roughly ${metrics.totalMembers > 0 ? (metrics.checkinsThisMonth / metrics.totalMembers).toFixed(1) : "0"} classes this month. ` +
    (engagementRate >= 60
      ? "This is a healthy engagement level — your members are showing up consistently."
      : engagementRate >= 35
      ? "Engagement is moderate. Look at who hasn't checked in recently and consider a personal outreach."
      : "Engagement is below target. A focused retention push — text reminders, challenges, or buddy systems — could help significantly.")
  );
  lines.push("");
  lines.push("## Events & Promotions");
  lines.push(events !== "none reported"
    ? `This month you ran: **${events}**. These kinds of activities build community and retention — keep tracking their impact on attendance in the weeks following.`
    : "No specific events were reported this month. Consider whether a small competition prep, seminar, or challenge could boost engagement and give members something to train towards."
  );
  lines.push("");
  lines.push("## Challenges");
  lines.push(`You identified **${challenges}** as the main challenge right now. This is common at this stage of growth. ` +
    (challenges.toLowerCase().includes("retain")
      ? "Focus on personal connection — a quick check-in text to members who haven't attended in 2+ weeks can recover a meaningful portion."
      : challenges.toLowerCase().includes("market")
      ? "Consider doubling down on referral incentives and local partnerships (sports shops, physios, schools) rather than paid ads."
      : "Addressing this directly in your monthly planning session will set a clear priority for the team.")
  );
  lines.push("");
  lines.push("## Morale & Culture");
  lines.push(`You rated gym morale at **${morale}**. ` +
    (morale.includes("8") || morale.includes("9") || morale.includes("10")
      ? "That's excellent — a positive culture is your strongest retention tool. Capture what's working and be intentional about maintaining it as you grow."
      : morale.includes("6") || morale.includes("7")
      ? "Good, with room to improve. Consider whether any members or coaches need more recognition or support."
      : "There's an opportunity here. Small culture investments — shoutouts, milestones, social events — often have outsized impact on retention and word-of-mouth.")
  );
  lines.push("");
  lines.push("## Next Month Focus");
  lines.push(`Your stated goal: **${goal}**. Based on this month's data, the highest-leverage actions to support that goal are:`);
  lines.push("");
  lines.push(`- Follow up personally with any members who haven't checked in for 2+ weeks`);
  if (metrics.newThisMonth < metrics.newLastMonth) {
    lines.push(`- Run a referral incentive — existing members are your cheapest acquisition channel`);
  }
  if (engagementRate < 50) {
    lines.push(`- Introduce a monthly class challenge or attendance milestone to drive consistency`);
  }
  lines.push(`- Review class schedule utilisation — are your ${metrics.activeClasses} classes at the right times?`);
  lines.push("");
  lines.push("---");
  lines.push("*Generated by MatFlow AI · Based on your gym data + your answers*");

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delta(current: number, previous: number) {
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct;
}

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function renderStrongText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-white">{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function ReportMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="space-y-3 text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.85)" }}>
      {lines.map((line, i) => {
        if (line.startsWith("# ")) {
          return <h1 key={i} className="text-xl font-bold text-white mt-2">{line.replace("# ", "")}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} className="text-base font-semibold text-white mt-5 mb-1">{line.replace("## ", "")}</h2>;
        }
        if (line.startsWith("**") && line.endsWith("**") && line.length < 60) {
          return <p key={i} className="font-semibold" style={{ color: "rgba(255,255,255,0.7)" }}>{line.replace(/\*\*/g, "")}</p>;
        }
        if (line.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-2">
              <span style={{ color: "rgba(255,255,255,0.3)" }}>·</span>
              <span>{renderStrongText(line.replace("- ", ""))}</span>
            </div>
          );
        }
        if (line.startsWith("---")) {
          return <hr key={i} style={{ borderColor: "rgba(0,0,0,0.10)", marginTop: 16 }} />;
        }
        if (line.startsWith("*") && line.endsWith("*")) {
          return <p key={i} className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>{line.replace(/\*/g, "")}</p>;
        }
        if (line === "") return <div key={i} className="h-1" />;
        return (
          <p key={i}>{renderStrongText(line)}</p>
        );
      })}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnalysisView({ metrics, primaryColor }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [qIndex, setQIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState("");
  const [report, setReport] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const memberDelta = delta(metrics.newThisMonth, metrics.newLastMonth);
  const checkinDelta = delta(metrics.checkinsThisMonth, metrics.checkinsLastMonth);
  const engagementRate = metrics.totalMembers > 0
    ? Math.round((metrics.checkinsThisMonth / metrics.totalMembers) * 100)
    : 0;

  useEffect(() => {
    if (stage === "interview") inputRef.current?.focus();
  }, [stage, qIndex]);

  function startInterview() {
    setStage("interview");
    setQIndex(0);
    setAnswers([]);
    setCurrentAnswer("");
  }

  function submitAnswer() {
    const trimmed = currentAnswer.trim();
    if (!trimmed) return;
    const next = [...answers, trimmed];
    setAnswers(next);
    setCurrentAnswer("");

    if (qIndex + 1 < QUESTIONS.length) {
      setQIndex(qIndex + 1);
    } else {
      // All questions answered — generate report
      setStage("generating");
      setTimeout(() => {
        setReport(buildReport(metrics, next));
        setStage("report");
      }, 1800);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAnswer();
    }
  }

  function downloadReport() {
    const blob = new Blob([report], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `MatFlow-Report-${metrics.monthLabel.replace(" ", "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Analysis</h1>
          <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>
            {metrics.monthLabel} · AI Monthly Report
          </p>
        </div>
        <div
          className="w-10 h-10 rounded-2xl flex items-center justify-center"
          style={{ background: hex(primaryColor, 0.12) }}
        >
          <BrainCircuit className="w-5 h-5" style={{ color: primaryColor }} />
        </div>
      </div>

      {/* Hero charts — donut (member status mix) + sparkline (6-month check-in trend) */}
      {(metrics.membersByStatus?.length || metrics.monthlyTrend?.length) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-2xl border p-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider" style={{ color: "rgba(255,255,255,0.45)" }}>Member mix</p>
                <p className="text-sm font-semibold text-white mt-0.5">By status</p>
              </div>
              <Users className="w-4 h-4" style={{ color: "rgba(255,255,255,0.4)" }} />
            </div>
            {metrics.membersByStatus && metrics.membersByStatus.length > 0 ? (
              <div className="flex items-center gap-4">
                <DonutChart
                  data={metrics.membersByStatus.map((m, i): DonutSlice => ({
                    label: m.label,
                    value: m.count,
                    color: STATUS_COLORS[m.status] ?? HERO_PALETTE[i % HERO_PALETTE.length],
                  }))}
                  size={130}
                  thickness={20}
                  centerValue={String(metrics.totalMembers)}
                  centerLabel="Total"
                />
                <div className="flex-1 min-w-0">
                  <DonutLegend data={metrics.membersByStatus.map((m, i): DonutSlice => ({
                    label: m.label,
                    value: m.count,
                    color: STATUS_COLORS[m.status] ?? HERO_PALETTE[i % HERO_PALETTE.length],
                  }))} />
                </div>
              </div>
            ) : (
              <p className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>No member data yet</p>
            )}
          </div>

          <div className="rounded-2xl border p-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider" style={{ color: "rgba(255,255,255,0.45)" }}>Engagement trend</p>
                <p className="text-sm font-semibold text-white mt-0.5">6-month check-ins</p>
              </div>
              <CalendarCheck className="w-4 h-4" style={{ color: "rgba(255,255,255,0.4)" }} />
            </div>
            {metrics.monthlyTrend && metrics.monthlyTrend.length > 0 ? (
              <Sparkline data={metrics.monthlyTrend} width={320} height={130} />
            ) : (
              <p className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>No attendance data yet</p>
            )}
          </div>
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3">
        {[
          {
            label: "Active Members",
            value: metrics.totalMembers,
            sub: `${metrics.newThisMonth} new this month`,
            icon: Users,
            pct: memberDelta,
          },
          {
            label: "Check-ins",
            value: metrics.checkinsThisMonth,
            sub: "this month",
            icon: CalendarCheck,
            pct: checkinDelta,
          },
          {
            label: "Engagement",
            value: `${engagementRate}%`,
            sub: "members active",
            icon: TrendingUp,
            pct: null,
          },
          {
            label: "Active Classes",
            value: metrics.activeClasses,
            sub: "on the schedule",
            icon: Dumbbell,
            pct: null,
          },
        ].map(({ label, value, sub, icon: Icon, pct }) => (
          <div
            key={label}
            className="rounded-2xl border p-4"
            style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
          >
            <div className="flex items-start justify-between mb-3">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center"
                style={{ background: hex(primaryColor, 0.1) }}
              >
                <Icon className="w-4 h-4" style={{ color: primaryColor }} />
              </div>
              {pct !== null && (
                <div
                  className="flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full"
                  style={{
                    background: pct >= 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                    color: pct >= 0 ? "#22c55e" : "#ef4444",
                  }}
                >
                  {pct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {pct >= 0 ? "+" : ""}{pct}%
                </div>
              )}
            </div>
            <p className="text-white text-2xl font-bold tracking-tight leading-none">{value}</p>
            <p className="text-xs mt-1" style={{ color: "rgba(0,0,0,0.40)" }}>{label}</p>
            <p className="text-[11px] mt-0.5" style={{ color: "rgba(255,255,255,0.2)" }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* Main panel */}
      {stage === "idle" && (
        <div
          className="rounded-3xl border p-6 text-center space-y-4"
          style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto"
            style={{ background: hex(primaryColor, 0.1) }}
          >
            <Sparkles className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <div>
            <p className="text-white font-semibold text-lg">Generate Your Monthly Report</p>
            <p className="text-sm mt-1.5 max-w-sm mx-auto" style={{ color: "rgba(255,255,255,0.4)" }}>
              The AI will ask you {QUESTIONS.length} quick questions about things it can&apos;t see in your data,
              then synthesise a full written report with recommendations.
            </p>
          </div>
          <button
            onClick={startInterview}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl font-semibold text-sm text-white transition-all active:scale-95"
            style={{ background: primaryColor }}
          >
            Start Report
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {stage === "interview" && (
        <div
          className="rounded-3xl border overflow-hidden"
          style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
        >
          {/* Progress bar */}
          <div className="h-1" style={{ background: "rgba(0,0,0,0.04)" }}>
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${((qIndex) / QUESTIONS.length) * 100}%`,
                background: primaryColor,
              }}
            />
          </div>

          <div className="p-6 space-y-5">
            {/* Previous QAs */}
            {answers.map((ans, i) => (
              <div key={i} className="space-y-2">
                <p className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.3)" }}>
                  Q{i + 1} · {QUESTIONS[i]}
                </p>
                <p
                  className="text-sm px-3 py-2 rounded-xl"
                  style={{ background: "rgba(0,0,0,0.03)", color: "rgba(255,255,255,0.7)" }}
                >
                  {ans}
                </p>
              </div>
            ))}

            {/* Current question */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                  style={{ background: primaryColor, color: "white" }}
                >
                  {qIndex + 1}
                </div>
                <p className="text-sm font-medium text-white">{QUESTIONS[qIndex]}</p>
              </div>

              <div className="relative">
                <textarea
                  ref={inputRef}
                  value={currentAnswer}
                  onChange={(e) => setCurrentAnswer(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your answer… (Enter to submit)"
                  rows={2}
                  className="w-full resize-none rounded-2xl px-4 py-3 pr-12 text-sm text-white placeholder-gray-600 outline-none transition-all"
                  style={{
                    background: "rgba(0,0,0,0.04)",
                    border: `1px solid rgba(0,0,0,0.10)`,
                    lineHeight: 1.6,
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = hex(primaryColor, 0.4); }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(0,0,0,0.10)"; }}
                />
                <button
                  onClick={submitAnswer}
                  disabled={!currentAnswer.trim()}
                  className="absolute right-2.5 bottom-2.5 w-8 h-8 rounded-xl flex items-center justify-center transition-all active:scale-90 disabled:opacity-30"
                  style={{ background: primaryColor }}
                  aria-label="Submit answer"
                >
                  <Send className="w-3.5 h-3.5 text-white" />
                </button>
              </div>
              <p className="text-[11px] mt-1.5" style={{ color: "rgba(255,255,255,0.2)" }}>
                Question {qIndex + 1} of {QUESTIONS.length}
              </p>
            </div>
          </div>
        </div>
      )}

      {stage === "generating" && (
        <div
          className="rounded-3xl border p-10 flex flex-col items-center gap-4"
          style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: hex(primaryColor, 0.1) }}
          >
            <BrainCircuit className="w-7 h-7 animate-pulse" style={{ color: primaryColor }} />
          </div>
          <div className="text-center">
            <p className="text-white font-semibold">Analysing your data…</p>
            <p className="text-sm mt-1" style={{ color: "rgba(0,0,0,0.40)" }}>
              Combining your metrics with your answers
            </p>
          </div>
        </div>
      )}

      {stage === "report" && (
        <div
          className="rounded-3xl border overflow-hidden"
          style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
        >
          {/* Report header */}
          <div
            className="px-6 py-4 flex items-center justify-between border-b"
            style={{ borderColor: "rgba(0,0,0,0.08)" }}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" style={{ color: primaryColor }} />
              <span className="text-sm font-semibold text-white">Monthly Report</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={downloadReport}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all active:scale-95"
                style={{ background: "rgba(0,0,0,0.08)", color: "rgba(255,255,255,0.6)" }}
              >
                <Download className="w-3.5 h-3.5" />
                Export
              </button>
              <button
                onClick={() => setStage("idle")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all active:scale-95"
                style={{ background: "rgba(0,0,0,0.08)", color: "rgba(255,255,255,0.6)" }}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Regenerate
              </button>
            </div>
          </div>

          <div className="px-6 py-5">
            <ReportMarkdown content={report} />
          </div>
        </div>
      )}
    </div>
  );
}
