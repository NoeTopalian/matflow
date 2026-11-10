# Metric dictionary

What each figure MatFlow shows counts, and where it is computed. Written for Round 3 (10 Nov 2026) from the code on `programme/rounds`. When this page and the code disagree, the code is right and this page is out of date.

## Rules every figure follows

- **The club's time.** Every day, week and month boundary is midnight in the club's zone (`Tenant.timezone`, default Europe/London; an unusable value falls back to Europe/London). Weeks start on Monday. Months are half-open, `[monthStart, nextMonthStart)`. Helpers: `lib/club-month.ts` (`clubMonthWindow`, `clubWeekStart`, `clubWeekStartKey`, `clubDayWindow`, `previousClubMonthPeriod`) and `lib/report-period.ts` (`resolveReportPeriod`). Neither the server's zone (UTC on Vercel) nor the reader's browser zone plays a part.
- **No denominator, no rate.** When a rate's base is 0, the value is `null` and the screen shows "—", never "0%" (`lib/percent.ts` `percent`, `ratePct1dp`).
- **Counts beside percentages.** Every percentage on Reports carries its numerator and denominator ("x% (n of m)").
- **No attendance records, no attendance figures.** Before the club's attendance records start (`lib/attendance-coverage.ts`), attendance figures show "—" and say why. They never show 0.
- **Who is a member.** These populations are defined once, in `lib/member-population.ts`:
  - **Training member:** not a parent or guardian account, and not archived.
  - **Active member:** a training member with status `active`. Members on hold (`paymentStatus` `paused`) stay inside it and are marked as on hold.
  - **Current member:** a training member who has not cancelled.
  - **The `_EVER` populations:** they include archived members and are used for history only.
- **Rules-based, not AI.** Every figure is computed from records. The only model-written text is Reports → Monthly report (`lib/ai-causal-report.ts`). Its metric snapshot is still computed from records.

## Reports (`lib/reports.ts` `getReportsData`, owner and manager)

**Period.** Reports covers whole club months chosen on the page (`range`).
- **Period figures** cover that range: attendance, joins, leavers, churn and failed payments.
- **"Now" figures** say "Now": members by status, active members, overdue, and active classes.
- **Filters.** The class and age filters narrow attendance figures only. They do not narrow membership or payment figures.

| Figure | Definition | Numerator ÷ denominator | Date field |
|---|---|---|---|
| Active members (Now) | Count of active members | — | — |
| Current members by status (Now) | Each status's share of current members | status count ÷ current members | — |
| Joined | New plus rejoined in the period, from the membership replay. Tasters and imports are not joins (D11) | — | status history (`lib/membership-movement.ts`) |
| Churn | Every cancellation in the period, joiners who cancel included. A finished course is Left, not churn (owner, 27 Oct 2026) | cancelled ÷ (opening active + moves into active in the period) (owner, 31 Oct 2026) | status history |
| Net new | new + rejoined − left, per club month | — | status history |
| Retention | Of the training members who joined before the start of the club month five months back, how many are active now. The cohort runs from the 1st of a month, so it spans 5 to 6 months | survived ÷ cohort | `Member.joinedAt` |
| Check-ins | Attendance records in the period | — | `AttendanceRecord.checkInTime` |
| This week so far / last week | Check-ins since this club-week's Monday, and over the whole previous week (labelled as "so far") | — | `checkInTime` |
| Attendance chart | One bar per club week, or per club month when the period is longer than 3 months. At least 8 weeks are shown; weeks before the period are context (`inPeriod: false`) | — | `checkInTime` |
| Attendance rate: check-ins per member | — | check-ins ÷ active members | `checkInTime` |
| Attendance rate: attendance percentage | — | active members with at least one check-in ÷ active members | `checkInTime` |
| Attendance rate: fill rate | Classes with no capacity set count on neither side | check-ins ÷ class places, for classes with capacity set | `checkInTime` |
| Top classes | The five classes with the most check-ins in the period, counted over **every** session in the period (the 200-session cap was removed in Round 3). Average = check-ins ÷ sessions; fill rate = check-ins ÷ places | — | `checkInTime` |
| Check-in methods | Each method's share | method count ÷ all check-ins in the period | `checkInTime` |
| Payers overdue (Now) | Payers overdue by Stripe status or by a passed due date. Payers are active and taster accounts, guardians who pay included (`lib/overdue.ts`) | — | — |
| No payment yet (Now) | Payers on a MatFlow-billed plan with no payment ever recorded. Never overlaps with overdue | — | — |
| Other accounts owing / failed to reconcile (Now) | Inactive or cancelled accounts marked overdue, or whose last charge failed and that are not marked overdue (`lib/other-accounts-owing.ts`) | — | — |
| Failed payments | Failed payments in the period | — | `Payment` |
| Recovery | Members with a failed payment in the period, and how many of them are paid now | recovered ÷ failed members | `Payment` |

The CSV export (`components/dashboard/ReportsView.tsx` `reportsCsv`) writes these same fields. Drill-through links carry the month key, so the Members page lists the month that was counted (`clubMonthWindowForKey`).

## Conversion (`lib/attribution.ts`, Reports)

These figures count only members with attribution recorded (`Member.trialRunById`, `creditedToUserId`), since the feature's start date, which the screen shows as "since …". Import status events are excluded throughout.

| Figure | Definition |
|---|---|
| Trials run | Members whose trial this coach ran |
| Converted | Of those trials, how many later reached `active` |
| Lost | Of those trials, how many cancelled before ever being active. Read from the status-event trail, or from the current status when there is no trail |
| Still deciding | Trials neither converted nor lost |
| Conversion rate | converted ÷ trials. `null` ("too few") under 3 trials (`MIN_TRIALS_FOR_RATE`) |
| Retained | Of the conversions, how many are active now. Same minimum-number rule |

## Analysis (`app/dashboard/analysis/page.tsx`, `components/dashboard/AnalysisView.tsx`)

Analysis uses the same period and club zone as Reports (`resolveReportPeriod`).
- **Active members:** active members, as on Reports.
- **Check-ins:** check-ins in the period, and in the equal-length period before it.
- **Engagement:** distinct active members with a check-in ÷ active members, so it is never over 100%.
- **Joined:** the Reports movement figure (`loadJoinedInWindows`), never `Member.joinedAt`.
- **Check-ins by month:** one count per club month.
- **The written analysis** is a fixed template filled from these figures and the owner's answers (`buildReport`). It says "rules-based, not AI". The 1.8-second "analysing" pause was removed in Round 3.

## Monthly report (`lib/ai-causal-report.ts`)

- **Period:** the club's previous month, `previousClubMonthPeriod`. The comparison month is the club month before that.
- **Snapshot:** the metric snapshot is computed from records.
- **Model-written text:** the summary, wins, watch-outs and recommendations.
- **Cost:** shown in pounds (`costPence` ÷ 100, as "£0.01").
- **Empty state:** under 10 training members or 30 days of attendance, the report says there is not enough data, without calling the model.

## Dashboard home (`app/dashboard/page.tsx`)

- **This week's classes:** sessions dated Monday to Sunday of the club's week. A session's `date` is UTC midnight of its club day, so the window is each day ± 12 hours, as in `todayWindow`.
- **Active members (tile):** active members.
- **At risk:** active members with no check-in in 14 days. It is shown only once MatFlow has been the register for the whole 14 days (`readAtRiskGate`).
- **Computed but not shown:** `newThisMonth` (`joinedAt` in the club month), `attendanceThisWeek` and `attendanceThisMonth` are computed but not displayed (`DashboardStats` never renders them). Their boundaries are the club's.

## Attendance page (`app/dashboard/attendance/page.tsx`)

| Card | Definition |
|---|---|
| This month | Check-ins since the club month began |
| This week | Check-ins since the club week's Monday |
| Members who trained | Distinct members with a check-in this club month |
| Busiest session | The class of the single session with the most check-ins this club month |

## Settings → Revenue (`app/api/revenue/summary/route.ts`, owner only)

Revenue counts only `Payment` rows with status `succeeded`. Money billed by another platform (TeamUp) is not revenue here.

| Card | Definition |
|---|---|
| Collected this month | Succeeded payments with `paidAt` in the club month so far, in whole pounds |
| This month × 12 | Collected this month × 12. Not a forecast |
| Active Members | Active members, however they are billed |
| Per active member | Collected this month ÷ active members. "—" when there are none (Round 3; it was £0) |
| History | Succeeded payments per club month, for the last six club months |
| Memberships | Active members per membership type, with the tier's price. No price when a tier has no price and no cycle |
| Recent | The six most recent payments, each labelled by its own status |

## Known gaps (not fixed in Round 3)

- **Member Progress:** "this week", "this month" and "this year", the heat strip and streaks (`lib/member-stats.ts`) use the server's clock. Round 10.
- **Birthdays and anniversaries:** birthday and joining-anniversary days (`lib/dashboard-action-items.ts`, `app/member/home/page.tsx`) use the server's day. Round 10.
- **Timetable week:** the timetable editor's week (`components/dashboard/TimetableManager.tsx`) uses the browser's clock. Round 6.
- **Unused stats route:** `GET /api/dashboard/stats` has no caller in the app and still uses the server's clock.
- **Monthly report period label:** the report list formats a report's period in the reader's browser zone, so a reader far west of the club can see the month before.
