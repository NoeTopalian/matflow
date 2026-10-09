# Final retest (R) of lane D fourth pass at 0964571, 9 Oct 2026 (saved by the coordinator from the hand-back)

Verdict: NOT APPROVED, narrowly. The new rule works for every change recorded in the recognised audit formats; one real in-app route changes a member's own address without such a row. SHA 0964571f8e3c39633c73b7efe46a7a6afce9ec56 (diff vs 3be9490); reviewer wrote none of the code; scratch worktree (removed); guarded runners on TEST, both roles, identical results per cell. Lane suite sec-d-attendance-misbinding-db 21/21 both roles; unit 220/220 (ambiguity, import-attendance-route, release-digests).

## The 18 REPORT-D3 cells re-run (23/23 under each role incl. 5 new)
All pending (safe): accent, rename, zero-width, Cyrillic, raw SQL, unkeyed, delete+recreate, old-acquirer cells for unkeyed / DELETE / DSAR / rollback / staff (every release path 200 + digest). Formerly BOUND cells now pending: raw-SQL release with an old acquirer; never-held address with an old acquirer; key rotation (the acquirer's own PATCH is visible by subject and time). The only bound cell is the control (held the address all along) — correct. Straddle → pending; future-dated → future.

## Named evasions
1. Old-format row — an address change recorded only as {changes:{email}} with none of the three digest keys: BOUND (rule cannot see it).
2. Back-dated / future release row — 1 s before the earliest booking: BOUND; exactly at the booking instant: pending (>=); future: pending. Back-dating needs a direct UPDATE of the audit row (SF-57 permits it); not reachable through any route.

## Real in-app evasion (new)
Guardian confirm with adoptUnverifiedEmail: true (app/api/members/[id]/guardian/route.ts) changes the PARENT's login address; the only audit row is member.guardian.confirmed with entityId = the child and metadata.emailAdopted: true — no digest, nothing on the parent. Through the real route on both roles an old parent who adopted the address after the bookings was BOUND (guardian 200, address adopted). Fix: write an address-change row for the parent (entityType Member, entityId = parent, oldEmailSha256 of the synthesised address) or make addressChangedAt also read emailAdopted. The binding is plausibly the same person (the unverified address usually came from the TeamUp import) but breaks the rule's premise.

## Final residual for C3 (at 0964571)
A member who existed before the bookings still receives the history when they took the address after the bookings by a path that leaves no recognised own-address audit row: guardian adoption today, raw SQL, an old-format row, or an audit row back-dated directly in the database (SF-57).
Fixtures: all secr-; teardown count-checked incl. audit rows; read-only scan afterwards 0 secr- tenants / members / probe rows — clear for the full sweep. Logs <scratchpad>/security/R/logs/D4-* (D4-route-results.txt, leftover.txt), d4-summary.txt; scratch test zz-r-d4-route-db.test.ts (not committed).
