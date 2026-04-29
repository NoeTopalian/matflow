# /dashboard/reports

| | |
|---|---|
| **File** | app/dashboard/reports/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; inline check: `if (!["owner", "manager"].includes(session.user.role)) redirect("/dashboard")` |
| **Roles allowed** | owner / manager |
| **Status** | ⚠️ partial — AI report generation blocked by missing `ANTHROPIC_API_KEY` |

## Purpose
Analytics dashboard showing member trends, payment summary, class utilisation, and an initiatives panel. Data is aggregated server-side via `lib/reports.ts` (`getReportsData`). The page also provides a "Generate Report" button that calls `/api/reports/generate` to create a `MonthlyReport` row with a Claude AI causal analysis. Chart filters and a date-range picker allow slicing the aggregated data.

## Inbound links
- Sidebar ([components/layout/Sidebar.tsx](../../../components/layout/Sidebar.tsx)) — "Reports" nav item (owner/manager only)
- MobileNav ([components/layout/MobileNav.tsx](../../../components/layout/MobileNav.tsx)) — "Reports" in the More drawer

## Outbound links
— (self-contained)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | lib/reports.ts getReportsData | Server-side aggregation of member growth, attendance heatmap, revenue, top classes |
| GET | /api/reports | Fetch report data client-side (used by ReportsView for dynamic filtering) |
| POST | /api/reports/generate | Generate AI causal MonthlyReport via Claude API |

## Sub-components
- ReportsView ([components/dashboard/ReportsView.tsx](../../../components/dashboard/ReportsView.tsx)) — chart rendering, date-range picker, generate-report button
- InitiativesPanel ([components/dashboard/InitiativesPanel.tsx](../../../components/dashboard/InitiativesPanel.tsx)) — initiatives/insights sidebar panel

## Mobile / responsive
- Charts adapt to container width. `[needs browser test]` for full mobile layout.

## States handled
- Empty state: `createEmptyReportsData()` used as fallback on DB error.
- DB error: logged via `console.error("Failed to load reports data", error)`.

## Known issues
- **P1 ✅ Mitigated** — `lib/reports.ts` was unbounded `findMany`; now hard-capped at `take: 10000` (attendance) and `take: 5000` (members) with `console.warn` on truncation — see OWNER_SITE_SUMMARY.md.
- **P1 open** — `/api/reports/generate` calls `generateMonthlyReport()` which throws if `ANTHROPIC_API_KEY` is unset — see PRODUCTION_QA_AUDIT.md.

## Notes
The inline role check (`auth()` + manual role comparison) differs from the pattern used by most other pages (`requireOwnerOrManager()`). Both patterns produce the same result but the inconsistency is worth noting for future refactoring.
