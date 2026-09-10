# MatFlow Email Hub — specification (decisions locked 2026-08-21)

## Context

Noe wants an email section in the owner dashboard: per-gym sender identity, editable templates for every circumstance (birthday, joining, receipts…), sent automatically on triggers or manually at the press of a button. This spec was driven to zero ambiguity through three question rounds; every decision below is Noe's, dated 2026-08-21. Research: Resend supports [per-tenant domain verification via API](https://resend.com/docs/add-a-domain); [Resend Pro at $20/mo for 50k emails](https://propicked.com/marketing/compare/resend-vs-mailchimp) beats [Mailchimp's per-contact pricing + $20/mo transactional add-on](https://www.emailvendorselection.com/mailchimp-pricing/) for this shape. **No external tool needed — build on the existing Resend integration.**

## Decisions (all Noe, 2026-08-21)

| # | Decision | Choice |
|---|---|---|
| D1 | Sender model | **Each gym verifies their own domain** — "puts responsibility on the club, not on me". Domains added programmatically to MatFlow's Resend account via API. |
| D2 | Pre-verification | **Hub locked until the gym verifies DNS**; Settings shows "Verify your domain to switch this on" with a wizard. **Existing transactional mail (receipts, invites, magic links, resets) keeps sending from matflow.studio unaffected** — a gym that hasn't done DNS must still be able to onboard members. |
| D3 | Templates | **Editable text + variables, fixed design.** Owner edits subject/body with `{firstName}`, `{gymName}`, `{age}` etc.; the branded layout, logo, colours and unsubscribe footer are fixed and cannot be broken or removed. |
| D4 | Manual send scope | **Owner-choosable**: single member from their profile, all-members blast, and filtered segments. (Phased: profile send first, blast second, segments third.) |
| D5 | Consent | **Unsubscribe link + per-member opt-out**, stored and honoured. Transactional mail exempt and always sends. |
| D6 | Consent default | **Opt-out (soft opt-in)** — on by default for existing members under UK PECR, one-click unsubscribe in every automated email. |
| D7 | Cost | **Included in the gym's subscription** — volume rides on MatFlow's Resend account (~$20/mo covers all gyms for years at current scale). Sales line: "automated member email included". |
| D8 | First triggers | **Welcome (on activation), Birthday, Payment receipts** (receipt exists as transactional — the hub adds owner-customisable text and the gym-domain sender), plus an owner-configurable set for the rest (renewal, dormancy win-back) later. |
| D9 | Kids | **Parent-facing only** (from the birthday round): staff see the child's birthday; anything sent goes to the parent, never the child. |
| D10 | Per-gym kill switch | Settings toggle per automation; the whole hub can be off. |

## Architecture

**Sender pipeline.** `Settings → Email` walks the owner through: enter domain → MatFlow calls Resend's create-domain API → show the SPF/DKIM records to paste into their DNS → poll/webhook verification → store status on the tenant. Once `verified`, hub sends go out as `{Gym Name} <notifications@theirgym.com>`; until then the hub is locked (D2). Existing `lib/email.ts` transactional flow is untouched and continues via `RESEND_FROM`.

**Schema (one migration, `npx prisma migrate dev`, never `db push`):**
- `Tenant`: `senderDomain String?`, `senderDomainStatus String?` (`pending | verified | failed`), `resendDomainId String?`, `senderFrom String?` (the local part, e.g. `hello`).
- `Member`: `autoEmailOptOut Boolean @default(false)`, `unsubscribeToken String? @unique` (minted lazily on first automated send).
- New `EmailAutomation`: `id, tenantId, trigger ("birthday" | "welcome" | "receipt" | …), enabled Boolean, subject String, body String, updatedByUserId, updatedAt` — one row per tenant per trigger; absent row = template defaults, disabled.
- New `EmailAutomationSend`: `id, tenantId, memberId, trigger, sentAt, year Int?` — the idempotency ledger; a birthday send writes `(memberId, "birthday", year)` with a unique constraint so a re-run cron can never send twice. Reuse `EmailLog` (already has status/bounce tracking + indexes) for delivery state — do not duplicate it.

**Send path.** One new function `sendAutomatedEmail()` wrapping the existing `sendEmail()` in `lib/email.ts`, adding: consent check (`autoEmailOptOut`), kid redirection to parent (D9), variable interpolation with escaping, the fixed layout with unsubscribe footer (`/api/email/unsubscribe?token=…` — GET renders a confirm page, POST flips the flag; no login required), and the `EmailAutomationSend` ledger write. The existing bounce-suppression check in `lib/email.ts` applies automatically.

**Triggers.**
- *Welcome*: fired inline on member activation (the `welcome` TemplateId already exists — the hub row overrides its copy when present).
- *Receipt*: existing `receipt` transactional template gains per-tenant copy override; consent-exempt; sends regardless of hub lock via matflow.studio until the domain verifies, then upgrades sender.
- *Birthday*: daily cron `/api/cron/birthday-emails` reusing `daysUntilBirthday()` (`lib/dashboard-action-items.ts:55` — already year-agnostic) with `until === 0`, `preferNoDob` nulls silently skipped, ledger-guarded. **Platform note: this is a 4th Vercel cron; Hobby caps at 2 (already at 3) — Vercel Pro is a prerequisite, which is already on Noe's list for commercial use anyway.**

**UI: `Settings → Email` tab** (staff dashboard, owner-only): domain setup card with live verification status; one card per automation with enable switch (Switch primitive), subject/body editor with variable chips, live preview, "Send test to me"; the EmailLog viewer filtered to automated sends. Member profile gains "Send email" under More actions (D4 phase 1). All new UI uses `components/ui/` primitives and tokens — ratchets may only move down.

## Interview additions (deep-interview 2026-08-21, final ambiguity 8.8%)

| # | Decision |
|---|---|
| D11 | **Welcome only for genuinely new members** — fires when the member record was created ≤30 days before activation. A migrated veteran accepting a bulk-invite gets nothing; manual profile send covers exceptions. |
| D12 | **Verified domain later fails ⇒ pause + alert.** That club's automations stop; owner gets an in-app banner + transactional alert via matflow.studio. Nothing ever sends from a failed domain. Receipts/invites unaffected. |
| D13 | **Unsubscribe all-or-nothing in v1, stored category-shaped** — `Member.emailOptOuts String[]` with an `all` sentinel (supersedes the `autoEmailOptOut Boolean` above), so per-category preferences later need no migration. |
| SC1 | **Scale: 10–20+ clubs.** Volume trivial; the binding constraint is Resend's per-account verified-domain cap. **[[NEEDS VERIFICATION]] before Phase 1: which Resend tier permits ≥20 domains.** Fallback = higher tier, never shared subdomains (would reverse D1). |

Full transcript + acceptance criteria: `.omc/specs/deep-interview-email-hub.md`.

## Template design system (planned 2026-08-21 — specification only)

### The one landmine: logo delivery
Gym logos are **private Vercel blobs served through the authenticated `/api/blob-image` proxy** — email clients fetch images anonymously, so the current `logoUrl` can never render in an inbox. Decision: when the hub is enabled (and whenever the logo changes), mint a **public blob copy** and store it as `Tenant.emailLogoUrl`. A logo is a public-facing brand asset — the privacy posture that is right for member photos is wrong-by-default here. No data URIs (Gmail strips them), no CID attachments (breaks in webmail).

### Theming model — render-time inlining, not tokens
Email clients support no CSS variables, no external stylesheets, no web fonts. The member-portal token system stops at the email boundary; instead a single **`brandedShell(tenant, opts)`** renderer (sibling of the existing `shell()`) inlines at send time:

| Element | Source |
|---|---|
| Accent bar (top of card) + buttons | `tenant.primaryColor` |
| Text on accent (buttons) | `readableOn(primaryColor)` — already in `lib/color.ts`, same worst-case-accent guarantee as the portal |
| Logo header | `tenant.emailLogoUrl`, height-capped 44px, `tenant.logoBg` behind it (same white/black/transparent choice the portal makes); **fallback when no logo: gym name set in 700-weight system font** |
| Body chrome | Stays light-neutral (white card on `#f5f6f8`) for every tenant — email dark mode is client-controlled auto-inversion chaos; a fixed light card survives it, a themed dark card does not |
| Type | System font stack only (as `shell()` already does) — web fonts are unreliable in email |
| Buttons | Table-based "bulletproof" buttons, ≥44px tall |

Every email renders a **plain-text part** alongside HTML — the existing pattern, kept mandatory.

### Two chrome levels — this is the load-bearing distinction
1. **Transactional chrome** (current `shell()`, unchanged): minimal, no logo required, no unsubscribe link, "sent by MatFlow on behalf of your gym" footer. Used by: receipts, refunds, payment-failed, disputes, magic links, invites, password resets, new-device, kiosk waiver.
2. **Branded automation chrome** (`brandedShell()`): logo header, accent bar, gym name, and a footer carrying the gym's identity + the **one-click unsubscribe link (D5) — structurally part of the chrome, unremovable by the owner (D3)**. Used by: welcome, birthday, renewal, win-back, blasts, manual sends.

An email's chrome level is decided by its **category, never per-send** — that is what keeps the unsubscribe guarantee auditable.

### Email catalogue (what kinds exist / will exist)
| Category | Chrome | Templates |
|---|---|---|
| Money (exists) | transactional | receipt, refund_processed, payment_failed(+owner), dispute_created(+owner) |
| Access (exists) | transactional | magic_link, invite_member, owner_activation, password_reset, login_new_device, kiosk_waiver |
| Progress (exists) | transactional → candidates for branded upgrade later | rank_promoted, rank_demoted, member_action_assigned |
| Lifecycle (hub, new) | branded | welcome (D11 gate), birthday (A1/D9), renewal reminder (phase 3), dormant win-back (phase 3) |
| Broadcast (hub, new) | branded | announcement blast (phase 2), segment sends (phase 3), single-member manual send (phase 1) |

### Preview = production, structurally
The Settings editor previews by rendering **the same `brandedShell()` output** into a sandboxed iframe (`srcdoc`) — one renderer, zero drift between what the owner sees and what sends. "Send test to me" sends the real thing through the real path. Variable chips (A2) interpolate live in the preview; an unknown variable blocks Save (A2).

### Explicitly out of v1
Hero/body images in automations (needs a public-assets pipeline beyond the logo), per-tenant font choices, dark-mode-adaptive email, React Email dependency (string renderers stay — consistent with the 21 existing templates, zero new deps).

## Phasing

1. **Phase 1:** migration; domain wizard + verification; birthday + welcome automations; unsubscribe endpoint; profile-page manual send; per-automation toggles.
2. **Phase 2:** receipt copy override; all-members blast with consent filtering.
3. **Phase 3:** segments (overdue / class / dormant); renewal + win-back triggers.

## Verification

- Domain wizard: a test domain reaches `verified` via Resend sandbox; hub controls unlock only then; transactional mail provably unaffected while locked.
- Birthday: seed a member with today's DOB on the Neon **test branch** → cron sends once; re-run cron → ledger blocks a second send; `preferNoDob` member skipped silently; kid's email goes to the parent.
- Unsubscribe: link in a received email flips `autoEmailOptOut` without login; next cron skips that member; receipts still send to them.
- Templates: variables interpolate, HTML in owner input is escaped, unsubscribe footer present in every automated send and absent from none.
- Gates: `npm run lint && npm test && VERCEL_ENV=preview npm run build` all green together; new tests for ledger idempotency, consent filtering, and kid redirection.

## Prerequisites / blockers

- **Vercel Pro** (cron #4 + commercial use) — already owed.
- **Resend plan**: free tier is 3k/mo with 100/day — fine for pilots; Pro $20/mo before any blast feature ships.
- Deliverability hygiene: matflow.studio's DMARC record (still owed from the runbook) protects the transactional path this feature leans on.

> Status: **specified, not built.** Decisions above are locked (Noe, 2026-08-21); implementation is phased and starts after the first paying gym unless re-prioritised.
