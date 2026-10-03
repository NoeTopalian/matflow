# Importing a club's attendance history

Settings → Import → **Attendance history**. Owner only (authenticator code required). Built against the real Total BJJ
TeamUp attendance export on 3 Oct 2026 (26 columns, 15,273 rows, one row per booking). Engine:
`lib/attendance-import.ts`; parser and planner: `lib/importers/attendance.ts`; route: `app/api/admin/import/attendance`.

Import the **members first** (Settings → Import → Members, Source TeamUp). People are matched by the TeamUp identity the
members import kept, never by a name alone.

## What an import does — and never does

It records history. Every booking in the file is kept as a source fact (`ImportedBooking`), whatever its TeamUp status.
Only an **Attended** booking of an identified member in a session that has happened becomes attendance
(`AttendanceRecord`, method `import`), on a past class session. It never charges, invoices, sends an email or push,
uses a class credit or visit allowance, changes a membership, a rank, a waiver or a guardian link, or goes near the
check-in route. Registered, No show and Late Cancelled stay bookings: they are never attendance, never a payment and
never a penalty. Imported attendance is excluded from the public TV leaderboard.

## Steps (what the owner does)

1. Choose the TeamUp attendance report CSV. The browser reads the header: a memberships export is refused here with
   the path to use, and the attendance file is refused by the Members import.
2. Enter when the file was exported (club time; tick "estimate" if not exact). A later export changes a booking's
   status only when it is newer than this.
3. Upload and preview. The file is sent in 1 MiB parts and verified by size and SHA-256 before it is read (a single
   request of the whole file is over the host's 4.5 MB limit). The preview shows the file's own controls (rows, the
   four statuses, people, sessions, offerings, venue, booking methods), the columns not imported, and what would happen.
4. Decide:
   - **Venue** — this club, a location, or leave pending.
   - **Classes** — map each TeamUp offering to a class on the timetable, to a **historical class** (holds past
     sessions only; inactive; no schedule, coach, length or capacity; never on the timetable, at the door, in booking
     or the coach's today view), or leave pending. Suggestions are pre-selected but nothing counts until **Save**.
   - **People** not identified — choose a suggested member (same name or same email), search for any member, or keep
     pending. Pending bookings are kept privately and become attendance when decided; preview again after adding a
     missing member. MatFlow does not create members from an attendance file: a person who is not a member yet (for
     example a child the members import refused because no parent could be identified) is added by staff under Members
     first — parent before child — and then mapped here.
5. Import. The import runs in saved steps with a progress bar. Closing the page or a failure stops it at the last
   saved step; reopening the panel shows it with **Resume**. Nothing is counted twice.
6. Afterwards: download the booking ledger CSV (one row per booking with what MatFlow did; in parts of 5,000
   bookings, because a response from the host is capped at 4.5 MB), check the import history, and roll back from there
   if needed.

## Data contract

| Source column | Treatment |
|---|---|
| Customer Name, Customer Email | Identity key `teamup:<email>|<name>` (trimmed, lower-cased) — the members import's `Member.externalRef`. Missing emails kept. |
| Event Starts At | Exact instant from its offset (+00:00 / +01:00); raw text kept; club date/time in the club's timezone. |
| Offering Type Name | Offering label kept; mapped explicitly to a class. |
| Venue Name | Venue label kept; mapped explicitly; unresolved stays visible. |
| Instructors | Kept as given (empty here); no coach is assigned. |
| Booking Method | Kept (Membership / Free); not a payment or an entitlement. |
| Customer Membership ID | TeamUp membership *instance* reference; never a person id. |
| Membership ID, Membership Name | TeamUp plan reference/label; not the member's MatFlow plan. |
| Booking Source | TeamUp channel; no staff actor is invented. |
| Status | Attended / Registered / Late Cancelled / No show kept distinct. |
| Checkin Timestamp | Kept; empty means "not known". The visit is dated by the session start for counting, and screens show the check-in time as "Not recorded". |
| Address, phone, gender, date of birth, emergency contact, marketing preference | Not imported (shown as such). An attendance file never changes a profile, infers consent or creates a guardian. |

Unknown columns are listed in the preview. A repeated column, an unreadable date or an unknown status is an error
before anything is written; nothing is imported until every row can be read.

## Sessions, visits and keys

- A session is (start instant, offering mapping, venue mapping): offerings sharing a start are different sessions.
  An existing timetable session at the same class, date and time is reused; otherwise a past session is created with
  **no end time** (`ClassInstance.endTime` NULL, `sourceImportJobId` set). Future sessions are never created.
- A booking key is (person key, start instant, offering, venue) — never the status.
- One visit per person per start instant: a second attended booking at the same instant (two offerings booked
  together), or a check-in MatFlow already has, is linked to that visit, never counted twice.
- Two different instants that the club's wall clock cannot tell apart (the autumn repeated hour), or one booking with
  two statuses in one file, are held as a conflict for the owner.

## What imported visits count towards (source policy)

An imported attended visit is a real visit and is counted like one wherever MatFlow DISPLAYS attendance: reports
(labelled "Imported"), the member's profile ("Total visits", with a line summarising the TeamUp booking history), member
stats and streaks, "at risk" lists and the coach's promotion suggestions (attendance since the rank's date). None of
these changes anything by itself: nothing promotes, rewards, charges or notifies on a count. It is NOT counted on the
public TV leaderboard, and it never consumes a class credit or visit allowance. A visit is counted once: the import
links rather than duplicates. Registered, No show and Late Cancelled are never counted as visits.

## Re-import, later exports, rollback

- The same file again (or re-ordered, or overlapping) creates nothing new; the preview says "already imported".
- A newer export updates a booking's status (e.g. Registered → Attended adds one visit); an older or same-time export
  never overwrites a newer fact. Absence from an export never deletes or cancels anything.
- A visit the import created that staff removed stays removed — through later exports and through rollbacks.
- If a corrected booking owned a visit another booking of the same person at the same start also counts, the visit
  stays and passes to that booking.
- The export time decides freshness. An over-estimated time ("estimate") makes a later, earlier-dated export count as
  older: enter the real time when it is known, and check "older than what MatFlow has" in the preview.
- Rollback removes only what that import created and nothing has touched since; bookings it updated go back to how
  they were (layer by layer: rolling back the newest import and then the one before restores both); bookings a later
  import changed, sessions or visits now in use, and historical classes staff have since used are kept and counted
  with the reason. Rollback is refused while another attendance import is running.

## Reconciliation

`node scripts/readiness/attendance-reconcile.mjs --csv <file> --tenant <slug>` (test branch only, read-only, its own
parser): every CSV row has exactly one booking and no booking lacks a row; statuses equal; identities equal the
derivation above; every attended booking of an identified person in a decided session points at an attendance of that
member at that club date/time; no attendance on a non-attended or pending booking; every provisional session has a
disposition; imported sessions carry no end time.
