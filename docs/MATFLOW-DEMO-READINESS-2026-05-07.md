# MatFlow Demo-Readiness — Week of 2026-05-07

**Context:** actively demoing pre-investor; the next high-stakes touch is within ~7 days.
**Source backlog:** [MATFLOW-FULL-ASSESSMENT-2026-05-07.md](MATFLOW-FULL-ASSESSMENT-2026-05-07.md) (28 items).
**This doc's job:** recalibrate that backlog for this-week + pre-investor severity, separating "fix now" from "talking point" from "explicit defer".

---

## How severity changes pre-investor

The full-scope assessment ranked items by *correctness* severity (what would matter if MatFlow were serving 10+ paying tenants). For an actively-demoing pre-investor build with few real users, the severity function is different:

| Driver | What gets promoted | What gets demoted |
|---|---|---|
| **Visible in screen-share** | UX dead-ends, broken-looking links, doc drift | Internal data-flow refinements |
| **Visible in code-review-grade diligence** | Hardcoded credentials, non-timing-safe crypto | Edge-case race conditions |
| **Visible when asked "show me your spec"** | Doc contradictions between source-of-truth files | API field-name nits |
| **Real-user blast radius** | (low weight pre-investor) | Regulator-facing concerns can wait |

The result: most P3 doc fixes promote to P1-this-week, and one of the two original P1s (DSAR audit identity) demotes to "talking point only" because no regulator is reviewing the audit trail today.

---

## Fix this week (4-6 hours total)

Ranked by execution order. Each can ship independently.

| # | Original ID | Demo-state sev | Item | Why it matters NOW | Effort |
|---|---|---|---|---|---|
| 1 | 6 | **P1-now** | Gate `DEMO_MODE` credential map behind `NODE_ENV !== "production"` so it tree-shakes out of prod builds | Any technical due-diligence engineer reading [auth.ts:339-361](../auth.ts#L339-L361) sees hardcoded creds. Reputational. | XS |
| 2 | 3 | **P1-now** | Rewrite [MATFLOW-MASTER-PLAN.md §5](MATFLOW-MASTER-PLAN.md) to match the actual 9-stage wizard (currently says 4) | "Show me your spec" → two source-of-truth docs disagree → bad look. | XS |
| 3 | 17-23 | **P1-now** | P3 doc drift sweep: `create-tenant` docstring; `accept-invite` docstring; PIPELINES.md §1.6 (`?resume=1` + dashboard-layout redirect); §2.2 kids-owner-only; §3.5 public-prefix list; §3.1 audit-action list; §1.8.4 member-side TOTP-reset | Same: docs must match code or any deep look is uncomfortable. | XS each, batch in one PR |
| 4 | 10 | **P1-now** | Convert `/apply` Terms of Service / Privacy Policy from `<span>` to `<Link>` to `/legal/terms` and `/legal/privacy` | An investor *will* click these in any demo of the funnel. Non-clickable links look broken. | XS |
| 5 | 9 | **P1-now** | Add "Back to sign in" + "Need a new invite? Contact your gym" to `/login/accept-invite` no-token state | Visible UX dead-end if anyone clicks an old or malformed invite link mid-demo. | XS |
| 6 | 16 | **P2-now** | Switch Connect callback HMAC compare from `!==` to `crypto.timingSafeEqual` | Crypto hygiene flag — visible in code-review-grade diligence. | XS |
| 7 | 12 | **P2-now** | Add `"taster"` to `memberUpdateSchema.status` enum to match DB CHECK | Schema/DB drift; minor but cheap to fix. | XS |
| 8 | 24 | **P3-now** | Apply route stores empty string in `notes` when no message. Convert to null. | Cosmetic but the apply route is a high-traffic demo path. | XS |

**Estimated wall-clock:** 4-6 hours including review pauses. All XS effort. None require design decisions; pre-decided in this doc.

---

## Known issues — talking points if asked

These are real findings from the assessment but **don't fix this week**. Have a clean answer ready if an investor or technical diligence engineer surfaces them.

### ~~Magic-link login bypasses TOTP for owners (originally P1)~~ — ✅ RESOLVED 2026-05-07

**Fixed:** [/api/magic-link/verify](../app/api/magic-link/verify/route.ts) now sets `totpPending: user.role === "owner" && user.totpEnabled === true`. TOTP-enrolled owners using "Email me a sign-in link" are pinned to `/login/totp` challenge by the proxy before reaching `/dashboard`. Members and unenrolled owners are unchanged.

**If asked anyway:** "We shipped the fix this week — magic-link now respects the TOTP gate for owners. Pre-fix posture was 'magic-link as recovery factor', which would have been a defensible answer too, but fixing was cheaper than documenting the carve-out."

### ~~DSAR routes obscure operator identity in audit trail (originally P1)~~ — ✅ RESOLVED (doc + paired fix) 2026-05-07

**What changed:** PIPELINES.md §1.8.7-8 now explicitly documents that operator attribution is reconstructable by stitching `admin.impersonate.start` / `admin.impersonate.end` rows around the DSAR row. Paired code fix: DSAR-erase now writes the audit row *before* the destructive erasure and refuses to erase if the audit-write throws (was previously fire-and-forget).

**If asked:** "We document operator attribution as reconstructable via the impersonation event window — verifiable in any audit export. Code-level dual-path auth is still on the roadmap as item 2 in our assessment, but it's not blocking. The harder fix — making sure no erasure ever happens without a corresponding audit row — shipped this week."

### `memberCreateSchema` is more permissive than the doc claims

**The truth:** schema only requires `name`; pipeline doc lists 6 required fields.

**The talking point:** "We're working through schema/doc reconciliation as part of a broader spec sync (open in this week's sweep)." If this gets fixed in §3 above, the talking point disappears.

### Apply route silently swallows DB write failure

**The truth:** if `gymApplication.create` throws, user still sees success because emails fire regardless. Application is lost.

**The talking point:** "Email-fallback was an early-launch decision so a flaky DB couldn't block lead capture; we'd tighten the contract to fail closed once we move off the trial-tier database." Fix is item 5 in the backlog (S effort).

### 147 baseline test failures

**The truth:** master plan §8 — pre-existing debt, separate triage track.

**The talking point:** "Inherited test debt from a 5-month-old refactor; we ringfenced it because new work doesn't increase the failing count and TypeScript is clean. Triaging post-exam-season."

---

## Explicit defer list — not this week, with reasons

| # | Original ID | Why we're not fixing now |
|---|---|---|
| 1 | 1 (magic-link/TOTP) | No real TOTP-enrolled owners; recovery UX needs real-user signal before fixing right. |
| 2 | 2 (DSAR audit) | No regulator scrutiny; impersonation-bracketing is an acceptable interim. |
| 3 | 5 (apply DB swallow) | Fail-closed change touches the trial DB story; better as part of a hosting upgrade. |
| 4 | 13 (discipline round-trip) | Multi-file change, not visible in screen-share. |
| 5 | 15 (purpose token split) | Refactor with migration considerations; not this week. |
| 6 | 4 (DSAR erase fire-and-forget) | Tied to item 2's decision; do them together. |
| 7 | 5 (DSAR erase reason) | Same — tied to item 2. |
| 8 | 11 (apply captcha/honeypot) | Spam isn't a current problem; ship when it becomes one. |
| 9 | 26 (Stripe customer race) | Cosmetic; orphan customers don't affect money or correctness. |
| 10 | 27 (webhook error helper) | Not user-visible; internal consistency only. |
| 11 | 28 (create-tenant prod-gating) | Bypass route is operator-gated; doc clarity is enough for now. |

---

## Pre-demo checklist (run the morning of)

After fixing the items above, before any high-stakes screen-share:

- [ ] `npm run lint` clean
- [ ] `npm run build` clean (no new failures vs baseline)
- [ ] `git status` clean (no uncommitted WIP visible if you `cd` in a code window)
- [ ] Open in Chrome DevTools / Console — no red errors on `/`, `/login`, `/apply`, `/dashboard` (sign in as `totalbjj`)
- [ ] `/apply` Terms/Privacy actually navigate to legal pages
- [ ] `/login/accept-invite` (no token) shows the new fallback nav
- [ ] All screenshots from the assessment ([apply-form-empty.png](../apply-form-empty.png), etc.) still match production
- [ ] If a technical investor: have [MATFLOW-FULL-ASSESSMENT-2026-05-07.md](MATFLOW-FULL-ASSESSMENT-2026-05-07.md) ready to send proactively — "we know the issues, here's our prioritised list, here's what we're shipping this week"

The last bullet is the strongest move: **getting ahead of the diligence question by handing them the audit unprompted** signals maturity. Most pre-investor founders hide their bug list.

---

## What "done" looks like

By end-of-week the diff should contain:

- 1 master plan rewrite ([MATFLOW-MASTER-PLAN.md §5](MATFLOW-MASTER-PLAN.md))
- ~7 small doc edits across [MATFLOW-PIPELINES.md](MATFLOW-PIPELINES.md) and 2-3 route docstrings
- 1 small auth.ts change (DEMO_MODE gate)
- 1 small apply page change (Terms/Privacy links)
- 1 small accept-invite page change (no-token nav)
- 1 small connect-callback change (timing-safe HMAC)
- 1 small schema change (taster enum) + 1 small route change (notes null)

All independently shippable. Most XS effort. Verifiable via `npm run lint && npm run build`.
