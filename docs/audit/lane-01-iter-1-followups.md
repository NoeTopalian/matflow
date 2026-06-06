# Lane 1 — Iter-1 follow-up backlog (Medium + Low)

Items that the iter-1 subagents flagged at Medium or Low severity. These are
**not blocking lane-1 convergence** (the harsh-exit rule fires on Critical+High
only). They land here as a feature-follow-up backlog so the loop converges
on time and the items are not lost.

Cross-referenced finding IDs match the iter-1 doc.

## Medium

### UX guards (verifier — V-17 through V-28)

- **V-17** Profile edit: `Cancel` button has no `disabled={saving}` — clicking mid-PATCH reverts the form silently. Add the guard.
- **V-18** Notes save (`saveNotes`): `setNotesSaving(true)` runs after the `await`; rapid double-click can race past the disabled state. Use a ref-based guard.
- **V-19** "Clear all filters" on MembersList doesn't strip `?filter=` URL param; back/forward reinstates the stale filter. `router.replace` to drop the param.
- **V-20** AttendanceView has no server-side pagination — fully SSR'd into the page. Cursor-paginate.
- **V-21** TimetableManager ClassForm: roster picker hits `/api/members?take=200` — silent truncation beyond 200 members. Switch to server-side search.
- **V-22** AnnouncementsView drawer dismisses without confirmation if title/body/image are filled. Add `window.confirm()` when the form is dirty.
- **V-23** TOTP setup drawer: `totpSaving` left at true if drawer closes mid-QR-fetch. Reset on close.
- **V-24** Tier delete: `confirmDeleteId` cleared in `finally` even on failure — error toast is the only signal. Keep the confirm row up on failure.
- **V-25** Dashboard task list mixes "to me" + "sent by me" — no UI distinction. Add a section header in the drawer.
- **V-26** "Mark as inactive" in the More Actions menu has no confirm. Add inline confirm.
- **V-27** RanksManager preset apply runs sequential POSTs — partial failure leaves half a rank system. Switch to a bulk endpoint or report partial failures clearly.
- **V-28** AddTaskModal member-search has no `AbortController`. Add one.

### Audit hygiene (security)

- **S-21** Announcements PATCH audit: records only `Object.keys(parsed.data)` — could record body-length delta or hash for traceability.
- **S-25** AuditLog read includes operator email via `user.email` join — minor PII overreach. Drop email from the include.
- **S-26** PII in console.error: invite-fail logs include the raw error object which may contain the recipient email. Strip to `e.message + status code`.
- **S-27** DSAR export resolves email logs by raw email — fails for previously-erased members. Resolve by memberId.
- **S-28** `admin/email/test` doesn't `logAudit` the send. Add.
- **S-29** `owner/reset-onboarding` doesn't `logAudit`. Add.
- **S-34** Class DELETE `?force=true` doesn't require a stated reason; record in audit metadata.
- **S-35** Class DELETE `?force=true` lacks confirmation challenge + rate-limit. Add a gym-name confirmation hash (mirrors operator routes).
- **S-43, S-44** GET routes swallow DB errors silently — return `apiError` so logs surface the failure.
- **S-45** Memberships PATCH `as Record<string, unknown>` — replace with `Prisma.MembershipTierUpdateInput`.
- **S-46** `force-password-reset` returns the temp password — add explicit `Cache-Control: no-store, X-Content-Type-Options: nosniff` headers.
- **S-47** (suspected) Verify `sendEmail` return shape contains no recipient/body before serialising to response.
- **S-48** DSAR audit `metadata.memberEmail` is raw PII — store first-3-chars + domain hash instead.

### Performance hygiene (scientist)

- **P-06** Tenant settings `findUniqueOrThrow` returns all scalars via bare `include`. Narrow with `select:`.
- **P-08, P-09, P-10** Member-side route includes return all scalars (`include: { class: true }` etc.). Narrow to fields used.
- **P-11** Coach register `distinct: ["memberId"]` on attendance — replace with `groupBy({ _max: { checkInTime: true } })`.
- **P-12, P-13, P-14** Members/[id] page acquires 5 separate `withTenantContext` connections. Fold to one.
- **P-15, P-16** Reports `topRaw` and `methodCounts` `groupBy` are all-time unbounded. Add time filter.
- **P-17, P-18** Revenue summary fetches all Payment rows and sums in JS. Switch to `aggregate({ _sum })`.
- **P-19** `atRiskMembers` count uses correlated `NOT EXISTS`. Acceptable today; revisit at 500+ active members.
- **P-20, P-21** Payments routes use bare `include` returning Stripe IDs. Narrow `select`.
- **P-22** AttendanceView 100-row cap with no Load More. Add pagination control.
- **P-23** Members/[id] status-PATCH does sequential lookups in separate `withTenantContext`. Fold.
- **P-24, P-25, P-39, P-54, P-62** Bare `include` payload hygiene across multiple read endpoints.
- **P-26** `newMembers` fetches member rows to bucket by month. Use 6 `count` calls or `$queryRaw` with `DATE_TRUNC`.
- **P-27, P-28** `useEffect` fetches without `AbortController` (CoachRegister, MemberProfile payments). Add.
- **P-29, P-30, P-31** Silent `catch {}` on data load — add structured `console.error`.
- **P-32** Stripe webhook `invoice.payment_failed`: sequential awaits could `Promise.all`.
- **P-33, P-34** Refund + invoice.voided TOCTOU windows — `findFirst` + `update`. Switch to `updateMany`.
- **P-35** Member PATCH does `updateMany` + post-`findFirst` re-fetch. Switch to `update` + select.
- **P-37** Manual payment route: confirm `$transaction` wraps both writes (verified safe per `withTenantContext` implementation).
- **P-38, P-40** Bare `include` defensive hygiene.
- **P-41** Members page server component lacks `export const dynamic = 'force-dynamic'`. Add for safety.
- **P-48** `isPromotionReady` uses `withRlsBypass` where `withTenantContext` would suffice.
- **P-49** Tenant lookup by `stripeAccountId` lacks index. Add `@@index([stripeAccountId])`.
- **P-50** `handleComplete` doesn't refresh task list after success — minor consistency gap.

### Race / state-leak hygiene (scientist)

- **P-64** Stripe webhook claim deletion is fire-and-forget `.catch(() => {})` — log failure.
- **P-66** MemberProfile payments race between initial fetch + `addPayment`. Low probability at normal latency; add `cancelled` flag.
- **P-68** `handleComplete` rollback captures `prev` via closure; can double-restore on concurrent tasks. Use functional setState.
- **P-69** `addPayment` temp IDs collide for fast double-tap — use `crypto.randomUUID()` (also a Critical fix point V-03).
- **P-70** Dispute handler `findFirst` + update TOCTOU — switch to `updateMany`.

## Low

### Polish + dead UI

- **V-29** SettingsPage `INITIAL_PRODUCTS` demo emojis shipped to prod — initialise to `[]`.
- **V-30** AddMemberModal hardcoded `MEMBERSHIP_TYPES` — fetch from `/api/memberships`.
- **V-31** `todayKey()` uses UTC — switch to local date.
- **V-32** TimetableManager `myClassesOnly` SSR/CSR flicker — hydrate before render.
- **V-33** PaymentsTable `useEffect` eslint-suppression — wrap `load` in `useCallback`.
- **V-34** MemberProfile payments `catch(() => {})` swallows errors — show error state.
- **V-35** Announcement image `alt=""` for empty title — add fallback string.
- **V-36** Dead `<div className="hidden">` block ~70 lines in MemberProfile.tsx — delete.
- **V-37** TimetableManager uses `window.confirm()` — replace with inline confirm.
- **V-38** RanksManager uses `window.confirm()` — replace with inline confirm.

### Code quality

- **P-51** `app/dashboard/members/page.tsx` JS row-map duplicates select. Spread instead.
- **P-52** AttendanceView `query` filter has no debounce — future-proof at scale.
- **P-53** MembersList sort comparator allocates `new Date()` per pair — precompute.
- **P-55** Stripe webhook orphan claim deletion swallows error — log.
- **P-56** Refund route sequential lookups — Promise.all.
- **P-57** Analysis page also uses `distinct: ["memberId"]` (same class as P-04, lower-impact path).
- **P-58** Promoter name enrichment minor allocation.
- **P-59** MemberProfile payments effect dep `[initial.id]` should be `[member.id]` for streaming RSC.
- **P-60** DSAR export `ClassInstance` include with no narrow `select:` — payload reduction.
- **P-61** Self-correction — coach register IS correctly scoped. Not a finding.
- **P-71** CoachRegister hook lint suppression — useCallback + remove.
- **P-72 through P-78** Verified-OK items (Stripe idempotency, rate-limit groupBy fix, photos relation N+1, 60k cap, count usage). No action needed.

### Security low

- **S-42** `staff/assignable` returns role but not email — documented OK, leave as is.
- **S-49** MemberProfile.tsx:1082 "parent/child linking coming soon" copy is stale — feature shipped. Update copy.
- **S-50** Promotions page "Override per discipline coming soon" copy — update or remove.
- **S-51** `DEMO_ANNOUNCEMENTS` in bundle — move to seeds or env-gate.
- **S-52** Announcement PATCH thin error response — add `parsed.error.flatten()` for consistency.
- **S-54** PII in `[announcements GET]` console.error — sanitise.
- **S-55** GET classes silent failure — surface 500.
- **S-56** Server-component `console.error` may include stack — structured log.
- **S-57** Upload module-load `console.warn` — move inside handler.
- **S-58** Push send timing channel — verified fire-and-forget, no action.
- **S-59** Audit log writes silently swallowed — `console.error` on failure.
- **S-60** Combined with S-25.
