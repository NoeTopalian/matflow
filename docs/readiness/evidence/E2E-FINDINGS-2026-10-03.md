# e2e findings — overnight 2–3 October 2026

Produced by the assess-lane sweep after the Neon test-branch connection recovered
(gate medians 336 / 349 / 297 ms; it had been 1.3–2.7 s earlier in the evening,
which is why the first sweep attempt was abandoned at 12 of 29 files).

Every file run one invocation at a time, `--project=chromium --workers=1`.

## F-1 — PRODUCT DEFECT · a dispute closing with an unmapped status answers 500

**Where:** `app/api/stripe/webhook/route.ts`, the `charge.dispute.closed` branch
(the `event.type === "charge.dispute.closed"` block from line ~913; the catch that
answers `{"error":"Processing failed"}` with 500 is at line ~1270).

**Reproduced by:** `tests/e2e/campaign/assess/le-3-webhooks-and-billing.spec.ts:188`
— "a close status the handler does not map leaves the row readable, never 500".
Sends `charge.dispute.created` with `warning_needs_response`, then
`charge.dispute.closed`. Expected `< 500`, received **500**.

**Why it matters:** Stripe retries a webhook that answers 5xx. An unmapped close
status therefore means repeated failed deliveries and a `Dispute` row that never
reaches its final state — on the surface that handles chargebacks. The test's own
name states the intended contract: unmapped should leave the row readable, never
500.

**Root cause NOT yet isolated.** Two things ruled out:
- `Dispute.status` is a plain `String` in `prisma/schema.prisma:1147` with no enum
  and no CHECK constraint, so the column does not reject an unknown value.
- The status normaliser (`route.ts` ~939) ends `return s;`, so it passes an
  unmapped status through rather than throwing.

So the throw is elsewhere in that branch. The next probe is the `won` /
`charge_refunded` / `lost` sub-branches, which call `tx.payment.update(...)`, and
the owner-notification path — one of those is the likely thrower when
`linkedPayment` is null or the status matches none of them. Needs a focused look,
not a guess.

**Not fixed.** Flagged rather than patched: the tree held uncommitted family-
authority work pending a product decision, and mixing a billing change into it
would have been poor hygiene.

**Bearing on the first Total BJJ handover:** low. Total BJJ stays TeamUp-billed
for the first handover, so MatFlow's Stripe dispute path is not exercised. It
becomes a release blocker the moment a club takes card payments through MatFlow.

## F-2 — UNPROVEN · two security assertions never completed

Both failed with an empty `AggregateError`, the connection-level signature, not an
assertion. Neither demonstrated a leak; neither proved its absence. **Must be
re-run** before either is counted:

- `le-2-refund-and-packs.spec.ts:533` — "a member cannot read another member's payments"
- `le-3-webhooks-and-billing.spec.ts:350` — "members/[id]/charge is owner-only and has an activation check"

## F-3 — TEST FRAGILITY · the lane is untrustworthy between midnight and ~04:00

`ld-2-attendance` lost 3 cells to `{"reason":"outside_window"}` — the product
correctly refusing a check-in for a class that has finished. The specs seed classes
at fixed wall-clock times (e.g. `mkInstance(cls, { startTime: "03:00", endTime:
"04:00" })`, the variable named `closed` because 03:00 was assumed to be outside
anyone's window). Run at 01:00 that assumption inverts.

This also explains the "known a0-5 day-boundary cell" that was the single red in
the 1 Oct pass — same family, pre-dating this work.

**Not patched.** Choosing different fixed hours relocates the bug; the real fix is
seeding relative to `now()`, which is a deliberate refactor.

**Owed:** a daylight re-run of `ld-2`, and of the three `outside_window` cells
specifically.

## F-4 — STALE FIXTURE, FIXED · the TeamUp upload now requires an export time

`lc-3-import-photos-cards.spec.ts:611` uploaded a TeamUp CSV with no
`sourceExportedAt` and got a 400:

> "Enter when the TeamUp file was exported — memberships that start or end around
> that date depend on it." (`app/api/admin/import/upload/route.ts:145`)

The guard is correct and is exactly what the launch register says Sean must supply.
The spec predated it. Fixed: the fixture now states an export time as a real owner
would. **Owed:** re-run `lc-3`.

## Tallies

| File | Result | Classification |
|---|---|---|
| `lb-1-club-setup` | 29 passed | clean (recovered — had lost 27 to a latency `beforeAll` timeout) |
| `lb-3-ownership-and-integrations` | 12 passed | clean (recovered — had lost 1 to `getaddrinfo ENOTFOUND`) |
| `lc-1-members` | 27 passed | clean (recovered — 2 earlier failures were an `afterAll` timeout) |
| `lc-3-import-photos-cards` | 12 passed, 1 failed | F-4, fixture fixed |
| `ld-1-timetable` | 26 passed | clean |
| `ld-2-attendance` | 23 passed, 3 failed | F-3, clock |
| `le-1-cash-and-tiers` | 44 passed | clean |
| `le-2-refund-and-packs` | 20 passed, 1 failed, 1 skipped | F-2 |
| `le-3-webhooks-and-billing` | 22 passed, 2 failed, 1 skipped | **F-1 (real)** + F-2 |

All three files damaged by the bad connection came back clean on re-run, which
settles that the abandoned sweep hid no defects in them.

**One real product defect found across every e2e test run on 2–3 October.**
