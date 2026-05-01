# Member Progress

> **Status:** ⚠️ Mostly working · belt + KPIs + most-attended classes all render · "Your Classes" section header is empty (audit C5 — should list ClassSubscriptions).

## Purpose

The member's "how am I doing?" page. Belt + stripes prominently displayed at the top; year-to-date training count with a progress bar toward an arbitrary target; weekly/monthly/yearly KPIs; top 3 most-attended classes over the last 90 days. Designed to be motivating without pretending to be a full analytics dashboard.

## Surfaces

- Page: [/member/progress](../app/member/progress/page.tsx)
- Bottom nav: 3rd tab

## Sections

1. **Header** — "Progress" + member name
2. **Belt card** — current belt name, color band, X/4 stripes count, "Promoted by Coach Mike" line. Below: yearly classes count + percentage of an internal target (e.g. 47 / 150 = 31%).
3. **KPI grid (4 tiles)** — This Week / This Month / This Year (classes attended) + Current Streak (consecutive weeks with at least one check-in)
4. **Most attended (90 days)** — top 3 classes by check-in count, with avg/wk + streak
5. **"Your Classes" heading** — empty body (audit C5 still open)

## API consumed

[`GET /api/member/me`](../app/api/member/me/route.ts) returns:

- `belt: { name, color, stripes, achievedAt, promotedBy }` — `promotedBy` enriched per LB-007
- `stats: { thisWeek, thisMonth, thisYear, streakWeeks, totalClasses, attendanceByClass, avgClassesPerWeek }`

The `streakWeeks` calc uses [lib/streak.ts](../lib/streak.ts) on the AttendanceRecord checkInTime array — counts back week-by-week from now until a gap is found.

## Data model

```prisma
model AttendanceRecord {
  ... checkInTime DateTime ...
}

model MemberRank {
  ... promotedById String? ...
}
```

Streak math: walks back week-by-week starting from this week. For each week, checks if the member has at least one `checkInTime` within that 7-day window. First missed week ends the streak.

## Security

- Member-authed only — `requireSession()` plus `session.user.memberId` check
- Tenant-scoped (member's own attendance records only)
- No PII beyond what the member already knows about themselves

## Known limitations

- **C5 — "Your Classes" empty.** The heading renders but the body is missing. Should iterate `Member.subscriptions` and show a card per subscribed class with the next instance's date/time. Easy fix; audit-flagged from day one.
- **Yearly target is hardcoded** — the 150-class denominator is in the component. Should be a member-set goal stored on `Member.yearlyTarget`.
- **No belt history view** — only current belt. The `RankHistory` rows are queried owner-side but not exposed to the member.
- **Streak definition is "weeks with ≥1 check-in"** — doesn't reset for missed weeks across timezones consistently. Edge case.
- **No achievements/badges** — could use the AttendanceRecord history for "First class!", "10 classes!", "1 year anniversary!" milestones.

## Files

- [app/member/progress/page.tsx](../app/member/progress/page.tsx)
- [app/api/member/me/route.ts](../app/api/member/me/route.ts) — belt + stats source
- [lib/streak.ts](../lib/streak.ts) — streak math
- See also [member-profile.md](member-profile.md) for the journey milestones (separate but related)
