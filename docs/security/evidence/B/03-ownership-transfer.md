# B-03 — Ownership transfer on the database (AH-R7 transfer part; SEC-032, SEC-013, SEC-017)

Lane B, 9 Oct 2026, candidate `2a6487e` + lane-B working-tree changes. TEST branch, synthetic clubs, both DB roles.

## Finding SEC-B-F3 (Medium) — concurrent ownership transfers leave a club with TWO owners

- **Asset / path:** `app/api/staff/[id]/transfer-ownership/route.ts` (owner, password re-entered) and
  `app/api/admin/customers/[id]/transfer-ownership/route.ts` (operator, step-up).
- **Mechanism:** each transaction read "the caller / the first owner is the owner", then updated BY ID with no
  condition. Under READ COMMITTED the second UPDATE waits for the first transaction's row lock and then writes anyway,
  so both promotions commit: the old owner is a manager and two other people are owners.
- **Prerequisites:** two transfers in flight at once — the owner on two devices (password + live session on each), or
  the owner and an operator (operator step-up). No attacker-only path; impact is an unintended extra owner with full
  club powers (billing, staff, exports) and a broken "exactly one owner" invariant (ADR-001 D7), which other code relies
  on (`findFirst({ role: "owner" }) orderBy createdAt` picks one of the two).
- **Reproduced (red):** `tests/integration/sec-b-ownership-transfer-db.test.ts` against the pre-fix routes
  (`git show HEAD:<route>` swapped in, then restored): cell 6 (free race, two connections) `[200,200]` → 2 owners;
  cells 8a (owner × owner) and 8b (owner × operator) with a third connection holding the owner's row lock so both
  requests read before either writes → `[200,200]` → 2 owners, deterministically. Cell 7 (free owner × operator race,
  6 staggered iterations) did not interleave on its own; 8b is the deterministic proof of that path.
  Logs: `<scratchpad>/security/B/logs/transfer-owner-red2.log`, `transfer-owner-red3.log`, `transfer-owner-red4.log`.

## Fix (minimal)

Both routes: the demotion is `updateMany({ where: { id, tenantId, role: "owner" } })` and the promotion
`updateMany({ where: { id, tenantId, role: <role read> } })`; a count other than 1 throws inside the transaction, so
the loser rolls back whole (operator: the grant spend and the audit row included) and answers **409** "Ownership changed
while you were confirming". Postgres re-evaluates an UPDATE's WHERE against the committed row after the lock wait, so
only one demotion of the current owner can succeed. The owner route's audit row moved INTO the transaction (it was
written after commit, best-effort): a transfer can no longer commit without its record.

Changed: `app/api/staff/[id]/transfer-ownership/route.ts`, `app/api/admin/customers/[id]/transfer-ownership/route.ts`,
`tests/unit/staff-transfer-ownership.test.ts` (it pinned the unconditional `update({ where: { id } })` shape; now pins the
conditional form, the in-transaction audit, and a new 409 cell — outside the `sec-b-` prefix, flagged for the lead).

## Results after the fix

| Run | Runner | Exit | Result |
|---|---|---|---|
| owner role | `bash <scratchpad>/att/run-engine.sh tests/integration/sec-b-ownership-transfer-db.test.ts` | 0 | 9/9 |
| restricted (`matflow_app`, RLS) | `bash <scratchpad>/q78/run-restricted.sh tests/integration/sec-b-ownership-transfer-db.test.ts` | 0 | 9/9 |
| unit | `npx vitest run tests/unit/staff-transfer-ownership.test.ts` | 0 | 7/7 |

Cells: (1) owner→manager: roles swap, both people's `sessionVersion` +1, `checkSessionVersion` (the per-request check
auth.ts runs) answers `revoked` for both old tokens and `ok` for the new one and for an uninvolved coach (positive
control); one audit row. (2) a stale owner JWT cannot transfer again: the route re-reads the role (403, nothing
changed). (3) the old owner's fresh session carries `manager` and is refused an owner-only route (`POST /api/staff`
403, nothing created) while the new owner passes it (201). (4) object-level: a target in another club → 404, that club
byte-identical. (5) operator transfer → one owner; replay of the same grant → `alreadyApplied`. (6, 7) free races →
exactly one owner. (8a, 8b) forced interleavings → exactly one owner, the loser 409, only the winner's audit row.

## Residual / cross-boundary chain

Removal of the old owner's powers on an existing session depends on the per-request `checkSessionVersion`; that check
**fails open on a database error** (AH-G7, lane A's item). Chain: transfer commits → DB blip on the old owner's next
request → token kept with `role: owner` → owner-only routes that trust the session role (`requireApiOwner`) accept it
until the check succeeds again. The transfer route itself re-reads the role and is not affected. Lane A's fail-closed
work closes this chain; recorded here so it is not lost.

Status: SEC-032 APPLICABLE — REPRODUCED → FIXED, PASS (I, both roles) AWAITING INDEPENDENT REVIEW. SEC-013 (stale role
after transfer) PASS at I for the revocation verdicts; residual via AH-G7.
