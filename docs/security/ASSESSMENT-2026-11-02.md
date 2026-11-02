# Pre-release security assessment — 2026-11-02

Bounded application-security pass on the MVP before Sean's real member data lands.
Synthetic data and the Neon **test** branch only; no production access, no live
providers, no push/merge/deploy. Builds on the Oct security campaign
(`docs/security/` FINDINGS/ADVISORY-REGISTER/ITERATION-2) rather than repeating it.

## Scope and candidate

- **Candidate:** `origin/main` **76cbcb4f** (the deployed head; #56 merged 2026-11-01).
- **Fix branch:** `sec/mvp-assessment-2026-11-02`, head **106b808e** (candidate + one fix). Local only — not pushed or merged.
- **Surfaces:** tenant isolation / IDOR / authz (members, orders, packs, reports, attribution, member/guardian routes); imports & identity; CSV/formula injection; untrusted→sink (SQL/HTML/filename/SSRF); the AI monthly report; dependency advisories. Method: two independent read-only reviewers + source review + runtime checks on the test branch.
- **Safe-execution evidence:** the verify harness (`.claude/skills/.../env.mjs`) refuses any non-test database (`assertTestUrl` rejects the prod endpoint), forces `EMAIL_DELIVERY=off`, and replaces Stripe/Resend/Blob/Anthropic keys with invalid never-charge/never-send values. External delivery disabled in code, not assumed.

## Verdict

**No confirmed exploitable vulnerability found** in the reviewed scope on the live
candidate. The code is strongly and deliberately hardened (the Oct campaign's fixes
are present). One latent isolation gap (A-1) was fixed on the branch; it is **not a
release blocker** because it is not exploitable on any current read path. Two
low residuals are deploy-configuration, not code.

"Secure" is not claimed. This states what was tested and what the evidence establishes.

## Findings

| ID | Sev | Property | State | Evidence / fix |
|----|-----|----------|-------|----------------|
| A-1 | Low (defence-in-depth) | `trialRunById` / `creditedToUserId` / `creditedToMemberId` written from the request body without in-tenant resolution on member create/update — a staff user could store another tenant's FK. No in-scope read path discloses it, so not exploitable today. | **Fixed** (106b808e) | `lib/attribution-scope.ts` resolves each id in-tenant; both routes reject on miss (400). Regression: unit 8/8; DB integration both roles (owner + `matflow_app`) 7/7, asserting the row carries no foreign FK after a rejected call and that in-tenant ids still work. |
| R2 | Low | Abandoned (preview-but-not-committed) import CSVs with member PII sit in Blob storage and are cleared only by the retention cron, which is off until `CRON_SECRET` is set — so PII can persist past the published 30-day policy. Committed-import blobs are deleted immediately. | Open — config | `app/api/cron/retention/route.ts` (RETENTION_CRON_ENABLED gate). Action: set `CRON_SECRET` in Vercel (Noe). |
| R1 | Low | An erased member's name/email can survive in import history when the manifest entry carries only a name/address with no id/key to scrub by (documented open question, TEAMUP-OPERATIONS-CONTRACT §3). | Open — known | `lib/importers/import-conflicts-scrub.ts`. Most entries carry an id/key and are scrubbed. |
| A-2 | Informational | `member/class-packs/buy` runs an `updateMany`/`findUnique` on the caller's own already-tenant-verified `member.id` without `tenantId` in the WHERE. Not exploitable (id is tenant-scoped; runs under RLS). | Open — hygiene | Optional one-line tidy to match the convention; left unpatched to keep scope tight. |
| O1 | Informational | Imported members get `paymentStatus = "paid"` derived from the TeamUp status string; no Payment/charge row is fabricated. A label, never a confirmed payment record. Owner-only, own-club data. | Not a defect | `lib/importers/teamup.ts`. |

Confirmed safe (with scoping): CSV formula-injection neutralisation (`lib/csv.ts`), HTML escaping in email templates, SQL (all parameterised; no `*Unsafe` API), import integrity (no cross-tenant match, no silent overwrite, preview==commit, idempotent commit), and the AI report (no tools passed to the model; all inputs tenant-scoped; output rendered as plain text — prompt injection cannot trigger tools, alter access, or disclose another tenant).

## Tested / not tested (candidate 76cbcb4f unless noted; fix on 106b808e)

- **Unit:** attribution-scope 8/8. **Typecheck** 0 errors, **lint** 0 errors (3 pre-existing unused-import warnings, untouched).
- **DB integration, both roles (owner + restricted `matflow_app`):** attribution-tenant-scope + tenant-isolation 7/7 each.
- **Browser journeys (production build, test branch):** Sean's reporting features — reports-clarity 21/0, reporting-truth 88/0, headcount-movement 39/0 (148 checks, 0 failures) — so the A-1 fix did not disturb member create/update or reporting.
- **Dependencies:** production-only `npm audit --omit=dev` = 0 critical, 0 high, 7 moderate; the repo's CI advisory gate passed on the candidate; runtime-reachable highs (undici, sharp/next SVG-RCE) were triaged as fixed/unreachable in ADVISORY-REGISTER. A per-advisory reachability triage of the 7 moderates was **not** redone in this pass.
- **Concurrency (duplicate admission):** **confirmed at runtime** — two concurrent inserts of the same `(memberId, classInstanceId)` against the test branch yielded exactly one row, the other a `23505` unique violation (the `@@unique([memberId, classInstanceId])` backstop). The capacity oversell guard (`FOR UPDATE` + re-count, `lib/checkin.ts`) is **confirmed by source**. The end-to-end HTTP check-in race was **not** run to a pass: two bespoke reproductions hit harness friction (CSRF same-origin header, then member eligibility) with nothing admitted — no defect shown, and the DB-level backstop above is the load-bearing guarantee regardless.
- **Not exercised:** live email/Stripe/Blob/push (disabled by design), production data, the AI report at runtime (inert without `ANTHROPIC_API_KEY`).

## Required decisions / next actions

1. **A-1 fix** (`sec/mvp-assessment-2026-11-02` @ 106b808e) — push + PR + merge is Noe's decision. Not urgent (not exploitable live), but it closes the gap before a read path is ever added.
2. **`CRON_SECRET`** in Vercel — closes R2 (PII retention) and starts the class-instance/retention jobs. Noe.
3. Optional: A-2 one-line tidy; R1 scrub-by-name follow-up.
