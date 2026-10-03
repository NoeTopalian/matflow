# Total BJJ — TeamUp attendance-history import: evidence record (3 Oct 2026)

Secret-free. No names, emails or personal data. Counts only. Row-level files stayed in the session scratchpad and are
not committed.

## 0. Verdict

| Target | Verdict |
|---|---|
| Code | **READY**. Lint, tsc, unit 3,399 passed (0 failed), DB integration on the test branch (engine 19/19, upload 1/1), Semgrep 0 findings, production build pass. The independent acceptance review's P1 findings are all fixed and covered by tests. |
| Test branch, rehearsal club (real files) | **IMPORTED AND RECONCILED**: 7/7 independent checks (§4). |
| Production (`totalbjj`) | **BLOCKED** on three operator steps, none of them code (§7). |

## 1. Root causes, changes, SHAs

Deployed production SHA at the start: `5aed6c9`. The failure was reproduced on a production build of that SHA against
the test branch, using the unmodified file (`scratchpad/att/repro-root-causes.md`).

| Layer | What happened at 5aed6c9 | Fix |
|---|---|---|
| Detection | `lib/importers/sniff.ts` read Customer Name + Membership Name + Status as a **memberships** export, because `Offering Type Name` was not a class header. The Attendance panel disabled submit with "This is a TeamUp memberships export…"; the API answered **400**. | Attendance aliases (`offering type name`, `event starts at`, `customer name`). The real file now sniffs as `teamup_attendance`, and both memberships exports still sniff as memberships. |
| Wrong slot | The Members path accepted it under Source TeamUp and previewed **632 members** from 15,273 "membership rows". Not committed. | The members upload refuses an attendance export; the attendance preview refuses a memberships export. |
| Header contract | No alias for `Offering Type Name`; `Event Starts At` matched nothing. | All 13 data columns mapped. The 13 profile columns are reported as *not imported*. Unknown columns are disclosed. A repeated column, a row with the wrong cell count, a bad date or an unknown status is an error before any write. |
| Time | Every start carries an offset (`+01:00` ×8,773, `+00:00` ×6,500); offsets were refused. | Exact instant from the offset, raw text kept, club date/time from `Europe/London`. DST and the autumn repeated hour are tested; a repeated-hour collision is held as a conflict. |
| States | Only Attended was kept; 1,478 Registered / Late Cancelled / No show rows were dropped. | Source-booking ledger `ImportedBooking`: every booking is kept with its status. Only Attended becomes attendance. |
| Classes/venue | Matched only to existing classes; the club has none, so every row was quarantined. Venue ignored. | Explicit owner decisions: offering → timetable class / **historical class** (inactive, no schedule, no duration, end time unknown) / pending; venue → this club / location / pending. |
| People | `externalRef` (`teamup:<email>|<name>`) was never compared; a child booked on a parent's email was quarantined. | Order: owner decision → `externalRef` → one member with the same name AND email. Never name alone or email alone. Candidates are suggestions only. |
| Payload | Multipart body **4,508,915 bytes**, over Vercel's 4.5 MB function request limit (and the response limit applies too). | Chunked upload (1 MiB parts) into private Postgres storage, verified by size + SHA-256, claimed once. The ledger export is served in parts. |
| Job | One long request, no lease or steps, exception list capped at 500. | Leased, checkpointed steps (batch + checkpoint in one transaction), resume after a crash, two-tab refusal, bounded preview with paged lists. |

Schema (additive, nullable; applied to the test branch only): migration `20261003180000_attendance_history_ledger`. It adds
`ImportedBooking`, `ImportSourceMapping`, `ImportUpload(+Chunk)` (with RLS), `ImportJob.leaseUntil/leaseToken/mappings`,
and `Class/ClassInstance.sourceImportJobId`. `ClassInstance.endTime` and `Class.duration` become nullable instead of being
invented. Commits: see §9.

## 2. Source file and controls

`report-download-rKihmxrY6z4fvoA5wZTPNn.csv`, SHA-256 `115373716468cb4694e5457ca6552667f5643764f126222e1a9ea28a5f5b3ee0`,
4,508,479 bytes, UTF-8 with BOM, CRLF, 26 columns, 15,273 data rows. Counted three ways (my independent script, the
app's preview, the reconciler) with identical results:

| Control | Count |
|---|---:|
| Attended / Registered / Late Cancelled / No show | 13,795 / 1,331 / 82 / 65 |
| Identities (name+email) · distinct emails · shared emails | 486 · 417 · 54 |
| Missing-email rows / identities | 146 / 6 |
| Offerings · venues · distinct starts · provisional sessions | 14 · 1 · 1,331 · 1,684 |
| Booking Method Membership / Free | 15,049 / 224 |
| Customer Membership IDs · Membership IDs | 617 · 15 |
| Instructors / Checkin Timestamp | blank on every row |
| Range | 4 Oct 2025 09:00 +01:00 → 3 Oct 2026 12:30 +01:00 |

Facts found in the data:
- All 1,331 Registered rows are in the past (booked, never resolved by TeamUp): kept as bookings, never attendance.
- 45 person/start pairs are Attended in two offerings at the same instant: one visit each, the second booking linked.
- No exact duplicates. No row is unreadable.

## 3. Upload and browser rehearsal (hosted path)

Production build, Neon **test branch**, providers isolated (Stripe and Resend given invalid keys, push and Blob blank),
`TESTING_MODE=false`: the owner was forced to enrol TOTP. A TLS proxy in front stood in for Vercel's edge and measured
every request.

- Unmodified file through Settings → Import → Attendance history. Header recognised; uploaded in 5 parts; preview
  showed every control in §2; venue and 14 offerings decided; import confirmed.
- **Server killed mid-commit at 6,000 / 15,273**. The checkpoint was exact (6,000 bookings, the in-flight batch rolled
  back). The reloaded panel showed "Resume from where it stopped"; it resumed to completion with outcome counters intact.
- Edge measurements:
  - largest request **1,048,576 bytes** (one part);
  - largest response 10 KB for API calls, **1,495,622 bytes** for a ledger-export part;
  - no request or response over 4.5 MB;
  - per-call times: parts 1–8 s, preview 8–17 s (37 s once on a slow link), steps ≤ 27.6 s, all under `maxDuration`.
- Locally, the server-to-database leg runs over a home connection (Italy → London). One 1 MiB part write took 28 s and
  hit Prisma's 15 s transaction default. The client's retry succeeded, and the budget is now 45 s. On Vercel that leg
  is inside the datacentre.

Second full cycle after the acceptance-review fixes (rebuilt candidate), on a degraded home link (connect about 1.2 s,
queries 100–300 ms), 21:39–22:11 Italy:
- import → RECONCILED 7/7;
- full-import rollback through the history row's own button: **DELETE 200 in 32.8 s**, removing 15,273 bookings,
  13,140 visits, 1,605 sessions and 14 classes, leaving 0 rows;
- re-import → RECONCILED 7/7;
- ledger export in 4 parts (largest 1,490,735 B, rows = database);
- identical replay → RECONCILED 7/7.

That cycle ran on 894 members, not 922. The members import itself hit 28 slice timeouts on the slow link — see "Found
on the way" below. The reconciler derives its expectations from the roster actually present, so the cycle is valid:
457 matched, 29 pending.

On that link the slowest single calls were: one part PUT 43 s (route limit 60 s), one attendance call 63 s (route limit
now 300 s), "complete" 31 s. On Vercel the database leg is in the datacentre; even so, every budget was raised to fit
the route limit.

**Found on the way (pre-existing, members import), fixed in `abc36de`.** A members commit with a system-failed slice
ends "failed" and tells the owner to run it again, but it deleted the stored file anyway, so the retry failed with
"Import file is no longer in storage". It now keeps the file unless the run completes. Relevant to Sean's production
members import: if it stops part-way, **Run it again**, do not re-upload.

## 4. Independent reconciliation

`scripts/readiness/attendance-reconcile.mjs` uses its own CSV parser and identity rule, reads the database read-only, and
imports no app code.

| Check | Result |
|---|---|
| C1 source controls | rows 15,273; 13,795 / 1,331 / 82 / 65; identities 486; provisional sessions 1,684 |
| C2 one booking per row | ledger 15,273; CSV rows without a booking 0; bookings without a CSV row 0 |
| C3 statuses | identical, 0 differences |
| C4 people | 486 identities; 472 matched; 14 pending; 0 disagreements |
| C5 visits | 13,592 distinct (member, instant) = 13,592 linked records; 0 wrong or missing |
| C6 no phantom attendance | 13,592 imported records; 0 on non-visits; 0 unreferenced |
| C7 sessions | 1,684 → 1,613 created + 71 with no resolvable attendance; 0 with an invented end time |

**The 14 pending identities (165 rows):**
- 9 are in the attendance export only (20 rows). This matches the brief.
- 5 are children with a Kids plan and no email (145 rows). The members import refused to create them because no parent
  could be identified (7 membership rows quarantined `kid_without_parent`).

They are kept privately as pending, never matched by name or shared email. Resolution: staff add the parent and then the
child under Members, then map them here.

## 5. Idempotency, updates, interruption, rollback

Covered by `tests/integration/attendance-import-engine.test.ts` (19/19 on the test branch) and by the rehearsal:

- identical replay, reordered file and overlapping export create nothing new;
- a newer export turns Registered → Attended on the same booking (+1 visit), and an older one is "stale";
- a live check-in at the same instant is linked, not duplicated;
- a staff-removed visit stays removed through replays **and rollbacks**;
- a corrected booking that owned a shared visit hands it to its partner;
- rollback restores layer by layer;
- interrupted batch → exact resume;
- two tabs → busy;
- rollback removes only what the job created and is untouched, keeps live sessions and check-ins, and is refused while
  another import runs.

Rehearsal:
- replay = "15,273 already imported" / "already up to date", nothing new;
- replay rollback removed nothing;
- full-import rollback removed exactly 15,273 bookings, 13,592 visits, 1,613 sessions and 14 historical classes, and kept
  the owner's decisions (first cycle by the history button; second cycle measured at 32.8 s, §3).

## 6. Security, preservation, reports, export

- **Endpoints:** every new endpoint is owner + MFA (+ same-origin for writes). This is tested per endpoint for
  unauthenticated, member, coach, manager, TOTP-pending, temporary-password, wrong-tenant and tampered ids
  (`tests/unit/import-attendance-route.test.ts`, upload route tests).
- **Upload token:** bound by hash to tenant, creator, purpose and expiry; claimed once. No URL is ever fetched (no
  SSRF). File bytes and storage addresses are never returned.
- **Retention and erasure:** retention covers new tables, expired and superseded uploads, and stopped imports' files.
  DSAR export and erase match ledger rows by member or exact source identity, never by shared email.
- **Before/after the import:** member rows (status, plan, billing, guardian links, `externalRef`, contacts) are
  **byte-identical**, and imported-membership ledger hashes are identical. EmailLog, Payment, Notification, pack
  redemptions and ranks are unchanged. The single EmailLog row is the *members* import's owner notice, written before
  the first attendance job.
- **Live surfaces:**
  - no live class or schedule was created;
  - the 14 historical classes are absent from the timetable, `/api/classes`, coach today and kiosk;
  - check-in refuses import-made sessions;
  - imported visits are excluded from the public TV leaderboard;
  - undo of a staff tick never deletes an imported visit.
- **Reports and profiles:** reports label the method "Imported" (6,381 visits in the 24-week window). A member profile
  shows the true visit count (no longer capped at 50) and an imported booking-history line. The check-in time of an
  imported visit is shown as not recorded.
- **Export:** 4 parts, 15,273 rows = database, BOM + CRLF, formula-injection guard via `lib/csv`.
- **Consumer audit** (read-only, before implementation): an import triggers no send, credit, rank, payment or status
  change. It found and led to the fixes for:
  - a null end time crashing coach today;
  - historical sessions leaking into today and week views;
  - undo deleting imported rows;
  - the 50-cap on visits;
  - DSAR and erase gaps.

## 7. What blocks the production import (Noe)

1. **Push = deploy + migrate production.** `main` auto-deploys and runs `prisma migrate deploy`. The migration is additive.
   The push is yours to make; I have not pushed.
2. **Members first.** Production `totalbjj` has 0 members until the members import runs (operator sequence in
   `SEAN-HANDOVER-VERIFICATION-2026-10-03.md`).
3. **Export time.** The file carries none. The download time **3 Oct 2026 13:51 (UK)** is the provisional value; tick
   "This is an estimate".

## 8. Steps for Noe, after 1–3

Settings → Import → **Attendance history**:
1. Choose `report-download-rKihmxrY6z4fvoA5wZTPNn.csv`.
2. Set export time `03/10/2026 13:51` and tick *estimate*.
3. Upload and preview. Expect: 15,273 rows · 486 people · 1,684 sessions · 13,795 / 1,331 / 82 / 65.
4. Venue *Total BJJ* → **This club**.
5. Each of the 14 offerings → **Historical class** (or a timetable class, if Sean has built one with that name).
6. **Save** → **Import attendance history** → **Import**.
7. Expect: 13,592 visits recorded, 45 linked, 1,471 bookings only, 165 waiting (14 people), "every one of the 15,273 rows
   is accounted for".
8. Download the 4 ledger parts.
9. Later: add the 5 children (parent first) and map them and the 9 attendance-only people under People, then import the
   same file again. Only their bookings change.

Sean's own login handover is separate and unchanged by this work: password reset → own password → TOTP, per the
handover record. This import proves nothing about it.

## 9. Commits (local, unpushed)

| SHA | What |
|---|---|
| `bfd9e66` | schema + migration (test branch only) |
| `78913ee` | detection, parser, planner (root cause) |
| `499d40f` | chunked verified uploads, retention |
| `62b1a11` | engine, routes, panel, export, reconcile script, runbook |
| `8eaec8e` | consumers: no side effects, truthful display, DSAR |
| `abc36de` | members import keeps its file on a failed run |
| this record | evidence |

Not pushed. Pushing `main` deploys production and applies the migration.
