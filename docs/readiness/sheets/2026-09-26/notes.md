# Contact sheet — 2026-09-26 — Package A (visibility and timetable)

PNGs live in `.omc/sheets/2026-09-26/` (git-ignored; `index.html` there, copy on the Desktop). Test branch, run-stamped fixtures removed afterwards (0 leftover rows verified by SQL). Clock frozen at 18:15 local; two classes at 18:00, one at 19:30, one at 09:00, one cancelled instance at 20:45. Inspected by the lead before the commits below; what I saw, not what the tests say.

| Surface | 375 | 915 | 1440 | Verdict |
|---|---|---|---|---|
| Member profile → Payments tab (two payments) | cards below the fold (sheet scrolls to Transactions on the re-run) | header on the table's top edge, both rows visible, "2 records", no blank band | same | **FIXED** (`1610c2b`) — the 25 Sep screenshot cannot recur; R6-1 |
| Member day view | two 18:00 blocks side by side, not intersecting, each a full tap target; Live pill with pulsing dot and elapsed hairline, Next pill, Cancelled pill with struck name; "Saturday · 7 classes · 2 live" | same, wider lanes | same | **DONE** (`0c0356c`); one contrast fault seen and fixed in the follow-up commit: unsubscribed blocks used a dark navy ink on the dark shell (pre-existing) — ink is now the shell's own text |
| Owner timetable | phone agenda: Ended (dimmed, in words), Live (accent edge), Next pills in the same words as the member view | week grid opens on Monday with today off-screen to the right (pre-existing 980px floor) — fixed in the follow-up commit: today's column is scrolled into view when the grid overflows | today's column tinted; Ended / Live / Next pills; the cancelled fixture shows no pill (the template cannot know — stated in code; Today's Classes on the home carries it) | **DONE** with one gap named |
| Settings → Staff / Waiver at 915 | — | rows under the 74px rail can now be scrolled and focused into view (promoted sweep green) | — | **FIXED** (`b02cbcf`); R6-2 |

Not on this sheet (owed by the rest of Package A): the other 50 route segments and ~45 dialogs at 375/1440 with the geometry floor and the failed-fetch state probe; the six-tab profile rail on a phone; `/member/billing` and `/member/actions` reachability; the announcement modal on first paint.

Dev overlay: the "1 issue" badge on both shells is the Next dev overlay; a fresh load of `/member/schedule`, `/dashboard/timetable` and `/dashboard/members` logged zero console errors or page errors (probe `a2-console-probe.js`), so it is stale HMR state, not a product error.
