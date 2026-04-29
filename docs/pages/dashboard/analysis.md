# /dashboard/analysis

| | |
|---|---|
| **File** | app/dashboard/analysis/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; inline check: `if (session.user.role !== "owner") redirect("/dashboard")` |
| **Roles allowed** | owner only |
| **Status** | ✅ working |

## Purpose
Owner-only deep insights view. Displays KPIs: total active members, new this month vs last month, check-ins this month vs last month, active class count, gym name, and current month label. Two charts: a 6-month monthly check-in trend (bar/line) and a member-by-status breakdown (pie/donut). All data is fetched server-side via `Promise.all` of 8 parallel Prisma queries. Read-only — no actions.

## Inbound links
- Sidebar ([components/layout/Sidebar.tsx](../../../components/layout/Sidebar.tsx)) — "Analysis" nav item (owner only; coaches see fewer entries)
- MobileNav ([components/layout/MobileNav.tsx](../../../components/layout/MobileNav.tsx)) — "Analysis" in the More drawer

## Outbound links
— (read-only, no outbound navigation)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.member.count (×3) | Total active, new this month, new last month |
| — | prisma.attendanceRecord.count (×2) | Check-ins this month + last month |
| — | prisma.class.count | Active class count |
| — | prisma.member.groupBy | Status breakdown (active/inactive/cancelled/taster) |
| — | prisma.attendanceRecord.findMany | Last 6 months records for monthly trend chart |

## Sub-components
- AnalysisView ([components/dashboard/AnalysisView.tsx](../../../components/dashboard/AnalysisView.tsx)) — renders KPI cards and both charts

## Mobile / responsive
- Charts adapt to container width. `[needs browser test]` for full mobile layout.

## States handled
- Empty state: zero values shown if no data.
- DB error: caught silently with no logging — see Known Issues.

## Known issues
- **P2 open** — DB errors caught with empty `catch {}` block; no `console.error` logging. Same pattern as attendance page — pending P3 polish pass — see OWNER_SITE_SUMMARY.md.

## Notes
The 6-month trend is computed in JS by iterating `monthlyCheckIns` and bucketing by `(year*12 + month)` offset from today. The `membersByStatus` array uses a `STATUS_LABELS` map to display human-readable labels.
