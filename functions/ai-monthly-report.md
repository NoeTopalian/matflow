# AI Monthly Report

> **Status:** ✅ Working · Anthropic Claude Haiku 4.5 · grounded on tenant DB metrics + optional Google Drive context · stored as `Initiative` row + downloadable.

## Purpose

Once a month, the owner clicks "Generate Report" and gets a 2-3 page causal narrative: "attendance dropped 8% in March because... revenue is up 12% but churn is creeping up... the new beginners' class is converting at 60% which is why...". It cites real numbers from the gym's own DB, not generic advice.

The aim is to turn raw dashboard charts into actionable explanations the owner can read on their commute. It's not "AI marketing copy" — it's a causal analyst that has access to the gym's metrics.

## Surfaces

- Owner Reports tab → "Generate AI Report" button (see [owner-reports.md](owner-reports.md))
- Loading state: "Analysing your data… this takes ~30 seconds"
- Output: rendered Markdown panel with the report + Download as PDF
- Report saved to `Initiative` table (see [initiatives.md](initiatives.md)) so owner can revisit / share

## Data sources

The report pipeline assembles a structured context from THREE sources, then feeds it to Claude Haiku:

### 1. DB metrics (always present)

For the trailing 30 days vs previous 30:
- New members joined, churned (cancelled), net change
- Total attendances (count + unique members)
- Class instance count + average attendance per class
- Revenue (sum of `Payment` rows where `paidAt` falls in window)
- Top 5 classes by attendance
- Top 5 classes with declining attendance vs previous period
- Membership tier distribution
- Pending overdue payments count

### 2. Google Drive context (optional)

If [google-drive.md](google-drive.md) is connected and indexed: the report appends `IndexedDriveFile.contentText` for the most recently modified files (capped at total ~30KB). Lets the owner's own ops notes / incident logs feed the analysis.

### 3. Recent initiatives (optional)

Last 3 `Initiative` rows tagged `kind='monthly_report'` so the model sees prior months' narratives and can compare ("last month I noted X; this month X has improved").

## Prompt structure

```
You are a martial arts gym operations analyst. The owner of {gymName} has asked
for a causal analysis of last month's performance. Use the metrics below to
explain WHY the numbers moved, not just WHAT they are. Be specific — name
classes, members, dates. Avoid generic advice. End with 3 concrete actions
the owner could take this week.

# Metrics (March 2026 vs February 2026)
{... structured metrics ...}

# Top classes by attendance
{... }

# Recent operations notes from your Drive
{... contentText slices ...}

# Previous monthly reports
{... for context, last 3 ...}

Respond in Markdown.
```

System prompt enforces British English, ~600 words max, no bullet-list spam (we want narrative paragraphs), and a "What to do this week" closer.

## Model + parameters

```ts
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const response = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 4000,
  temperature: 0.3,                          // low — we want consistent, sober prose
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: contextString }],
});
```

Haiku 4.5 is the right tier — fast, cheap, more than capable for structured summarisation tasks. ~£0.05 per report.

## Endpoint — `POST /api/ai/monthly-report`

Owner-only. Idempotency: rate-limited to 5 generations per month per tenant (prevents accidental double-clicks burning API credits).

```ts
const { tenantId, userId } = await requireOwner();

const rl = await checkRateLimit(`ai_report:${tenantId}`, 5, 30 * 24 * 60 * 60 * 1000);
if (!rl.allowed) return 429;

const context = await buildReportContext(tenantId);
const completion = await anthropic.messages.create({...});
const markdown = completion.content[0].type === "text" ? completion.content[0].text : "";

const initiative = await prisma.initiative.create({
  data: {
    tenantId, userId,
    title: `Monthly Report — ${monthLabel}`,
    body: markdown,
    kind: "monthly_report",
    status: "ready",
  },
});

await logAudit({tenantId, userId, action: "ai.monthly_report.generated",
  entityType: "Initiative", entityId: initiative.id,
  metadata: {tokenCount: completion.usage.output_tokens}, req});

return NextResponse.json({initiativeId: initiative.id, body: markdown});
```

## Cost / rate limiting

- Hard rate limit: 5 reports / 30 days / tenant
- Soft display: "Last generated 4 days ago" so the owner knows not to click again
- API key: shared platform key (`ANTHROPIC_API_KEY`) — gyms don't bring their own. We absorb the cost.

If a tenant blows past the limit, returns 429 with `Retry-After`.

## Storage

Report stored as an `Initiative` row with `kind = "monthly_report"` (see [initiatives.md](initiatives.md)). This:

- Gives the owner a permanent archive ("show me reports from 6 months ago")
- Lets future reports reference past ones in the prompt
- Reuses the existing Initiative UI (no new list view needed)

## Download

`GET /api/ai/monthly-report/[id]/pdf` — server-side render via `puppeteer-core` + `chrome-aws-lambda` (Vercel-friendly). Markdown → HTML → PDF. ~3MB chromium binary cold-start cost; cached after first request.

## Security

| Control | Where |
|---|---|
| Owner-only | `requireOwner()` |
| Rate limit | 5/month/tenant on report generation |
| Tenant scope | All metric queries filter `where: {tenantId}`; Drive context is per-tenant |
| Prompt injection guard | Drive contents sandwiched between `<drive_content>` delimiters; system prompt explicitly tells the model to treat them as data not instructions |
| API key server-side only | `ANTHROPIC_API_KEY` never sent to client |
| Audit log | `ai.monthly_report.generated` with token count |
| No PII to model unnecessary | Member names included only when discussing top contributors; no emails / payment details |

## Known limitations

- **No streaming UI** — owner waits ~30s with a spinner. Streaming the response would feel faster.
- **Single language** (British English) — i18n would need locale-aware prompts and probably model swap.
- **No sentiment around staff/coaches** — model sees attendance/revenue but not e.g. coach feedback. Could expand by including a recent-feedback summary.
- **Fixed prompt** — owner can't customise focus areas ("focus on retention this month"). A "prompt addendum" field would help.
- **Cost cap is per-tenant only** — no global circuit breaker. A bug that loops requests could burn the platform budget.
- **Drive context is contemporary** — doesn't time-window to "files modified in last 30 days". Adding `where: {modifiedAt: {gte: lastMonth}}` would tighten relevance.
- **No comparison to peer gyms** — we have multi-tenant data but anonymised cohort benchmarks aren't surfaced ("most gyms in your size band saw 3% growth this month").
- **PDF rendering** is heavy and Vercel cold-start sensitive. A pre-rendered HTML download might be smoother.

## Test coverage

- Mock-Anthropic unit test asserting context structure (recommended; not yet built)
- Live Anthropic call tested manually — model responses are non-deterministic, so snapshot tests aren't useful

## Files

- `app/api/ai/monthly-report/route.ts` — generation endpoint
- `app/api/ai/monthly-report/[id]/pdf/route.ts` — PDF render
- `lib/ai-report-context.ts` — `buildReportContext(tenantId)` — assembles DB + Drive + history
- `lib/ai-prompts.ts` — system prompts + delimiter helpers
- `components/dashboard/AiReportPanel.tsx` — generate button + Markdown render
- See [google-drive.md](google-drive.md), [initiatives.md](initiatives.md), [owner-reports.md](owner-reports.md), [owner-analysis.md](owner-analysis.md)
