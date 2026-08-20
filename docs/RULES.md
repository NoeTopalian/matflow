# MatFlow — the rules

The constitution. [`docs/UI-RULES.md`](UI-RULES.md) remains the authority for UI and is
not repeated here; this covers everything else and is binding in the same way.

Every rule below has a **why** drawn from something that actually went wrong in this
codebase. None of them are style preferences. Where a rule is greppable it is enforced by
`scripts/check-ui-rules.mjs`, whose counts may only ever go down.

---

## 1. Voice — plain and competent

MatFlow tells a gym owner and their members what happened. It does not sell to them, and
it does not perform enthusiasm.

- **Say what happened.** "Class booked." "Couldn't load — tap to retry." Not "Great news!"
  and not "Oops! Something went wrong."
- **British English, sentence case.** No exclamation marks. No emoji in product copy.
- **Errors state the fact and the next action**, in the interface's voice. They do not
  apologise, and they are never vague about what failed.
- **Never blame the user.** "That code doesn't match a club" — not "You entered an
  invalid code".
- **An empty state is an invitation**, not a dead end: say what will appear here and how
  to make it appear.
- **Never promise what the product cannot do.** This is the rule that was broken most
  this week — see §2.

**Why:** the product's credibility with a club owner is the whole business. Copy that
oversells makes every genuine message less believable.

## 2. Honesty of state — the rule this codebase kept breaking

A control that cannot deliver must not exist. Copy that describes a capability must be
traceable to a working implementation.

- **A control with no working path is deleted, not hidden or disabled.** In one week we
  removed a push-notification checkbox, a demotion banner promising class reminders, and
  two "Notifications" switches — all of which wrote state nothing ever read, on a channel
  with no delivery mechanism at all.
- **An HTTP error is never an empty state.** A failed fetch must render an error with a
  retry, never "you have no members". Twelve staff pages once caught a database error and
  rendered zeros — including the front-desk check-in screen, and a Reports page showing a
  full month of £0 indistinguishable from a genuinely bad month.
- **Never fabricate placeholder data.** A demo fallback must be impossible in production.
- **A success message must mean success.** Do not report "Class updated" for a field the
  server silently discarded, or "removed" for a delete that matched no rows.

**Why:** each of these turned an outage or a bug into a confident lie, and a lie the user
acts on is worse than an error they can see.

## 3. Money

- **Never read a field the pinned Stripe API version does not define.** Verify against the
  SDK types or a live test-mode call — not documentation, not memory. On
  `2026-03-25.dahlia` an Invoice has no `charge` and no `payment_intent`; code read both
  for months and stored nulls.
- **No `as unknown` / `Record<string, unknown>` casts on a payment path.** A cast through
  `unknown` silences the one check that would have caught the above.
- **Every money mutation is idempotent**, with the idempotency key reaching Stripe.
- **Distinguish a decline from an unknown outcome.** A card decline is settled; a network
  failure is not, and must never be reported to staff as "it may have gone through" when
  the request never reached Stripe.
- **The ledger reconciles to Stripe.** Cumulative totals are read back from Stripe, not
  computed locally, so an idempotent replay cannot double-count.
- **Money columns carry database CHECK constraints.** Application validation is one bug
  away from being bypassed by a script or an incident-time SQL fix.

## 4. Tenancy

- **The application-layer `where: { tenantId }` filter is the primary defence.** RLS is a
  backstop and is currently *decorative in production*, because the connection role holds
  `BYPASSRLS`. Write every query as though nothing is behind it.
- **Prove ownership before any destructive write**, not after. Returning `null` from a
  Prisma interactive transaction **commits** — it does not roll back. A check placed after
  the deletes let one gym destroy another gym's roster and answered 404 to the attacker.
- **Never take `tenantId` from the request.** It comes from the session.
- **Scope through a relation when a table has no `tenantId`** (`member: { tenantId }`),
  never by trusting the id in the URL.

## 5. Data

- **Destructive actions are audited with enough detail to reverse them.** Record *which*
  rows, not just how many — a count cannot restore anything.
- **Confirm before destroying.** Anything permanent and un-undoable is gated behind the
  `ConfirmDialog` primitive, naming what will be lost.
- **A cascade that removes user-visible state must be visible to the user.** A staff edit
  silently unsubscribing every member of a class is data loss with a success toast.
- **Soft-delete columns must be filtered by every reader**, or they are worse than no
  soft-delete at all.

## 6. Verification

- **Claims are measured, not asserted.** Contrast ratios come from computed styles in a
  real browser; row counts from the database; API shapes from a live call.
- **Every behavioural fix is mutation-tested**: revert the fix, watch its test go red. A
  test that still passes is not a test — rewrite it. This has caught vacuous tests of mine
  twice.
- **A gate that cannot fail is not a gate.** `lint` once ran `eslint && ratchet`, so a
  single lint error silently skipped the entire UI ratchet while the docs claimed it was
  enforced. Both halves now always run.
- **Never weaken an assertion to get green.** If a test cannot pass without weakening it,
  that is a finding, not a change.

## 7. Accessibility floor

Non-negotiable, and checked at the two accents UI-RULES §2a names:

- 4.5:1 minimum contrast for text, measured against the composite background.
- Every input has a programmatic accessible name; validation errors are announced.
- Overlays trap focus, close on Escape, and clear the fixed navigation.
- Interactive targets meet the touch floor except where `.ui-fixed-size` opts out.

## 8. Performance budgets

To be set from measurement, not guessed. Placeholder until the speed lane reports —
an unmeasured budget is a wish, and this section will state real numbers or nothing.

---

## Enforcement

Greppable rules become ratchet metrics in `scripts/check-ui-rules.mjs`. The discipline is
always the same, and it is the point of the whole mechanism:

1. Measure the true count — including matches inside comments, which the ratchet greps.
2. Baseline honestly at that number, even when it is embarrassing.
3. Counts only ever go down. **Never raise a baseline to accommodate new violations** —
   that is the failure mode the ratchet exists to prevent.
