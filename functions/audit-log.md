# Audit Log

> **Status:** ✅ Working · best-effort logging (never breaks user flows) · owner-only read API with cursor pagination · IP + user-agent captured.

## Purpose

Forensic trail of every consequential action in the system. When something goes wrong — a payment refunded, a member deleted, a coach role removed — the owner needs an answer to "who did what, and when?". The Audit Log is that answer.

It also satisfies tenant-isolation invariants ("no cross-tenant writes ever happened") and powers future compliance asks (GDPR access requests, SOC 2 evidence).

## Data model

```prisma
model AuditLog {
  id         String   @id @default(cuid())
  tenantId   String
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  action     String                         // e.g. "payment.refund", "member.delete"
  entityType String                         // e.g. "Payment", "Member"
  entityId   String                         // the affected row's id
  metadata   Json?                          // free-form context (amounts, reasons)
  ipAddress  String?                        // best-effort from request headers
  userAgent  String?                        // truncated to 500 chars
  createdAt  DateTime @default(now())

  @@index([tenantId, createdAt])
  @@index([tenantId, entityType, entityId])
}
```

`userId` is nullable — system-initiated events (Stripe webhook, cron, automated cleanups) have no user actor. The `entityType + entityId` index supports "show me everything that happened to Member XYZ".

## Surfaces

- Owner side: `/dashboard/audit-log` page (TBD UI — consumes [`GET /api/audit-log`](../app/api/audit-log/route.ts))
- Internal: every meaningful state-changing route calls `logAudit({...})` (see [lib/audit-log.ts](../lib/audit-log.ts))
- Stripe webhook: every handler logs `stripe.webhook.{event_type}`
- Future: `/api/audit-log/export` for CSV download

## Write API — `logAudit()`

[lib/audit-log.ts](../lib/audit-log.ts):

```ts
type LogArgs = {
  tenantId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
  req?: Request;
};

export async function logAudit(args: LogArgs): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId ?? null,
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId,
        metadata: args.metadata ?? undefined,
        ipAddress: args.req ? getClientIp(args.req) : null,
        userAgent: args.req?.headers.get("user-agent")?.slice(0, 500) ?? null,
      },
    });
  } catch {
    // Best-effort — never break the user-facing operation on audit failure.
  }
}
```

The empty `catch {}` is intentional: an audit failure should never cascade into a user-visible error. The trade-off is "we might miss audit rows under DB pressure" — accepted because the alternative is "a refund failed because audit insert hit a deadlock", which is worse.

## Read API — `GET /api/audit-log`

Owner-only ([`requireOwner()`](../lib/authz.ts) — not even managers). Cursor-paginated:

```ts
const { tenantId } = await requireOwner();
const cursor = searchParams.get("cursor") ?? undefined;
const take = Math.min(parseInt(searchParams.get("take") ?? "100"), 100);

const entries = await prisma.auditLog.findMany({
  where: { tenantId },
  include: { user: { select: { id: true, name: true, email: true } } },
  cursor: cursor ? { id: cursor } : undefined,
  skip: cursor ? 1 : 0,
  take,
  orderBy: { createdAt: "desc" },
});
const nextCursor = entries.length === take ? entries.at(-1)!.id : null;
return NextResponse.json({ entries, nextCursor });
```

Cursor pagination (vs `skip + take`) prevents drift if new rows arrive between page loads. `take` capped at 100 to prevent expensive queries.

## Action naming convention

Verb-style, dot-namespaced: `{entity}.{verb}` or `{system}.{event}`.

| Action | Where logged |
|---|---|
| `member.create`, `member.update`, `member.delete` | `/api/members/...` |
| `member.invite_sent` | `/api/members/invite` |
| `payment.refund` | `/api/payments/[id]/refund` |
| `payment.mark_paid` | `/api/payments/[id]/mark-paid` |
| `class.create`, `class.update`, `class.delete` | `/api/classes/...` |
| `rank.assign`, `rank.remove` | `/api/members/[id]/ranks/...` |
| `class_pack.create`, `class_pack.update`, `class_pack.archive` | `/api/class-packs/...` |
| `staff.invite`, `staff.role_change`, `staff.remove` | `/api/staff/...` |
| `tenant.update_branding`, `tenant.update_revenue_settings` | `/api/settings/...` |
| `auth.login`, `auth.login_failed`, `auth.password_reset` | NextAuth callbacks |
| `auth.session_rotated` | session-version bump endpoints |
| `stripe.webhook.{event_type}` | webhook handler per case |
| `order.create.pay_at_desk`, `order.mark_paid` | order endpoints |
| `waiver.signed`, `waiver.signed_supervised` | waiver endpoints |
| `csv_import.completed`, `csv_import.failed` | CSV importer |

This convention makes it possible to filter "show me all `payment.*` events" or "all `auth.*` failures" in a future filter UI.

## Metadata payloads

Free-form JSON, but most handlers follow these patterns:

- **Payment refund**: `{amountPence, reason}`
- **Member delete**: `{name, email, soft: true}`
- **Role change**: `{from: 'coach', to: 'manager'}`
- **Stripe event**: `{event_id, customer_id?, amount?}`

Avoid logging secrets, tokens, password hashes, full credit card numbers (Stripe never sends us full PAN anyway).

## IP capture

`getClientIp(req)` (in [lib/rate-limit.ts](../lib/rate-limit.ts)) walks `x-forwarded-for`, `x-real-ip`, and falls back to `"unknown"`. Vercel populates these headers on every request. Stored as plain string; not normalised to v4/v6 canonical form.

## Security

| Control | Where |
|---|---|
| Owner-only read | `requireOwner()` — managers can't see the audit log |
| Tenant scope | `where: {tenantId}` on every read; tenant injected from session |
| Best-effort write | `try/catch{}` — audit insert never breaks user flows |
| No secrets in metadata | Convention; not enforced — review new handlers |
| Cursor pagination | Prevents skip-based drift, caps take at 100 |
| User-agent truncation | 500 char limit prevents log poisoning |
| `userId` nullable for system events | Webhook + cron events still logged with full context |

## Known limitations

- **No filter UI** — read API returns flat chronological list. No "filter by entityType" or "filter by user" today. Worth a follow-up.
- **No CSV/JSON export** — owner can't bulk-download for compliance asks. Add `/api/audit-log/export` with streaming response.
- **No retention policy** — rows accumulate forever. GDPR may require deletion at member-remove time; not enforced today.
- **No diff capture** — actions like `member.update` log "what was updated" via metadata at handler discretion, not a structured before/after diff.
- **No alerting** — `auth.login_failed` floods don't page anyone. Worth feeding into a brute-force detector.
- **PII in metadata** — member names/emails appear in some logs. If we ever need a "delete my data" flow, audit rows for that member need scrubbing too.
- **No write-from-client** — the `logAudit()` helper is server-only; no `/api/audit-log` POST endpoint. Intentional — clients should never write directly.

## Test coverage

- [tests/unit/audit-log-get.test.ts](../tests/unit/audit-log-get.test.ts) — covers owner-only access, cursor pagination, tenant scope

## Files

- [lib/audit-log.ts](../lib/audit-log.ts) — `logAudit()` helper
- [app/api/audit-log/route.ts](../app/api/audit-log/route.ts) — owner-only read with cursor pagination
- [prisma/schema.prisma](../prisma/schema.prisma) — `AuditLog` model
- See [stripe-webhook.md](stripe-webhook.md) (every event logged), [refunds-disputes.md](refunds-disputes.md), [settings-staff.md](settings-staff.md), [session-version-rotation.md](session-version-rotation.md)
