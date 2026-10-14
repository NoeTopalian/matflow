# Release packet — operator club access (PR #31 + PR #33), with PR #30 / #32 / #28 / #29 (14 Oct 2026)

Prepared for Noe. Engineering status only; merge, deployment, production verification and customer-account changes are separate decisions recorded in §8. No address, credential, ticket or token appears here.

## 1. Candidate sources
| PR | Branch | Head | Base | Purpose |
|---|---|---|---|---|
| #30 | `fix/main-ci-green` | `eea6e18` | main | 19 inherited Vitest failures classified and repaired (tests only) |
| #32 | `fix/secrets-fixtures` | `e5e14da` | #30 | secret-shaped fixtures → placeholders; fail-closed scan allowlist with ONE documented entry |
| #31 | `feat/hub-club-edit-access` | `a1dfee9` | main | View/Edit support sessions; field-level policy; owner-visible attribution |
| #33 | `fix/blob-tenant-ownership` | executable `680b673`; branch head = this packet's docs commit (docs only after `680b673`) | #31 | cross-tenant blob ownership (all accept/delete paths); operator-plane refusal rows; parser probes; this packet |
| #28 | `fix/members-toolbar-table-banner` | (unchanged) | main | Members UI + banner LocalTime |
| #29 | `feat/hub-conflict-resolution` | `44ad24e` | main | staff / multi-holder login-address conflicts (draft) |

Production: `9272a21`. Migration delta across all six: **none** (no file under `prisma/`). Rollback: redeploy `9272a21`.

## 2. Runtime and environment used for evidence
Node `24.21.0` (pinned scratchpad runtime); Next.js 16; production builds via `next build`; Neon TEST branch `ep-hidden-salad` only (owner role and `matflow_app` restricted role); isolated server flags `nobypass,isolated` behind an https proxy; disposable allow-listed operator; run-stamped fixtures torn down with count checks. Production touched only by two read-only SELECT transactions (Sean's holder check; demo-owner count).

## 3. Checks run (exits are process exits; nothing described as passed was skipped)
| Check | #31 `a1dfee9` | #33 `aeef7fc` |
|---|---|---|
| `npm run lint` | 0 | 0 |
| `tsc --noEmit` | 0 | 0 |
| UI-RULES ratchet | baseline | baseline |
| Full `npm test` | 6,769 passed / 0 failed (491 files; 83 DB files skipped locally by design) | 6,785 / 0 on `7e24f4e`; 6,786 / 0 on `f2f5138`; **6,786 passed / 0 failed on the final `680b673`** (493 files); production build 0 on `680b673` |
| `next build` | 0 | 0 (`7e24f4e`; the `f2f5138` delta is one client key handler) |
| Integration, owner role (TEST) | binding-db + field-policy-db: 0 | 0 (`7e24f4e`) |
| Integration, restricted role (TEST) | 0 | 0 (`7e24f4e`) |
| Browser proof (prod build, TEST, isolated) | 18/18 across enrol/edit/owner/view; teardown clean | On `7e24f4e`: edit 12/12 (incl. rank award in-session: plain 201, photo keys 403 by policy, nothing stored; 8+ operator-plane refusal rows), owner 2/2 (Activity pills; **owner-path foreign blob 400, inline 201, nothing stored**), view 5/5; keyboard pass 8/10 — Escape-to-close FAILED then fixed in `f2f5138` (re-run on its build: 9/10, Escape PASS; only the 390 px hub overflow remains); hub page overflows at 390 px (residual). A second edit pass on the same fixtures hit two 409 duplicates (fixture re-use, not product); the drive is now re-run-safe. |
| Browser robustness (prod build, TEST, two isolated clubs) | — | cross-club isolation (member PATCH, class PATCH, roster, rank, check-in against the other club: all 404, other club byte-identical); stale save `updatedAt` → 409 with the row at the newer value; repeat PATCH → one outcome; lost-response class create → a duplicate class (documented: not idempotent, owner-visible and deletable); step-up grant replay → refused; operator revocation mid-session → next read and write 401, nothing written. Expiry is proven by the DB suite (31-minute clock), not waited for in the browser. |
| `secret-scan --tree` | n/a | on #32: candidates 0, allowlisted 1 |

NOT RUN / expected-failure cells, with reasons:
- Two Neon-only DB suites **skip** in CI by explicit, titled condition (`db-target.ts`); their equivalents ran on the TEST branch and are recorded in PR #30. Skipped ≠ passed.
- `secret-scan --history` stays **red** on schedule-only, `continue-on-error` runs: immutable old blobs carry the pre-replacement fixture values and the documented 7 May 2026 incident values (E-06). Disposition: report-only; those values are NOT revoked by a clean tree — see §6.
- Edge-level route refusals are logged (structured line), not audited (no database at the edge).

## 4. Independent review (fresh reviewers each round, most capable model; implementer never approved own change)
| Scope | Rounds | Final verdict |
|---|---|---|
| #31 security (bypass hunt) | 2 | APPROVED WITH RESIDUALS |
| #31 functional (real UI, owner behaviour) | 3 | APPROVED WITH RESIDUALS |
| #33 security (blob ownership, refusal logging) | 3 | APPROVED WITH RESIDUALS — round 1 CHANGES REQUIRED (I-1..I-4, M-1..M-3, fixed/ruled); round 2 approved `aeef7fc`; round 3 approved the post-review commits at `621edae` (no false refusals; profile-picture canary change a real improvement); its three wording/logging nits applied in `680b673` |
| #33 functional | 2 | APPROVED WITH RESIDUALS (F1/F4 fixed; F2 residual; R2-1 fixed) |
Reports are in the session evidence pack (`review-security*.md`, `review-functional*.md`).

## 5. Access contract and bypass families
See `ACCESS-MATRIX.md` (same folder). Every reported bypass family has a reproduction, a correction, regression tests and an independent verdict:
billing/entitlements · authentication/invitation · guardian authority · financial/legal settings · communications · rank/file operations (support photo restriction in #31; the owner-path cross-tenant deletion is **#33**, fixed on every accept and delete path) · UI payloads (real-component tests) · onboarding/navigation.
"Live Stripe cancellation" in the #31 review was a code-path reproduction with the Stripe client mocked and fixtures without a Stripe account; **no real subscription or customer was affected.**

## 6. Residual register (each with impact, mitigation, owner)
| Residual | Impact | Mitigation | Owner / decision |
|---|---|---|---|
| Public demo-seed password: the scanner allowlist entry is a disposition, not a security fix; `ironpathbjj` has an owner account with a password in production (count check 14 Oct) | the public value may authenticate to the demo club (demo tenant only; same tenant isolation as any club) | rotate: seed takes `DEMO_PASSWORD` from env, rotate the demo accounts once, remove the allowlist entry | **Noe — decision 1** |
| History-mode scan values (7 May incident) | old credentials in history are not revoked by a clean tree | revocation/rotation status per E-06; do not treat the clean tree as revocation | Noe (existing E-06 action) |
| Operator-plane audit rows carry the operator id in the clear (`operatorId`, `actingAs`) — existing convention for all `admin.*` rows; the entity id is the keyed digest | operator identity visible to anyone who can read operator-plane rows | unchanged; stated | accepted |
| Announcement `imageUrl` / settings `logoUrl` accept any https URL at accept time; their delete paths now filter by namespace | no cross-tenant deletion vector remains; a foreign URL can be displayed | accept-time restriction is a product choice (external images) | accepted, follow-up optional |
| Hub Activity: refusal rows show under "All" only, no club link | discoverability | follow-up UI | minor |
| Operator hub club page overflows horizontally at 390 px (operator-only desktop surface) | mobile operator use | follow-up layout pass, no redesign | minor |
| `delete-orphan` and `blob-image` keep their own prefix check beside the shared one (now unified in #33) | — | done | closed |
| Socials/timezone/check-in windows server-permitted but not exposed in the support UI | operator cannot change them in an edit session | follow-up UI | minor |
| Settings PATCH returns the full tenant row (owner-only route, pre-existing) | response width | follow-up | minor |
| Class PATCH `isActive`/roster semantics; demote deletes ClassSubscription rows (pre-existing timetable behaviour) | — | documented | minor |
| Refusal copy shows raw field names; logo-upload fallback toast; allowlist-era dead-end buttons (shared with view sessions) | UX polish | follow-up | minor |
| Application filters are the primary tenant boundary; RLS is a backstop; the runtime role can rewrite audit rows | stated limit of the platform, not of this release | security campaign ledger | existing |

## 6b. Known behaviour to state in operating instructions
- **Class creation is not idempotent.** A lost response to *Create class* followed by a retry creates a second class with the same name (browser robustness proof, 14 Oct). Before retrying, open the timetable and check whether the class already exists; a duplicate is visible to the owner and removable by them (archive/delete is an owner action, refused in support sessions). Member creation is idempotent per desk request (`requestId`); member edits carry an `updatedAt` precondition (409 on a stale save); step-up grants are single-use.

## 7. Integration order and qualification of each deploying state
Each merge to main deploys. Order: **#30 → make "Typecheck + Lint + Vitest" required → #32 → #31 → #33 → #28 → #29**. Verify base/head on GitHub after each merge (do not assume automatic retargeting). Per-state qualification (tsc + the suites of the PRs involved + tree scan) is recorded in `INTEGRATION-STEPS.md` (same folder): every state compiles and passes its suites; the tree scan is red for the two pre-#32 states (as PR #30 states) and green from S2 on; one load-contention flake at S3 re-ran green alone. The only cross-PR conflict is `ImpersonationBanner.tsx` (#28 × #31): keep #31's scope/club-name structure and #28's `<LocalTime>` expiry (resolution rehearsed).

## 8. Statuses, kept separate
- **Engineering:** complete for #31/#33 — every executable commit on both branches has an independent review verdict; the only unreviewed delta is the three wording/logging nits the reviewer itself prescribed (`680b673`), covered by the route suites.
- **Merge:** none performed. Noe's decision per §7.
- **Deployment:** none. Production serves `9272a21`.
- **Production verification:** NOT RUN — runbook B in `RUNBOOKS.md`, to be executed after an approved deployment, on demo/synthetic clubs only.
- **Customer identity change (Sean):** NOT PERFORMED. Evidence and runbook A in `RUNBOOKS.md`; the intended address is held by one cancelled member record; the deployed hub workflow applies; Noe operates it; Sean confirms by signing in.

## 9. Single next owner action
Decide §6 decision 1 (demo password) and merge **#30** — that unblocks the required check and the rest of the order.
