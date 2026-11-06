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

### 5a. Imports and later uploads (Noe, 25 Oct 2026)

- "A later upload must not silently overwrite existing MatFlow values. Add genuinely new
  records, skip exact duplicates, and show conflicting or ambiguous records for an authorised
  person to resolve. Where previous ownership or edit history is unknown, preserve the current
  value and flag the conflict."
- "Keep the existing role permissions… Imported records should be editable through the same
  authorised workflows as equivalent MatFlow-created records. No new access to prices,
  financial records or status changes is approved."
- "Keep production-derived evidence private. The sanitisation instruction includes customer
  totals."
- Once imported, data is MatFlow's; the source is only where it came from (24 Oct). An import
  never starts a charge, a subscription or a message, and never invents a billing value the
  file does not carry. A clear new person whose plan matches no single MatFlow plan is
  imported without one and listed for the owner.
- How it works: `docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md` §3.

### 5b. Activity (Noe, 5 Nov 2026)

- **One timeline, shown everywhere.** The club's history is read through one component and one
  route: the Activity page (the whole club), a member's History, and later a class's and a
  payment's. A member's history stays on the member's page.
- **Who reads it.** The owner and managers. Only the owner undoes. Coaches never see it.
- **What a manager sees is fixed, not a club setting.** A manager sees an activity type only if
  they can already open the page those records live on: club life, including money. Never staff
  changes, sign-in and security events, club settings, data exports and erasures, imports, plan
  set-up, MatFlow support activity or Undo. The server enforces it on every request; a manager is
  shown which fields changed, never the old and new values.
- **A sentence says only what the record establishes.** It is built from the ids stored on the
  audit row, never from a member's or class's current state. An action without a sentence of its
  own shows its existing label; nothing is guessed.
- **Erased is not the same as deleted.** A member erased under a data-protection request is
  "Deleted member": no link, and their old values are shown to nobody. A member deleted in the
  ordinary way keeps the name recorded on their deletion for the year the log is kept.
- **It opens predictably.** The page opens on the standard view, or on the one view a person has
  deliberately saved as their default on that device. It never silently restores the last
  filters. The address bar is the only copy of the filters, so a link means what it shows.
- **Not configurable, by decision:** row density, columns, time format and zone (always the
  club's clock), page size, sort order, which roles see which types, a club-wide default view,
  faces or initials in rows, a colour per group.
- A check-in with a warning is still a check-in: it shows as "Check-in with a warning" and is
  also found by the "Check-in" filter.
- **What the new events hold about a person.** The events added with the timeline (a membership
  started, a class pack bought, a shop order paid, a class booked, a booking cancelled) hold ids,
  counts and amounts only: no name, no message, no address, no free text. They are written
  through `lib/activity-events.ts`, which checks each row against a closed shape. In tests and
  development a row outside its shape is an error; in production the keys it does not know are
  dropped and the event is still recorded.
- **What older rows hold.** Rows that existed before the timeline keep more, and still do: a
  member edit keeps the old and new value of each changed field (name, phone, date of birth,
  emergency contact); a child's waiver and a removed child keep the child's name; a refund and a
  desk-paid order keep the reason staff typed; a conversion credit keeps a typed name. By
  decision, a member deleted in the ordinary way keeps their name on that one deletion row for
  the year the log is kept, so the timeline can say who was deleted. The owner is shown these
  values; a manager is shown which fields changed, never what they held.
- **An erased member.** None of the five new events is written about a member who has been
  erased (the writers that hold the member's address check it; a booking cannot come from an
  erased member, who can no longer sign in). Other rows that name their id, such as a refund of
  an old payment, are still written. Every row about them, old or new, is shown as "Deleted
  member" with no link and no old values. The stored rows are not rewritten by the erasure: they
  go when the log's year is up, or sooner by the runbook
  (`docs/security/INCIDENT-AND-RESTORE-RUNBOOK.md` section 7).
- **A new event is written once.** A class pack, a shop order and a booking are written inside
  the transaction of the change they record: a replayed Stripe event or a repeated tap finds the
  change already made and writes nothing, and a rollback takes the row with it. A membership
  start is keyed by its Stripe subscription; the check for an earlier row and the write are one
  transaction behind the Member row lock, so two requests take turns and the second writes
  nothing.
- **A membership "started" is not a payment.** The row is written when the subscription is
  created, before any money has moved, and says "awaiting first payment". The payment is its own
  row when it arrives.

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
