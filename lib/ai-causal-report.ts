/**
 * Claude-powered monthly causal report.
 *
 * Inputs: tenant metrics + owner-recorded Initiatives + indexed Drive file content.
 * Output: 4-section structured doc — Summary / Wins / Watch-outs / Recommendations.
 *
 * Hard constraints:
 *  - ≤500 words total
 *  - At least 3 numeric metric references
 *  - Falls back gracefully when Drive disconnected or metrics insufficient
 */
import Anthropic from "@anthropic-ai/sdk";
import { withTenantContext } from "@/lib/prisma-tenant";
import { ACTIVE_MEMBER, LEFT_MEMBER, TRAINING_MEMBER } from "@/lib/member-population";
import { loadJoinedInWindows } from "@/lib/membership-report";
import { liveClassWhere } from "@/lib/class-live";
import { formatChange, pctChange } from "@/lib/percent";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_OUTPUT_TOKENS = 1200;

export type ReportInput = {
  tenantId: string;
  tenantName: string;
  periodStart: Date;
  periodEnd: Date;
};

export type ReportSections = {
  summary: string;
  wins: string;
  watchOuts: string;
  recommendations: string;
};

export type GeneratedReport = ReportSections & {
  modelUsed: string;
  costPence: number;
  metricSnapshot: Record<string, number>;
  initiativesUsed: { initiativeId: string; type: string; range: string }[];
  driveFilesUsed: { driveFileId: string; filename: string }[];
  driveAvailable: boolean;
  insufficientData: boolean;
};

const PLACEHOLDER_INSUFFICIENT: ReportSections = {
  summary: "Not enough data to generate a meaningful report this period. Once you have at least 10 members and 30 days of attendance, the AI will produce a full causal-analysis report.",
  wins: "—",
  watchOuts: "Insufficient data — please continue using MatFlow.",
  recommendations: "Encourage members to check in via QR or member app to build the data baseline.",
};

async function gatherMetrics(input: ReportInput): Promise<Record<string, number>> {
  const { tenantId, periodStart, periodEnd } = input;
  // Previous period = the calendar month before periodStart, half-open
  // [prevStart, periodStart). Built from calendar fields on the 1st, so a
  // 31-day month cannot overflow (31 Oct - 1 month used to land on 1 Oct).
  const prevStart = new Date(periodStart.getFullYear(), periodStart.getMonth() - 1, 1);

  const [
    totalMembers,
    activeMembers,
    cancelledMembers,
    checkInsThisPeriod,
    checkInsPrevPeriod,
    activeClasses,
  ] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      // Training members only (T2c; APPROVED in the TeamUp import contract):
      // a parent/guardian account is not a member, so it is in none of the
      // five people counts. Active and cancelled use the shared populations
      // from lib/member-population.ts, the same ones Reports uses.
      tx.member.count({ where: { tenantId, ...TRAINING_MEMBER } }),
      tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER } }),
      tx.member.count({ where: { tenantId, ...LEFT_MEMBER } }),
      tx.attendanceRecord.count({
        where: { tenantId, checkInTime: { gte: periodStart, lte: periodEnd } },
      }),
      tx.attendanceRecord.count({
        where: { tenantId, checkInTime: { gte: prevStart, lt: periodStart } },
      }),
      tx.class.count({ where: liveClassWhere(tenantId) }),
    ]),
  );

  // Joined (new + rejoined) by the movement definition, the Reports figure:
  // counting by Member.joinedAt made every undated imported member "new"
  // (it defaults to the import time; review 25 Oct). Its own read.
  const [joinedThis, joinedPrev] = await withTenantContext(
    tenantId,
    (tx) => loadJoinedInWindows(tx, tenantId, new Date(), [
      { start: periodStart, at: periodEnd },
      { start: prevStart, at: new Date(periodStart.getTime() - 1) },
    ]),
    { maxWait: 10_000, timeout: 30_000 },
  );
  const newThisPeriod = joinedThis.joined;
  const newPrevPeriod = joinedPrev.joined;
  const estimated = (b: string) => b === "estimated" || b === "mixed";
  const newEstimated = estimated(joinedThis.basis) || estimated(joinedPrev.basis) ? 1 : 0;

  const checkInsDelta = checkInsThisPeriod - checkInsPrevPeriod;
  // The prompt's figure (lib/percent, multiply first), so the stored snapshot
  // and the prompt it came from agree: 229 vs 200 is 15 in both. Stored as
  // 0 with no check-ins last period (the snapshot holds numbers only); the
  // prompt says there is no percentage then.
  const checkInsPctChange = pctChange(checkInsThisPeriod, checkInsPrevPeriod) ?? 0;
  const newDelta = newThisPeriod - newPrevPeriod;

  return {
    totalMembers,
    activeMembers,
    newThisPeriod,
    newPrevPeriod,
    newDelta,
    newEstimated,
    cancelledMembers,
    checkInsThisPeriod,
    checkInsPrevPeriod,
    checkInsDelta,
    checkInsPctChange,
    activeClasses,
  };
}

/**
 * The check-ins line of the prompt. A percentage change always carries the
 * two figures it compares, "+12% (56 vs 50)" (owner instruction of 24 Oct
 * 2026), so the model is handed the pattern it is told to follow. With no
 * check-ins last period there is no percentage to give: it used to print
 * "+0%" there, a change the data does not show.
 */
export function checkInsMetricLine(current: number, previous: number): string {
  const change = previous > 0
    ? `change ${formatChange(current, previous)}`
    : "no percentage change: there were no check-ins last period";
  return `Check-ins this period: ${current} (last period: ${previous}, ${change})`;
}

function parseSections(raw: string): ReportSections {
  const sections: ReportSections = { summary: "", wins: "", watchOuts: "", recommendations: "" };
  const headers: { key: keyof ReportSections; pattern: RegExp }[] = [
    { key: "summary", pattern: /^#+\s*Summary\s*$/im },
    { key: "wins", pattern: /^#+\s*Wins\s*$/im },
    { key: "watchOuts", pattern: /^#+\s*Watch[-\s]?outs\s*$/im },
    { key: "recommendations", pattern: /^#+\s*Recommendations\s*$/im },
  ];
  const positions = headers
    .map(({ key, pattern }) => {
      const match = pattern.exec(raw);
      return match ? { key, start: match.index, end: match.index + match[0].length } : null;
    })
    .filter((p): p is { key: keyof ReportSections; start: number; end: number } => p !== null)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const next = positions[i + 1];
    sections[cur.key] = raw.slice(cur.end, next?.start ?? raw.length).trim();
  }
  return sections;
}

function wordCount(sections: ReportSections): number {
  const all = `${sections.summary} ${sections.wins} ${sections.watchOuts} ${sections.recommendations}`;
  return all.split(/\s+/).filter(Boolean).length;
}

function numericReferences(sections: ReportSections): number {
  const all = `${sections.summary} ${sections.wins} ${sections.watchOuts} ${sections.recommendations}`;
  const matches = all.match(/(\+?-?\d+(\.\d+)?%)|(\d+\s*members)|(\d+\s*check[-\s]?ins)|(£\d+)/gi);
  return matches?.length ?? 0;
}

export async function generateMonthlyReport(input: ReportInput): Promise<GeneratedReport> {
  const metrics = await gatherMetrics(input);

  if (metrics.totalMembers < 10 || metrics.checkInsThisPeriod === 0) {
    return {
      ...PLACEHOLDER_INSUFFICIENT,
      modelUsed: "placeholder",
      costPence: 0,
      metricSnapshot: metrics,
      initiativesUsed: [],
      driveFilesUsed: [],
      driveAvailable: false,
      insufficientData: true,
    };
  }

  const { initiatives, driveConn, driveFiles } = await withTenantContext(input.tenantId, async (tx) => {
    const inits = await tx.initiative.findMany({
      where: {
        tenantId: input.tenantId,
        OR: [
          { startDate: { gte: input.periodStart, lte: input.periodEnd } },
          { endDate: { gte: input.periodStart, lte: input.periodEnd } },
        ],
      },
      include: { attachments: true },
      orderBy: { startDate: "asc" },
      take: 50,
    });
    const conn = await tx.googleDriveConnection.findUnique({
      where: { tenantId: input.tenantId },
    });
    const files = conn?.folderId
      ? await tx.indexedDriveFile.findMany({
          where: { tenantId: input.tenantId },
          orderBy: { modifiedAt: "desc" },
          take: 20,
        })
      : [];
    return { initiatives: inits, driveConn: conn, driveFiles: files };
  });
  const driveAvailable = !!driveConn?.folderId;

  const driveContext = driveFiles
    .map((f) => `- ${f.filename} (${f.mimeType})${f.contentText ? `\n  excerpt: ${f.contentText.slice(0, 800)}` : ""}`)
    .join("\n");

  const initiativeContext = initiatives
    .map((i) => {
      const range = i.endDate
        ? `${i.startDate.toISOString().slice(0, 10)} → ${i.endDate.toISOString().slice(0, 10)}`
        : i.startDate.toISOString().slice(0, 10);
      return `- [${i.type}] ${range}${i.notes ? `: ${i.notes}` : ""}`;
    })
    .join("\n");

  const periodLabel = input.periodStart.toLocaleString("en-GB", { month: "long", year: "numeric" });
  const driveNote = driveAvailable ? "" : "\n\n**Note:** Google Drive is not connected — generate without external context.";

  const userPrompt = `You are an analyst writing a monthly causal-analysis report for the gym **${input.tenantName}** for the period **${periodLabel}**.

# Metrics this period
- Total members: ${metrics.totalMembers}
- Active members: ${metrics.activeMembers}
- Members joined this period (new + rejoined, the Reports "Joined" figure; imports are never joins${metrics.newEstimated ? "; partly estimated from imported history" : ""}): ${metrics.newThisPeriod} (last period: ${metrics.newPrevPeriod}, delta: ${metrics.newDelta >= 0 ? "+" : ""}${metrics.newDelta})
- Cancelled members (cumulative, all time; not "left this month"): ${metrics.cancelledMembers}
- ${checkInsMetricLine(metrics.checkInsThisPeriod, metrics.checkInsPrevPeriod)}
- Active classes: ${metrics.activeClasses}

# Owner-recorded initiatives during this period
${initiativeContext || "(none recorded)"}

# Indexed Drive content (most recent files)
${driveContext || "(no Drive files indexed)"}${driveNote}

# Your task
Whenever you give a percentage, give the two figures behind it as well, for example "+13% (45 vs 40)". Call the joined figure "members joined (new + rejoined)", and say "partly estimated" whenever the metrics say so.

Produce **exactly four sections** in this order, separated by markdown H2 headers, total ≤ 500 words:

## Summary
One paragraph headline (50–80 words) that names the period, the headline metric direction, and the most likely cause based on the initiatives above.

## Wins
3–5 bullets. Each bullet ties a specific metric (with a number) to a likely cause from the initiatives or external context.

## Watch-outs
2–4 bullets. Each bullet names a metric that dropped or is at risk, with the likely cause.

## Recommendations
2–4 bullets. Concrete actions for next month, grounded in observed patterns.

# Hard rules
- Total ≤ 500 words.
- At least three numeric references (e.g. "+14% (57 vs 50)", "12 members", "£500").
- Never invent metrics — only cite numbers present above.
- Never claim certainty — say "likely correlated with…" not "caused by…".
- No preamble before the first H2. No trailing sign-off.`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();

  const sections = parseSections(text);
  const words = wordCount(sections);
  const numerics = numericReferences(sections);

  // Cost approximation — Haiku 4.5 input ~$1/MTok, output ~$5/MTok
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const costUsd = (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 5;
  const costPence = Math.max(1, Math.round(costUsd * 80 * 100));

  if (words === 0 || !sections.summary) {
    return {
      ...PLACEHOLDER_INSUFFICIENT,
      modelUsed: MODEL,
      costPence,
      metricSnapshot: metrics,
      initiativesUsed: initiatives.map((i) => ({
        initiativeId: i.id,
        type: i.type,
        range: `${i.startDate.toISOString().slice(0, 10)}${i.endDate ? ` to ${i.endDate.toISOString().slice(0, 10)}` : ""}`,
      })),
      driveFilesUsed: driveFiles.map((f) => ({ driveFileId: f.driveFileId, filename: f.filename })),
      driveAvailable,
      insufficientData: false,
    };
  }

  return {
    ...sections,
    modelUsed: MODEL,
    costPence,
    metricSnapshot: { ...metrics, _wordCount: words, _numericReferences: numerics },
    initiativesUsed: initiatives.map((i) => ({
      initiativeId: i.id,
      type: i.type,
      range: `${i.startDate.toISOString().slice(0, 10)}${i.endDate ? ` to ${i.endDate.toISOString().slice(0, 10)}` : ""}`,
    })),
    driveFilesUsed: driveFiles.map((f) => ({ driveFileId: f.driveFileId, filename: f.filename })),
    driveAvailable,
    insufficientData: false,
  };
}
