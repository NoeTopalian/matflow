# Owner Reports

> **Status:** ✅ Working · class-composition donut · 12-week check-in sparkline · AI Monthly Report panel · Initiatives input · CSV export.

## Purpose

The owner's "what's happening at my gym?" view — combines descriptive analytics (donut + sparkline + KPIs) with the gateway to the AI-generated monthly causal report. Initiatives panel sits alongside so the owner can record what they did (marketing push, new class, price change) — those become the inputs the AI report correlates with the metrics.

## Surfaces

| Surface | Path |
|---|---|
| Page | [/dashboard/reports](../app/dashboard/reports/page.tsx) |
| Component | [ReportsView](../components/dashboard/ReportsView.tsx) |
| Charts | [DonutChart](../components/dashboard/charts/DonutChart.tsx), [Sparkline](../components/dashboard/charts/Sparkline.tsx) |
| Initiatives panel | [InitiativesPanel](../components/dashboard/InitiativesPanel.tsx) |
| Monthly report viewer | [MonthlyReportView](../components/dashboard/MonthlyReportView.tsx) |

## Sections

1. **Class Composition donut** — share of total check-ins by class (last 30 days)
2. **Check-in trend sparkline** — weekly attendance, last 12 weeks, with delta vs last week
3. **AI Monthly Report panel** — "Generate now" button → invokes [/api/reports/generate](../app/api/reports/generate/route.ts) (Anthropic SDK)
4. **Initiatives panel** — see [initiatives.md](initiatives.md)
5. **KPI cards** — Active Members / Attendance this week / New this month

## API routes

### `GET /api/reports`
Owner/manager. Returns:
- `byClass: { name, count, pct }[]` — for the donut
- `weeklyTrend: { weekLabel, count }[]` — for the sparkline
- `kpi: { activeMembers, attendanceThisWeek, newThisMonth }`

Backed by [lib/reports.ts](../lib/reports.ts) helpers.

### `POST /api/reports/generate`
Owner only. Triggers a manual on-demand AI monthly report generation. Returns the new `MonthlyReport` row. See [ai-monthly-report.md](ai-monthly-report.md) for the prompt + cost model.

### `POST /api/payments/export.csv` (related — owner-side CSV export)
Returns a CSV download of payments — see [payments-ledger.md](payments-ledger.md). Reports page hosts the **Export CSV** button.

## Flow

1. Owner opens /dashboard/reports
2. Server fetches `/api/reports` + most recent `MonthlyReport` (if any)
3. Donut + sparkline + KPIs render
4. Owner clicks **Generate now** → POST → new MonthlyReport row inserted, viewer updates inline
5. Owner clicks **Export CSV** → browser download

## Security

- All endpoints owner/manager (manager can read; only owner can `Generate now` since it costs money)
- Tenant-scoped
- AI generate route also gated by `ANTHROPIC_API_KEY` env var (returns 503 if unset)
- CSV export rate-limited (10 / hr per tenant) to prevent abuse
- Audit logged: `logAudit({ action: "report.generate", entityId: reportId, metadata: { costPence } })`

## Known limitations

- **Charts** — `recharts` based; mobile-first but doesn't drill down.
- **No date-range picker** — fixed windows (30d donut, 12w sparkline).
- **AI report** is single-tenant — no compare-against-peers benchmark.
- **No goal-setting** — KPIs are descriptive, not "you set a target of 20 new members and got 15".
- **CSV export is payments-only** — no attendance, members, or revenue export from this page.

## Files

- [app/dashboard/reports/page.tsx](../app/dashboard/reports/page.tsx)
- [components/dashboard/ReportsView.tsx](../components/dashboard/ReportsView.tsx)
- [components/dashboard/MonthlyReportView.tsx](../components/dashboard/MonthlyReportView.tsx)
- [components/dashboard/charts/DonutChart.tsx](../components/dashboard/charts/DonutChart.tsx)
- [components/dashboard/charts/Sparkline.tsx](../components/dashboard/charts/Sparkline.tsx)
- [components/dashboard/InitiativesPanel.tsx](../components/dashboard/InitiativesPanel.tsx)
- [app/api/reports/route.ts](../app/api/reports/route.ts)
- [app/api/reports/generate/route.ts](../app/api/reports/generate/route.ts)
- [lib/reports.ts](../lib/reports.ts)
