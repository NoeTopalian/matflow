# Ralph loop ledger (readiness spec v3 §13.2)

Every loop: inspect (acceptance) → reproduce → implement → verify (red on revert where practical) → challenge (independent reviewer) → correct → confirm on the frozen candidate. States: **CLOSED–VERIFIED** (requirement met, evidence, independent reviewer confirmed on the same candidate), **OPEN–FIXED–AWAITING CONFIRMATION** (fixed and tested, re-check pending), **OPEN–BLOCKED**, **OPEN–DEFERRED**, **DECISION** (needs Noe/Sean).

Candidates: `10776a4` (first freeze, 30 Sep 10:36 Italy) → `1672209` / `794197b` (second freeze; `794197b` differs only by a test mock).

## Loops opened by the seven verifier lanes (production build, restricted role)
| Loop | Found by | Fix | Regression evidence | Independent confirmation | State |
|---|---|---|---|---|---|
| Sign-in, roles, sessions, passwords | lane 1 | `2d5e9eb`, `4108d69`, `a41a1a3` | unit | lane 1 WORKING | CLOSED–VERIFIED (lane 1's candidate; re-confirmed by the full assess on the final freeze) |
| Member portal, waivers, families | lane 2 (3 rounds) | `4de3368`…`c1d5393`, `d5473ab` | red on revert (retry keys) | lane 2 WORKING on `9eed314` | CLOSED–VERIFIED on `9eed314`; later waiver changes (`e5bd81d`, `c7e48fd`) await the final pass |
| The desk | lane 3 (2 rounds) | `405594e`, `baca43b`, `2e60bb4` (kiosk panel) | unit + e2e | lane 3 WORKING on `86f0c9b` | CLOSED–VERIFIED on `86f0c9b`; `2e60bb4`/`5f9122d` await the final pass |
| Money | lane 4 | `a41a1a3` | unit | lane 4 WORKING | CLOSED–VERIFIED |
| Import, attendance, review mode, retention | lane 5 (3 rounds) | `d978533`, `df66008`, `1ec7d88`, `212995c`, `a8a54c2` | red on revert | lane 5 WORKING on `9eed314` | CLOSED–VERIFIED on `9eed314`; import changes since (`2572e50`, `d97a3c4`) re-checked by the functional reviewer |
| Isolation between clubs | lane 6 | — | RLS 10/10, RLS coverage test, assess cross-tenant cells (evidence, not confirmation) | **none** — dispatch refused by the safety classifier twice (lane 6; security/data reviewer on `10776a4` stopped before any attack) | **OPEN–BLOCKED — Noe's go** |
| Mistakes and errors | lane 7 (3 rounds) | `0bb44d6`, `86f0c9b`, `9eed314` | red on revert | lane 7 WORKING on `9eed314` | CLOSED–VERIFIED on `9eed314` |

## Loops opened by the full assess on `9eed314`
| Loop | Mechanism | Fix | Evidence | State |
|---|---|---|---|---|
| lb-1 J16 / lb-2 J18 time-outs | KioskPanel asked the owner-only route for every role and left the 403 body unread, so the page never went network-idle | `2e60bb4` | lb-1 29/29, lb-2 30/30 on re-run | OPEN–FIXED–AWAITING final assess |
| lf-2 contrast | club colour as text on the dark member shell (2.5–2.9:1) | `2e60bb4`, `426f595`, `be75592` (legibleInk) | lf-2 40/41 → last label fixed | OPEN–FIXED–AWAITING final assess |
| lb-2 staff key set, lc-3 20 MB upload | intended product changes (`2d5e9eb`, `212995c`) | spec expectations updated with the reason | re-run green | CLOSED (harness) |

## Loops opened by the connection register (independent read-only trace)
29 gaps with dispositions in `CONNECTION-REGISTER.md`. Fixed with red on revert: 2, 12, 13, 15, 17, 21, 24; fixed without an isolating test: 10, 14, 16, 25. The rest are named limitations tied to G3/G4 or accepted, and one is OPEN–DEFERRED to G3 (19, the magic link spent on GET).

## Loops opened by the TeamUp bridge (spec §7)
| Loop | Fix | Evidence | Independent confirmation | State |
|---|---|---|---|---|
| Who bills a member; standing date | `426f595` (schema, guards), `3ccc20d` (refresh, screens) | red on revert (guards); refresh tests over an in-memory DB | functional reviewer on `10776a4`: marking, staleness, no second collection, review mode CONFIRMED | re-check on the final freeze pending |
| F1 refresh lifted a MatFlow hold (P1) | `d97a3c4` | red on revert | functional re-check on `1672209` pending | OPEN–FIXED–AWAITING CONFIRMATION |
| F2, F6, F8, F3–F5 | `d97a3c4` | red on revert (F2, F6); tests (F8, F3, F5); F4 untested | functional re-check pending | OPEN–FIXED–AWAITING CONFIRMATION |
| F7 card routes' refusal wording in the real bridge set-up | — | — | — | NAMED LIMITATION |

## Loops opened by the end-user simulation (Track A round 1 on `10776a4`)
| Loop | Fix | State |
|---|---|---|
| Register marks by typing alone | `5f9122d` | OPEN–FIXED–AWAITING round 2 |
| No-waiver admitted with only a tag | `5f9122d` | OPEN–FIXED–AWAITING round 2 |
| Signed text ≠ recorded text | `c7e48fd` (red on revert, server) | OPEN–FIXED–AWAITING round 2 |
| Stale screens, wrong labels, totals | `5f9122d` | OPEN–FIXED–AWAITING round 2 |
| Guardian refused the child's waiver image | `e5bd81d` (red on revert) | OPEN–FIXED–AWAITING final pass |
| New members "Paid" with no payment; adults into kids classes; manager family actions | — | DECISION — Noe |
| Family duplicates / desk child stored as adult | — | OPEN–DEFERRED |

## Loops opened by the final pass on `021556e` (615 passed · 13 failed · 17 not run), 1 Oct 2026
| Loop | Class | Mechanism | Fix | Evidence | State |
|---|---|---|---|---|---|
| a0-3, a0-4 coach "sign-in refused" | HARNESS | the sign-in helper chose the coach's own password at the forced step (a0-2) but kept it in memory; a0-3 runs in a new process and signed in with the original, correctly refused | `54f02f4` (chosen passwords kept beside the run stamp) | a0-1→a0-4 24/22/23(+1 skip)/17, 0 failed (w1-loop1b) | CLOSED–VERIFIED (harness) |
| le-1 J68, lh-1 C5.12 resume wrote "No payment yet" | PRODUCT | `d2adaee` inferred the resumed standing from payment rows; a member "paid" with no Payment row came back as "No payment yet" | `fd3f2d8` (`Member.holdPriorStatus`, restored exactly) | unit red on revert (3 failed); le-1 44/0, lh-1 10/0 | FIXED–AWAITING VERIFICATION (independent reviewer) |
| lb-3 J20 setup, 10 cells not run | ENVIRONMENT | two throwaway rows and seven sign-ins on the remote branch exceed the 30 s hook budget; failed alone too, passed 12/12 with room | `3be7392` (hook budget 120 s, as lc-3/le-1) | lb-3 12/0 through the serial runner | CLOSED–VERIFIED (harness budget; no assertion changed) |
| lf-1 J49 A2 "live A" not on today's grid | UNCERTAIN | not reproduced: lf-1 35/0 alone today. Ruled out: accumulated A2 classes (one set on the branch), the `neverNext` change in `021556e` (cannot hide a block). Not ruled out: a run crossing the frozen 21:15 day boundary | — | passes alone; watch in the freeze pass | OPEN — recurrence recorded, not hidden |

## Loops opened by the Security gate (v5, three layers), 1 Oct 2026
| Layer | Loop | Fix | Evidence | State |
|---|---|---|---|---|
| A (SAST, Semgrep) | AES-256-GCM decrypt without `authTagLength` | `e06b7b0` — pin `authTagLength: 16` on cipher+decipher | `tests/unit/encryption.test.ts` 5/5 (round-trip, tampered/truncated tag rejected); ratchet 0/0/0 + CI gate | CLOSED–VERIFIED (tool re-scan) |
| A (SAST) | bcrypt literal flagged as a secret | annotated `nosemgrep` with the reason (anti-enumeration placeholder, grants nothing) | `lib/operator-auth.ts:39` | CLOSED (false positive, dispositioned) |
| B (DAST, Nuclei) | `X-Powered-By: Next.js` stack disclosure | `ea43b47` — `poweredByHeader: false` | Nuclei 3,304 templates/5,709 reqs, no vuln; `SECURITY-DAST-2026-10.md` | CLOSED (applies on next build) |
| B (DAST) | `unsafe-inline` CSP (weak-csp-detect) | — | strong CSP otherwise; nonce CSP is a gated item | DEFERRED–EXPLICITLY ACCEPTED |
| C (independent review) | manager can export payment CSV (P2) | — | `requireApiOwnerOrManager`, same as Reports | OPEN — policy confirm for Noe (recommend keep) |
| C | cross-tenant id → 200 empty on two GETs (P3); DELETE 400-before-404 (P3) | — | no disclosure; existence never confirmed | ACCEPTED |
Independent review (`e06b7b0`): all 11 areas CONFIRMED, **no P0, no P1**; evidence `SECURITY-ISOLATION-REVIEW-2026-10.md`, `SECURITY-SAST-2026-10.md`, `SECURITY-DAST-2026-10.md`. BLOCKED on env (recorded, not worked around): Stripe-gated card paths, magic-link raw-token double-verify, webhook replay, login throttle under TESTING_MODE (verified separately 8/8 with bypasses off).

## Loops opened by the Sean owner-account delivery (W1–W5), 1 Oct 2026
| ID | Sev | Mechanism | Fix | Evidence | Independent verdict | State |
|---|---|---|---|---|---|---|
| MFA-enforce | — | owners' 2FA was optional (gate removed 2026-05-07) | `64263ba` — mandatory owner TOTP on page + API | prod build, bypasses off, 12 checks WORKING | auth verifier a04c0764 | CLOSED–VERIFIED |
| FINDING-1 | med | activation enrolled TOTP before the password change (proxy ran before mustChangePassword) | `74682a9` — /login/totp/setup server-shell redirects to /set-password first | re-verified order password→TOTP | auth re-verifier adce7a3c | CLOSED–VERIFIED |
| W3-MFA-1 / FINDING-A | **P1** | the API half of the gate was only in requireApiRole; ~82 bare-`auth()` routes (incl. /api/members, /api/reports) let a not-enrolled owner read tenant data | `1276e24` — middleware gates every /api with JSON 403 (single chokepoint) | two independent reviewers converged; proxy unit test 403; prod-build re-confirm on `1276e24` | isolation a9ecdb57 + auth re-verifier adce7a3c | FIXED — re-confirm on rebuilt build |
| R-PII-1 export audit | — | payments CSV export wrote no audit row | `a841520` | red-on-revert; workflow agent saw the `payments.export` row written | workflow verifier afcba7fb | CLOSED–VERIFIED |
| FINDING-B | med | TOTP verify tolerance wide (otplib 13.4.0 `epochTolerance`, not `window`); a −120s code accepted live | — | pre-existing, not from these commits | auth re-verifier | OPEN — documented; tighten to ±1 step with a test (focused follow-up; not a bypass, not a release-blocker) |
| D-MED | low | member-profile Edit form omits `medicalConditions`; API doesn't persist it | — | populatable via import/member-side; shown role-gated on register | workflow verifier | OPEN–DEFERRED (explicit disposition; small form+schema follow-up) |
| P2 migrate billedBy | — | migrate-memberships doesn't refuse TeamUp-billed | — | intended cutover path (G4); review-lock + Stripe-not-connected protect it in the bridge | isolation verifier | ACCEPTED (by design) |
| P3 hold/resume on TeamUp member | — | hold/resume succeed on a TeamUp-billed member | — | access-only, no provider call (HOLD_ACCESS_ONLY_NOTE); contract defines holds as MatFlow-access | isolation verifier | ACCEPTED (by design) |
Isolation areas NOT RUN in this pass (XSS, CSV-injection, upload abuse, webhook replay, pooled 50-interleave, tokens) were CONFIRMED in the earlier full Layer C review on the near-identical `e06b7b0`/`b2af378`; W3-MFA-1 does not touch them.

## Harness corrections (each recorded with its faulty assumption)
Recorded in the commit that made them: subscribe-guard lookup by position (`426f595`); two checkout tests reaching the card path (`6a7b1c3`); fake databases learning Prisma operators (`2572e50`); F-21 form tests signing before the text loaded (`c7e48fd`); stale member-stats mocks (`5f9122d`, `794197b`). No assertion was removed or loosened to make a gate green.

## 1 Oct 2026, evening — staff-tier security · club email · owner activity log with undo (plan S1–S5)
Candidate `1276e24` closed as **ENGINEERING VERIFIED**: 29/29 browser files, 645 passed / 0 failed / 0 did-not-run, first attempt, no server deaths (`x12/serial/final-1276e24`). Three loops then ran on top, each test-first, fixer ≠ reviewer (independent review dispatched on the committed diff, result in `scratchpad/ralph/review-s123-result.md`):

| Loop | Finding / ask | Fix | Red-on-revert | Verified by | Status |
|---|---|---|---|---|---|
| S1 elevated-role MFA | owner-only mandatory TOTP; "owner and admin accounts should have more security" | `lib/mfa-policy.ts` (owner/manager/admin), `auth.ts` both doors; owner staff TOTP reset route + Settings control; banner copy | `totp-mandatory-elevated` (manager/admin held) was red before the auth.ts change, green after; `staff-totp-reset` (4) | unit + integration matrix; wire smoke (manager reset 200, owner id 404) | CLOSED — commit `02ed28d` |
| S2 club contact email | the club's `info@` must be a member contact + Reply-To, never a login | `Tenant.contactEmail` migration; Settings card; `/api/me/gym` fallbacks; Reply-To on club-voiced templates; shared-mailbox advice on create-tenant + `/apply`; setup-gap nudge | `email-club-reply-to` (7), `email-shape` (12); settings PATCH fakes gained `findUnique` (harness: the route now reads before writing — recorded) | wire smoke (settings → me/gym fallbacks; create-tenant warning) | CLOSED — commit `02ed28d` |
| S3 activity log + undo | owner sees everything staff did; undo per action and "since here" | `lib/audit-labels.ts` (scan-pinned), `lib/undo-registry.ts`, `lib/undo-batch.ts`, 2 routes, page + nav, before/after snapshots on 6 update routes, `fromStripes` on promote | `undo-registry` (16), `undo-batch` (5), `audit-labels` (4 incl. the scan); `audit-log-get` fakes gained the undo-row + staff reads | wire smoke (edit → undo → restored → undo row → 409 on repeat → batch 2/0); screenshots 375/1440 no overflow | CLOSED — commit `39c8eea` |
| S4 member soft-delete | "Delete member" is a hard delete, not undoable | — | — | — | DEFERRED (explicit): touches every member reader; needs its own browser pass; migration staged outside the tree |
| Build race | `next build` while `next dev` runs corrupts `.next/dev/types` | stop dev → `rm .next/dev` → build (exit 0) → restart via x6 | n/a (environment) | — | ENVIRONMENT, recorded |
| Journey ids | J71/J72 already taken | J76/J77 | manifest test | — | HARNESS, recorded |

Gates on `279ba7e`: tsc 0 · lint 0 errors, ratchets at baseline · Semgrep 0/0/0 · build exit 0 · RLS 10/10 restricted · full unit+integration (run in progress at write time) · 29-file browser pass `final-279ba7e` (in progress). Nothing pushed, deployed, provisioned or sent.

### Review loop on `02ed28d`/`39c8eea` → fix `e9bed13` (1 Oct, 22:00–22:40 Italy)
Independent reviewer (read-only, no dev server): **20 findings, 9 P1 / 8 P2 / 3 P3, no cross-tenant P0** (`scratchpad/ralph/review-s123-result.md`). Confirmed sound: undo authority + tenancy, undo-of-undo, batch rollback, already-undone window, hold/rank metadata keys, staff reset reach, Reply-To injection, audit filters. Every finding was reproduced by reading the code it named, then fixed test-first in `e9bed13`:

| # | Finding | Fix | Pinned by |
|---|---|---|---|
| P1 | magic-link door skipped mandatory enrolment | `requireTotpSetup` on the magic-link JWT | `magic-link-security` (TESTING_MODE mocked off) |
| P1 | staff reset left recovery codes valid (`undefined` no-op) | `Prisma.JsonNull` on staff AND member resets | `staff-totp-reset` |
| P1 | undo of role/email kept the live session | `sessionVersion` bump on restore | `undo-registry` |
| P1 | check-in undo ate pack credits | `restorePackCreditsForAttendance` first | `undo-registry` |
| P1 | staff-mark undo never worked (pair entityId) | resolve by (classInstanceId, memberId); override/card-scan refused honestly | `undo-registry` |
| P1 | cancel/reactivate undo ignored Stripe | refuse `status` ↔ cancelled and any `stripe` metadata | `undo-registry` |
| P1 | 2,000-char truncation damaged restores | whole to 20,000; `truncated` flag → refused | `audit-snapshot`, `undo-registry` |
| P1 | "exactly as it was" untrue ×6 | copy made honest; demote `fromStripes`; make-default refused; all DIFFABLE fields diffed; retyped link refused | `undo-registry` |
| P1 | health data in audit rows | notes/medical removed from the diff | — (source) |
| P2 ×8 | 10-char stale match · cleared DOB 500 · first-grading 500 · stripes stale · re-plan on confirm · validation bypass · concurrent undo · tier vs Stripe price | fixed, fixed, refused, fixed, `expectedIds` → 409, **ACCEPTED (documented)**, **ACCEPTED (documented)**, refused | `undo-registry`, smoke (stale preview → 409) |
| P3 ×3 | Tenant entityId check · fetch catch · card-scan reason | all fixed | `undo-registry` |

Re-review of `e9bed13` dispatched to a different agent; browser pass `final-e9bed13` queued behind the full suite. Nothing pushed.
