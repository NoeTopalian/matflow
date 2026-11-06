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

### 5b. Mats and the timetable split (Noe, 5 Nov 2026)

- **A mat is one of a club's training areas** ("Mat 1", "Cage", "Upstairs"). The club names
  its own, up to twelve, each up to 24 characters; two names that differ only in capitals or
  spacing are the same mat. Mats belong to the club, not to a venue. Their order is the order
  of the columns.
- **A class is on a mat or it is not; the mat is the truth.** While a class is on a mat its
  place, everywhere in the product, is that mat's current name: renaming a mat renames the
  place of every class on it in the same write (`lib/mats.ts`, the write-through rule). A
  class on no mat keeps whatever place was typed.
- **Removing a mat never removes a class.** Its classes stay on the timetable with no mat and
  keep the mat's name as their typed place, so adding the mat again puts them back in one
  press. Two classes on one mat at the same time are shown side by side and are neither
  flagged nor blocked: that is the club's own set-up.
- **Mats are set up from what the club already typed.** The places typed on classes are offered
  as mats; nothing is turned into a mat without a press, and no migration writes one.
- **The split: by mat or by time.** Until someone chooses, a timetable is split by mat while
  two or more mats have a class on them, otherwise by time; that is worked out each time and
  never saved. Once an owner or manager presses a choice it is saved for the club and stays
  until someone changes it. By mat cannot be chosen while no class is on a mat. When an
  action changes the split by itself, the product says so.
- **One split for the whole club.** The staff week, the staff Day view, the staff phone and the
  members' day all follow it. A phone, and the members' day, show mat columns while the day
  needs three side-by-side columns or fewer; a busier day is drawn by time, every class names
  its mat, and the screen says so.
- **Who may change them:** owner and manager. A coach or an admin sees the split and the mat
  names and changes neither. In a MatFlow support session a class can be put on a mat (it is
  a class edit) but mats cannot be set up and the split cannot be changed: those are the
  club's.
- **Not undone from Activity.** Mats and the split are changed back where they were changed,
  on the Timetable page. Undoing a class edit re-derives the class's place from its mat and
  never copies an old name back.

### 5c. Activity (Noe, 5 Nov 2026)

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
  ordinary way keeps the name recorded on their deletion, permanently (§5d).
- **All of it, with no age limit.** The timeline reaches back to the club's first day. Nothing
  says or implies that activity is kept for a year.
- **It opens predictably.** The page opens on the standard view, or on the one view a person has
  deliberately saved as their default on that device. It never silently restores the last
  filters. The address bar is the only copy of the filters, so a link means what it shows.
- **Not configurable, by decision:** row density, columns, time format and zone (always the
  club's clock), page size, sort order, which roles see which types, a club-wide default view,
  faces or initials in rows, a colour per group.
- A check-in with a warning is still a check-in: it shows as "Check-in with a warning" and is
  also found by the "Check-in" filter.

### 5d. Nothing is deleted automatically (Noe, 6 Nov 2026)

- "Nothing should be automatically deleted." "All data from the entirety of the club should be
  held." No scheduled job, cron, expiry or clean-up removes a club's records or files: not the
  Activity log, email delivery logs, sign-in records, expired sign-in and reset links, Stripe
  webhook records, import jobs, their uploaded files or diagnostics, replaced promotion photos
  (kept, marked replaced and hidden from photo lists), push subscriptions (marked inactive
  instead), or a closed club (kept, sign-in disabled, reopenable at any time; the 16 Oct 2026
  rule).
- **Deletions a person deliberately makes stay**, because each is recorded in Activity and many
  can be undone: staff removing a member, a photo, an announcement (with its image), a roster
  entry or a class; unticking attendance; an import rollback; an erasure request. A photo someone
  uploaded and then did not save was never club data, and is removed (the upload's own
  clean-up).
- **Kept data stays erasable — no orphaned files.** A member's erasure reaches everything kept:
  their rows in every stored import file and every import report entry naming them
  (`lib/importers/import-erasure.ts`), and their photos, replaced ones included. A club's
  erasure deletes every file under its store prefix.
- **Two automatic exceptions, both security records, not club data:** sign-in rate-limit
  counters (`RateLimitHit`, and a bucket cleared after a successful sign-in), which the lockout
  depends on clearing; and password history, trimmed to its limit when a password changes
  (`lib/password-policy.ts`).
- Removing a class-pack redemption when its attendance is unticked is part of that deliberate
  action, not an automatic deletion.
- **Erasure on request only.** A data-protection erasure removes a member's details as above,
  and a club is erased only when it asks in writing: Noe or an operator runs
  `scripts/erase-closed-club.mjs` by hand (`docs/RUNBOOK.md`); never an agent, a schedule or CI.
- The nightly retention job keeps its Stripe reconciliation and prunes only the rate-limit
  counters; `tests/unit/retention-cron.test.ts` and `tests/integration/cron-smoke.test.ts` fail
  if it deletes anything else. Do not add a rule that deletes club data.
- **Outside MatFlow's control:** Neon's point-in-time backups, Resend's dashboard and Vercel's
  runtime logs have their own provider windows. They are not the records; the tables are.

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
