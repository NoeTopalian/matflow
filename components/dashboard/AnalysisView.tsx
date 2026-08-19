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
import { hex, readableOn } from "@/lib/color";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/page-header";
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
  // Distinct member IDs that checked in at least once this month. Used for
  // the bounded engagement % (was incorrectly checkins/members which exceeded 100%).
  activeMembersThisMonth: number;
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
  // Engagement = % of members with ≥1 check-in this month (bounded 0..100).
  const engagementRate = metrics.totalMembers > 0
    ? Math.min(100, Math.round((metrics.activeMembersThisMonth / metrics.totalMembers) * 100))
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

function renderStrongText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold" style={{ color: "var(--tx-1)" }}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function ReportMarkdown({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="space-y-3 text-sm leading-relaxed" style={{ color: "var(--tx-1)" }}>
      {lines.map((line, i) => {
        if (line.startsWith("# ")) {
          return <h1 key={i} className="text-xl font-bold mt-2" style={{ color: "var(--tx-1)" }}>{line.replace("# ", "")}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} className="text-base font-semibold mt-5 mb-1" style={{ color: "var(--tx-1)" }}>{line.replace("## ", "")}</h2>;
        }
        if (line.startsWith("**") && line.endsWith("**") && line.length < 60) {
          return <p key={i} className="font-semibold" style={{ color: "var(--tx-2)" }}>{line.replace(/\*\*/g, "")}</p>;
        }
        if (line.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-2">
              <span style={{ color: "var(--tx-4)" }}>·</span>
              <span>{renderStrongText(line.replace("- ", ""))}</span>
            </div>
          );
        }
        if (line.startsWith("---")) {
          return <hr key={i} style={{ borderColor: "var(--bd-default)", marginTop: 16 }} />;
        }
        if (line.startsWith("*") && line.endsWith("*")) {
          return <p key={i} className="text-xs" style={{ color: "var(--tx-4)" }}>{line.replace(/\*/g, "")}</p>;
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
  // Engagement = % of members with ≥1 check-in this month (bounded 0..100).
  const engagementRate = metrics.totalMembers > 0
    ? Math.min(100, Math.round((metrics.activeMembersThisMonth / metrics.totalMembers) * 100))
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
    <div className="w-full">
      {/* §4: the one PageHeader treatment — no per-page heading inventions. */}
      <PageHeader
        title="Analysis"
        description={`${metrics.monthLabel} · AI monthly report`}
        action={
          <div
            className="flex size-10 items-center justify-center rounded-[var(--r-md)]"
            style={{ background: hex(primaryColor, 0.12) }}
          >
            <BrainCircuit
              className="size-5"
              style={{ color: primaryColor }}
              aria-hidden="true"
            />
          </div>
        }
      />

      {/* Hero charts — donut (member status mix) + sparkline (6-month check-in
          trend). Full width: both read better wide, and the split below owns
          the working area. */}
      {(metrics.membersByStatus?.length || metrics.monthlyTrend?.length) && (
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card padding="tight">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--tx-3)" }}>Member mix</p>
                <p className="text-sm font-semibold mt-0.5" style={{ color: "var(--tx-1)" }}>By status</p>
              </div>
              <Users className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
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
              <p className="text-sm" style={{ color: "var(--tx-3)" }}>No member data yet</p>
            )}
          </Card>

          <Card padding="tight">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider" style={{ color: "var(--tx-3)" }}>Engagement trend</p>
                <p className="text-sm font-semibold mt-0.5" style={{ color: "var(--tx-1)" }}>6-month check-ins</p>
              </div>
              <CalendarCheck className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
            </div>
            {metrics.monthlyTrend && metrics.monthlyTrend.length > 0 ? (
              <div className="w-full">
                <Sparkline data={metrics.monthlyTrend} width={320} height={130} />
              </div>
            ) : (
              <p className="text-sm" style={{ color: "var(--tx-3)" }}>No attendance data yet</p>
            )}
          </Card>
        </div>
      )}

      {/*
        §4a.2 structural split at `lg:`, not `xl:` — the 240px sidebar leaves a
        ~1000px content box on a 1366px laptop, which is plenty for a working
        column plus a metrics rail. `minmax(0,…)` on the flexible track is the
        blowout guard. Below `lg:` the rail comes FIRST in the DOM so the
        original mobile order (metrics, then the report panel) is preserved.
      */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Metric cards */}
        <aside className="grid grid-cols-2 gap-3 lg:order-2 lg:grid-cols-1 lg:content-start">
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
          <Card key={label} padding="tight">
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
                    background: pct >= 0 ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
                    color: pct >= 0 ? "var(--hue-success)" : "var(--hue-danger)",
                  }}
                >
                  {pct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {pct >= 0 ? "+" : ""}{pct}%
                </div>
              )}
            </div>
            <p className="text-2xl font-bold tracking-tight leading-none" style={{ color: "var(--tx-1)" }}>{value}</p>
            <p className="text-xs mt-1" style={{ color: "var(--tx-3)" }}>{label}</p>
            <p className="text-[11px] mt-0.5" style={{ color: "var(--tx-4)" }}>{sub}</p>
          </Card>
        ))}
        </aside>

        {/* Working column — the interview and the generated report. */}
        <div className="lg:order-1">
      {stage === "idle" && (
        /* §5 EmptyState — this also retires the last `max-w-* mx-auto` in the
           dashboard scope, which was this panel's centred paragraph. */
        <Card>
          <EmptyState
            icon={
              <div
                className="mx-auto flex size-14 items-center justify-center rounded-[var(--r-md)]"
                style={{ background: hex(primaryColor, 0.1) }}
              >
                <Sparkles className="size-7" style={{ color: primaryColor }} />
              </div>
            }
            title="Generate your monthly report"
            hint={`The AI will ask you ${QUESTIONS.length} quick questions about things it can't see in your data, then synthesise a full written report with recommendations.`}
            action={
              <Button onClick={startInterview}>
                Start report
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </Card>
      )}

      {stage === "interview" && (
        <Card padding="none" className="overflow-hidden">
          {/* Progress bar */}
          <div className="h-1" style={{ background: "var(--sf-2)" }}>
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
                <p className="text-xs font-medium" style={{ color: "var(--tx-4)" }}>
                  Q{i + 1} · {QUESTIONS[i]}
                </p>
                {/* §4a.5: --sf-1 on an --sf-1 card painted nothing on the
                    light shell — the answer bubbles were invisible. */}
                <p
                  className="text-sm px-3 py-2 rounded-[var(--r-md)]"
                  style={{ background: "var(--sf-2)", color: "var(--tx-2)" }}
                >
                  {ans}
                </p>
              </div>
            ))}

            {/* Current question */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                {/* §2a: text on a tenant-accent fill comes from readableOn(),
                    never hardcoded white — a #ffe14d gym had white-on-yellow. */}
                <div
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
                  style={{ background: primaryColor, color: readableOn(primaryColor) }}
                >
                  {qIndex + 1}
                </div>
                <p className="text-sm font-medium" style={{ color: "var(--tx-1)" }}>{QUESTIONS[qIndex]}</p>
              </div>

              <div className="relative">
                <textarea aria-label="Your answer"
                  ref={inputRef}
                  value={currentAnswer}
                  onChange={(e) => setCurrentAnswer(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your answer… (Enter to submit)"
                  rows={2}
                  className="w-full resize-none rounded-[var(--r-md)] px-4 py-3 pr-12 text-sm placeholder:text-[var(--tx-3)] outline-none transition-all"
                  style={{
                    color: "var(--tx-1)",
                    background: "var(--sf-2)",
                    border: `1px solid var(--bd-default)`,
                    lineHeight: 1.6,
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = hex(primaryColor, 0.4); }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
                />
                <Button
                  size="compact"
                  onClick={submitAnswer}
                  disabled={!currentAnswer.trim()}
                  aria-label="Submit answer"
                  className="absolute right-2.5 bottom-2.5 size-8 p-0"
                >
                  <Send className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
              <p className="text-[11px] mt-1.5" style={{ color: "var(--tx-4)" }}>
                Question {qIndex + 1} of {QUESTIONS.length}
              </p>
            </div>
          </div>
        </Card>
      )}

      {stage === "generating" && (
        <Card className="flex flex-col items-center gap-4 py-10">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: hex(primaryColor, 0.1) }}
          >
            <BrainCircuit className="w-7 h-7 animate-pulse" style={{ color: primaryColor }} />
          </div>
          <div className="text-center">
            <p className="font-semibold" style={{ color: "var(--tx-1)" }}>Analysing your data…</p>
            <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
              Combining your metrics with your answers
            </p>
          </div>
        </Card>
      )}

      {stage === "report" && (
        <Card padding="none" className="overflow-hidden">
          {/* Report header */}
          <div
            className="px-6 py-4 flex flex-wrap items-center justify-between gap-2 border-b"
            style={{ borderColor: "var(--bd-default)" }}
          >
            <div className="flex items-center gap-2">
              <Sparkles className="size-4" style={{ color: primaryColor }} aria-hidden="true" />
              <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Monthly report</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="compact" onClick={downloadReport}>
                <Download className="size-3.5" aria-hidden="true" />
                Export
              </Button>
              <Button variant="secondary" size="compact" onClick={() => setStage("idle")}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Regenerate
              </Button>
            </div>
          </div>

          <div className="px-6 py-5">
            <ReportMarkdown content={report} />
          </div>
        </Card>
      )}
        </div>
      </div>
    </div>
  );
}
