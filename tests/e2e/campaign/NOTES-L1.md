# NOTES-L1 — `cash-money.spec.ts`

Lane 1 of the campaign: end-to-end coverage for the manual-payment ("cash money")
path. Written against the components, not against memory — every selector below
is quoted from the file it came from.

**Status: written, not run.** I was asked not to start a dev server or run the
suite. The file type-checks (`npx tsc --noEmit` → 0 errors project-wide) and
lints clean (`npx eslint tests/e2e/campaign/cash-money.spec.ts` → no output).
Nothing below is a claim that a test has passed.

---

## What the spec covers

| # | Test | Surface | Asserts in UI | Asserts in DB |
|---|------|---------|---------------|---------------|
| 1 | cash from the member-profile drawer | `MemberProfile` Sheet | toast, drawer closes, saved row `Cash — …` + amount, survives reload showing `Manual` | `Payment` row (amount, status, description, currency, requestId), `Member.paymentStatus → paid` |
| 2 | payment from the payments-hub modal, member found via typeahead | `RecordPaymentModal` from the page header | "Payment recorded" panel, modal closes, history row with name + `External — …` + amount + `Paid` pill | `Payment` row, `paymentStatus → paid` |
| 3a | cash at £0 refused, comp at £0 accepted | hub modal | submit **disabled** for cash/£0; amount label flips to `Amount (£) — optional for comp/exempt`; row with `Comp` + `£0.00` | `amountPence = 0`, `description = "Comp"` |
| 3b | cash at £0 refused, exempt at £0 accepted | profile drawer | submit disabled, then enabled; row `Exempt` + `£0.00` | `amountPence = 0`, `description = "Exempt"` |
| 4 | "Other" refused without notes, accepted with them | profile drawer | label becomes `Description / Notes (required)`, submit disabled → enabled; row `Manual — Door float top-up` | one row only, `description = "Manual — Door float top-up"` |
| 5 | recording advances the due date | profile drawer | toast + saved row | `nextDueAt` moves from 40 days past to ~20 days future, and is **< 26 days out** (proves it stepped from the old due date rather than re-basing on today) |
| 6 | overdue member on the outstanding list, gone after payment | Outstanding panel row → pre-picked modal | name link visible + `Overdue`; row's `Record` opens the modal with **no search box**; name link gone after; still gone after reload | `Payment` row, `paymentStatus → paid`, `nextDueAt` in the future |

`test.afterAll` calls `cleanupRun()` and deletes the membership tier **only if
this run created it**.

---

## Every selector, and where it came from

### Member profile — `components/dashboard/MemberProfile.tsx`

| Selector | Source |
|---|---|
| `getByText("Payment History", { exact: true })` | `<p …>Payment History</p>`, line ~1605 — used as the "tab is rendered" gate |
| `getByRole("button", { name: "Record", exact: true })` | `<Button onClick={() => setPaymentDrawer(true)}><Plus/>Record</Button>`, line ~1609. `exact` matters — the drawer's own submit is "Record payment" |
| `getByRole("dialog", { name: "Record payment" })` | `<Sheet … title="Record payment">`, line ~1863. `Sheet` → `OverlayShell` renders `role="dialog" aria-modal aria-labelledby={titleId}` (`components/ui/overlay.tsx`, lines 295–312) |
| `#profile-payment-method` | `id="profile-payment-method"` on the `<select>`, line 1878 |
| `getByLabel("Description / Notes", { exact: true })` | `aria-label="Description / Notes"` on the input, line 1891. The visible `<label>` has **no `htmlFor`**, so the aria-label is the only association — and it stays constant while the visible label gains " (required)" |
| `getByLabel("Amount (£)", { exact: true })` | `aria-label="Amount (£)"`, line 1903. Same story — the visible label is unassociated |
| `getByRole("button", { name: "Record payment", exact: true })` (scoped to the dialog) | Sheet `footer` button, line 1870 |
| `getByText("Description / Notes (required)")` | `methodNeedsNotes(payForm.method) ? " (required)" : ""`, line 1890 |
| `getByRole("table", { name: "Payments for this member" })` | `<DataTable label="Payments for this member">`, line 1635; `DataTable` renders `<caption class="sr-only">{label}</caption>` (`components/ui/data-table.tsx` line 242), which is the table's accessible name |
| Row text `"Cash — …"`, `"Manual — …"`, `"Comp"`, `"Exempt"` | `app/api/payments/manual/route.ts` `METHOD_LABEL` (lines 72–78) + `description = \`${label}${notes ? \` — ${notes}\` : ""}\`` (line 112). **Em dash U+2014, spaces either side** |
| Row text `"Manual"` (Method column, after reload) | `app/api/members/[id]/payments/route.ts` line 40 derives `method: stripePaymentIntentId \|\| stripeInvoiceId ? "card" : "manual"`; the column prints `"Manual"` (`MemberProfile.tsx` line 297) |
| Amount format `£40.00` | `MemberProfile.tsx` line 316: `{p.currency === "GBP" ? "£" : p.currency}{(p.amountPence/100).toFixed(2)}` — reproduced by `profileAmount()` in the spec, using the club's real `Tenant.currency` |

### Payments hub — `components/dashboard/PaymentsPageClient.tsx`, `RecordPaymentModal.tsx`, `OutstandingPanel.tsx`

| Selector | Source |
|---|---|
| `getByRole("button", { name: "All payments", exact: true })` | view tab, `PaymentsPageClient.tsx` line 300 |
| `getByRole("button", { name: "Record payment", exact: true })` (page level) | `PageHeader action`, `PaymentsPageClient.tsx` line 281 |
| `getByRole("dialog", { name: "Record a payment" })` | `<Dialog … title="Record a payment">`, `RecordPaymentModal.tsx` line 137 |
| `getByLabel("Search for a member by name")` | `aria-label` on the typeahead input, line 179. Only rendered when no member is pre-picked — the spec asserts `toHaveCount(0)` on the row-opened path to prove pre-selection |
| `getByRole("button", { name: <member name>, exact: true })` | search result row, `<Button variant="ghost">{m.name}</Button>`, line 191 |
| `getByRole("button", { name: "Change", exact: true })` | shown beside the picked member when `!member` prop, line 162 — used as the "selection landed" gate |
| `#record-payment-amount`, `#record-payment-method`, `#record-payment-notes` | explicit `id`s, lines 211 / 230 / 248. **Ids, not labels, deliberately**: both the amount and notes labels change text with the chosen method, so a `getByLabel` would be a moving target |
| `label[for="record-payment-amount"]` → `"Amount (£) — optional for comp/exempt"` | line 208 |
| `getByText("Payment recorded", { exact: true })` | success panel, line 150 |
| `getByRole("table", { name: "Payment history" })` | `<DataTable label="Payment history">`, `PaymentsPageClient.tsx` line 374 |
| Hub amount format | `formatPaymentAmount` / `currencySymbol` in `components/dashboard/payments-columns.tsx` lines 97–113 — reproduced by `hubAmount()` |
| Status text `"Paid"` | `PAYMENT_STATUS_META.succeeded.label`, `payments-columns.tsx` line 67, rendered as text by `StatusPill` |
| `getByRole("link", { name: <member name>, exact: true })` | outstanding row name link, `OutstandingPanel.tsx` line 154 |
| `"Overdue"` | `overdueLabel(null)` returns `"Overdue"` when there is no failed payment to date from, `OutstandingPanel.tsx` line 30 |
| `nameLink.locator("xpath=../..")` | **the one structural selector in the file.** The outstanding rows have no semantic container — see below |
| row-scoped `getByRole("button", { name: "Record", exact: true })` | `<Button …><Banknote/> Record</Button>`, `OutstandingPanel.tsx` line 183 |

### Toast

`getByRole("alert").filter({ hasText: "Payment recorded" })` — `components/ui/Toast.tsx`
line 54, `role="alert" aria-live="polite"`. The message string is
`MemberProfile.tsx` line 851.

---

## Fragile by construction — read before editing

**`nameLink.locator("xpath=../..")` (test 6).** `OutstandingPanel` renders each
row as a bare `<div>` with no role, no `data-testid` and no accessible name, so
there is nothing semantic to scope the row's Record button to. The walk is
`Link → div.min-w-0 → row div` and it is exact per lines 152–160 of that file.
If someone adds a wrapper element around the member name, this breaks and the
test fails on "Record button not found", not on a product regression. **The right
fix is a `data-testid` or a `role="listitem"` on the row**, not a cleverer
xpath — I did not add one because the brief was tests, not product changes.

**`getByRole("button", { name: "Record", exact: true })` on the member profile.**
Unscoped to a container, because the button sits in a plain flex div. It is
unique on that page today (the header's manual-payment trigger is "Mark paid
manually", the drawer submit is "Record payment"). A second bare "Record" button
anywhere on the profile would make this ambiguous.

---

## Known broken — found while writing this, NOT covered by a passing test

**Comp/exempt with a BLANK amount from the member-profile drawer posts `NaN` and
gets a 400.**

`MemberProfile.addPayment` (line 808):

```ts
const amountPence = Math.round(parseFloat(snapshot.amount) * 100);
```

With the amount field left empty, `parseFloat("")` is `NaN`, `JSON.stringify`
serialises `NaN` as `null`, and the route's `amountPence: z.number().int().min(0)`
rejects it — 400, "Failed to record payment" toast, no payment.

The payments-hub modal does not have this bug; it coerces (`RecordPaymentModal.tsx`
line 92):

```ts
const amountPence = Math.round((parseFloat(amount) || 0) * 100);
```

It bites specifically on comp/exempt, because those are the only methods where
`manualPaymentFormIsValid` enables the submit with an empty amount — so the
drawer offers a button the server is certain to refuse, which is the exact class
of bug this whole surface was fixed for yesterday. It is made worse by the
profile drawer's amount label reading a flat `Amount (£)` while the hub modal's
says `Amount (£) — optional for comp/exempt`: the drawer actively signals that
leaving it blank is fine.

**Test 3b types `"0"` explicitly** and therefore passes over this hole. I did not
write a failing test for it. One line in `MemberProfile.tsx` fixes it:

```ts
const amountPence = Math.round((parseFloat(snapshot.amount) || 0) * 100);
```

Once that lands, change test 3b to clear the amount field rather than typing
`"0"`, and it becomes real coverage.

---

## Gaps — things this file does NOT cover

1. **The third manual-payment surface is untested.** `components/dashboard/MarkPaidDrawer.tsx`
   ("Mark paid manually" in the member-profile header, Sheet titled "Mark as
   paid") posts to the same `/api/payments/manual` with its own method picker,
   its own notes field and a **`paidAt` date input the other two surfaces do not
   have**. Three surfaces exist; this file covers two. The `paidAt` path — which
   also feeds `advanceDueDate(…, paidAtDate)` — has no coverage at all.
2. **Duplicate submission / `requestId` dedupe.** The route's P2002 branch
   (returns the existing row with a 200 rather than a 409) is not exercised. That
   needs a deliberate double-submit race or a request interception, and it is the
   thing standing between a club and a double-charged member.
3. **Rate limiting.** 60 manual payments per tenant per 5 minutes
   (`RATE_LIMIT_MAX`) — not exercised. This spec makes ~6 payments, so it also
   does not risk tripping it.
4. **CSRF / `assertSameOrigin`.** Not exercised.
5. **Role gates.** Everything here runs as the owner (`tests/e2e/.auth/owner.json`).
   Manager-can, coach-cannot, admin-cannot (the drawer hides behind
   `canRecordPayment = ["owner","manager"]` while the route gates on
   `requireApiOwnerOrManager`) is unverified.
6. **The audit-log row.** `logAudit({ action: "payment.manual" … })` writes a row
   with the method, amount, notes and the new due date. Nothing asserts it.
7. **Mobile.** The `chromium` project is Desktop Chrome, so every assertion lands
   on the `<table>`. `DataTable`'s card layout below `sm:` (`renderCard`) — the
   layout a gym owner on the desk phone actually sees — is untested here.
8. **Annual and `none` billing cycles.** Test 5 uses a monthly tier only.
   `advanceDueDate` also handles `annual` (12 months) and `none` (clears the due
   date to `null`); neither is covered, and `none` is the branch that would
   silently stop a member ever coming due again.
9. **Revenue/reports roll-up.** Whether a cash payment reaches
   `getReportsData` / Settings → Revenue is not asserted.
10. **Refunds** of a manually recorded payment: out of scope, untested.

---

## Environmental hazards that can fail these tests for non-product reasons

- **Test 6 depends on the outstanding list being short.**
  `app/api/payments/outstanding/route.ts` takes `take: 200` **with no `orderBy`**,
  and the ranking in `lib/billing.ts` happens *after* that cut. If the test
  branch carries more than 200 overdue members (the helper's own header notes the
  branch already holds 23 junk tenants from an earlier era), our member can be
  cut before we ever get to sort, and the test fails on an empty list. If that
  happens, it is DB pollution, not a regression — prune the branch.
- **A monthly `MembershipTier` is required** for tests 5 and 6, because the route
  only advances `nextDueAt` when the member has a tier. `prisma/seed.ts` creates
  **no tiers**, so `ensureMonthlyTier()` reuses an existing active monthly tier if
  one is there and otherwise inserts a stamped one and deletes it in `afterAll`.
  That insert goes through `helpers/db.ts`'s raw `sql`, which sets no
  `app.current_tenant_id` GUC — the same assumption `createMember` already makes
  about the connection role bypassing RLS. If `createMember` works, this works.
- **Currency is read, not assumed.** `beforeAll` reads `Tenant.currency` for
  `totalbjj` and both amount formatters derive from it, because the route
  denominates manual payments in the club's currency, not GBP. A club on EUR will
  not break these assertions.
- **`fullyParallel: true`** means these tests may be split across workers. Each
  worker gets its own `RUN_STAMP` and cleans only its own rows, and every test
  creates its own member, so there is no shared mutable state between them — with
  the one exception of the outstanding list, which is global by nature (test 6
  filters to its own member's name rather than counting rows).
