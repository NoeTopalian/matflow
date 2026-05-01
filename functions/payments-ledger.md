# Payments Ledger

> **Status:** ✅ Working · append-only Payment table · staff Mark Paid drawer (cash/exempt/external/comp/other) · per-member history view · CSV export · Stripe sync via webhook.

## Purpose

Single source of truth for every membership and pack payment that hit (or should have hit) the gym. Mirrors Stripe's billing for the auditable record AND captures cash / cheque / exempt / comped payments that Stripe never sees.

## Surfaces

| Surface | Path |
|---|---|
| Owner payments page | [components/dashboard/PaymentsTable.tsx](../components/dashboard/PaymentsTable.tsx) — embedded somewhere in the dashboard |
| Mark Paid drawer | [components/dashboard/MarkPaidDrawer.tsx](../components/dashboard/MarkPaidDrawer.tsx) — opens from member detail page header |
| Member's own history | [/member/profile](../app/member/profile/page.tsx) → [MemberBillingTab](../components/member/MemberBillingTab.tsx) — shows last 100 payments |
| CSV export | Reports page → "Export CSV" button (rate-limited 10/hr) |

## Data model

```prisma
model Payment {
  id                    String   @id @default(cuid())
  tenantId              String
  memberId              String?
  member                Member?  @relation(fields: [memberId], references: [id])
  stripeInvoiceId       String?  @unique
  stripePaymentIntentId String?  @unique
  stripeChargeId        String?
  amountPence           Int
  currency              String   @default("GBP")
  status                String   // CHECK: succeeded | failed | refunded | disputed | pending
  description           String?
  paidAt                DateTime?
  refundedAt            DateTime?
  refundedAmountPence   Int?
  failureReason         String?
  createdAt             DateTime @default(now())

  @@index([tenantId, createdAt])
  @@index([memberId, createdAt])
  @@index([tenantId, status])
  @@index([tenantId, paidAt])
}
```

CHECK constraint on `status` enforced via migration `20260430000001_schema_check_constraints` (NOT VALID + VALIDATE).

## API routes

### `GET /api/payments`
Owner/manager. Lists tenant's payments with pagination.

### `POST /api/payments/manual`
Owner/manager/admin. Body: `{ memberId, amountPence, method: "cash"|"exempt"|"external"|"comp"|"other", description? }`. Inserts a `Payment` row with `status='succeeded'`, `paidAt=now`, `stripePaymentIntentId=null`. Audit-logged.

### `POST /api/payments/intent`
Member-side. Records a "I will pay later" intent (status='pending'). Used for bank transfer / cash class-pack purchases — see [member-class-pack-purchase.md](member-class-pack-purchase.md).

### `GET /api/payments/export.csv`
Owner/manager. Streams a CSV of all payments for the tenant. Rate-limited to 10/hour to prevent dump abuse.

### `GET /api/members/[id]/payments`
Staff. Tenant-scoped via the member's tenant. Returns history for one member.

### `GET /api/member/me/payments`
Member. Returns own history (last 100, ordered desc).

### `POST /api/payments/[id]/refund` — see [refunds-disputes.md](refunds-disputes.md)

## Mark Paid drawer (`MarkPaidDrawer.tsx`)

Opens from the member detail page header. Form:
- Amount (pence)
- Method radio: Cash / Card at desk / Exempt / Comp / External (bank xfer) / Other
- Optional description (e.g. "March membership", "Walk-in mat fee")
- Submit → POST /api/payments/manual → toast + drawer closes + member's payment chip flips green

## Stripe sync

Stripe-originated payments arrive via the webhook ([stripe-webhook.md](stripe-webhook.md)):
- `invoice.payment_succeeded` → upsert Payment with `status='succeeded'` + `paidAt`
- `invoice.payment_failed` → upsert with `status='failed'` + `failureReason`
- `invoice.voided` → flip existing succeeded → refunded
- `charge.refunded` → set `refundedAt + refundedAmountPence`

Idempotency via `stripePaymentIntentId @unique` and `stripeInvoiceId @unique`.

## CSV export format

| Column | Source |
|---|---|
| date | `paidAt ?? createdAt` |
| member_email | `member.email` |
| member_name | `member.name` |
| amount_gbp | `amountPence / 100` |
| status | direct |
| method | inferred (`stripeInvoiceId` ⇒ Stripe, else manual method from description) |
| description | direct |
| stripe_invoice | `stripeInvoiceId` |
| refunded_amount | `refundedAmountPence / 100` |

## Security

- Owner/manager on writes; admin can manual-mark-paid; staff can view
- Tenant-scoped on every query
- Audit log on every write — `payment.manual.create`, `payment.refund`, etc.
- CSV export rate-limited to defeat DoS-style exports
- Stripe webhook signature-verified before any DB write

## Known limitations

- **Append-only philosophy** but no UI guard against accidentally re-marking the same period twice. Easy to enter "March" payment twice.
- **No "void manual entry" UI** — mistakes need a refund row to reverse.
- **No payment plan / split payment** — single Payment row per transaction. Members on installments would need multiple rows + a parent grouping.
- **Currency hardcoded GBP** at the UI layer — schema supports any currency but the UI labels and CSV column are GBP-named.
- **No per-line item** — Payment doesn't record WHAT was paid for beyond a free-text description. Class-pack purchases create a Payment AND a `MemberClassPack` row but the link is only via `stripePaymentIntentId`.

## Test coverage

- Direct: unit tests on the manual endpoint (verify Zod, audit log, tenant scope)
- Indirect: webhook tests cover the Stripe-sync paths

## Files

- [components/dashboard/PaymentsTable.tsx](../components/dashboard/PaymentsTable.tsx)
- [components/dashboard/MarkPaidDrawer.tsx](../components/dashboard/MarkPaidDrawer.tsx)
- [components/member/MemberBillingTab.tsx](../components/member/MemberBillingTab.tsx)
- [app/api/payments/route.ts](../app/api/payments/route.ts)
- [app/api/payments/manual/route.ts](../app/api/payments/manual/route.ts)
- [app/api/payments/intent/route.ts](../app/api/payments/intent/route.ts)
- [app/api/payments/export.csv/route.ts](../app/api/payments/export.csv/route.ts)
- [app/api/payments/[id]/refund/route.ts](../app/api/payments/[id]/refund/route.ts)
- [app/api/members/[id]/payments/route.ts](../app/api/members/[id]/payments/route.ts)
- [app/api/member/me/payments/route.ts](../app/api/member/me/payments/route.ts)
