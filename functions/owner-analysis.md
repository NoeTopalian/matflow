# Owner Analysis

> **Status:** ✅ Working · member-mix donut · 6-month engagement sparkline · KPI grid · AI Monthly Report CTA · engagement % bounded 0-100% (B7 fix commit `153a9ec`).

## Purpose

A second analytics view (sibling to Reports) focused on member engagement and the AI report. Where Reports answers "what's happening?", Analysis answers "how are my members behaving?" — engagement %, member mix by status, attendance trend over half a year.

## Surfaces

- Page: [/dashboard/analysis](../app/dashboard/analysis/page.tsx)
- Component: [AnalysisView](../components/dashboard/AnalysisView.tsx)
- Owner-only (manager/coach/admin redirect to /dashboard)

## Sections

1. **Member Mix donut** — counts by `Member.status` (active / inactive / cancelled / taster), centre shows total
2. **Engagement Trend sparkline** — 6-month attendance counts, monthly buckets
3. **KPI grid** — Active Members · Check-ins (this month, with delta) · **Engagement %** (capped 0-100%) · Active Classes
4. **Generate Your Monthly Report CTA** — explains the AI report wizard then offers Start Report → triggers a 5-question interview, then synthesis

## Data fed into the page

[app/dashboard/analysis/page.tsx](../app/dashboard/analysis/page.tsx) pre-fetches in `Promise.all`:

- `Member.count where status='active'`
- `Member.count where joinedAt >= startOfMonth`
- `Member.count where joinedAt between startOfLastMonth..endOfLastMonth`
- `AttendanceRecord.count` (this month + last month) joined to Class for tenant scope
- `Class.count where isActive=true`
- `Member.groupBy by status`
- `AttendanceRecord` records back 6 months for the trend
- **`AttendanceRecord.findMany distinct: ["memberId"]`** for active-this-month set — feeds the engagement % calc (added in the B7 fix)

## The engagement % calc (B7 fix)

**Before the fix** (commit pre-`153a9ec`): `engagementRate = Math.round((checkinsThisMonth / totalMembers) * 100)` — could exceed 100% (e.g. 354 check-ins / 13 members = 2723%).

**After the fix**:
```ts
const engagementRate = totalMembers > 0
  ? Math.min(100, Math.round((activeMembersThisMonth / totalMembers) * 100))
  : 0;
```

Now defined as **% of members who attended at least one class this month**, bounded at 100%. Same formula in both the KPI tile ([AnalysisView.tsx:219](../components/dashboard/AnalysisView.tsx#L219)) and the AI report's narrative section.

## AI Report wizard

When owner clicks **Start Report**, an in-page interview asks 5 short questions about things the AI can't see in the data:
1. Word-of-mouth / referrals this month?
2. Special events or promotions?
3. Biggest challenge right now?
4. Morale rating 1-10 (and why)?
5. Goal for next month?

Then synthesises a written report locally (no API call yet — see [ai-monthly-report.md](ai-monthly-report.md) for the actual Anthropic-backed `/api/reports/generate` flow).

## Security

- `session.user.role !== "owner"` redirects to /dashboard — owner-only by hard gate at the page layer
- All Prisma queries tenant-scoped

## Known limitations

- **In-page report wizard is local-only** — generates from a template, doesn't call the Anthropic API. The actual AI report lives at `/api/reports/generate` (different surface).
- **Donut legend "A…" truncation** at narrow viewports — still unfixed; no impact on the metric, just the sidebar label.
- **No drilldown** — can't click an engagement % to see WHICH members are inactive.
- **6-month window is fixed** — no zoom-out for year-over-year.

## Files

- [app/dashboard/analysis/page.tsx](../app/dashboard/analysis/page.tsx)
- [components/dashboard/AnalysisView.tsx](../components/dashboard/AnalysisView.tsx)
- [components/dashboard/charts/DonutChart.tsx](../components/dashboard/charts/DonutChart.tsx)
- [components/dashboard/charts/Sparkline.tsx](../components/dashboard/charts/Sparkline.tsx)
