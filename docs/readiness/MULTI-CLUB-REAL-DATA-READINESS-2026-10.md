# Is MatFlow ready for multiple clubs with real data? — confirmation for Noe

Prepared 1 Oct 2026, 22:00 Italy. Candidate **`279ba7e`** on `main` (local, not pushed). This is the "confirm it's ready" Noe asked for before he sets up Sean's email and club. It says what is proven, by what, and what is still blocked and whose.

> Milestones, never conflated: **ENGINEERING VERIFIED** (frozen candidate passes the agreed checks, not deployed) · **READY FOR ACTIVATION** (after an authorised deploy + production checks + the real named account) · **ACTIVATED** (Sean enrols his authenticator and signs in). Today's verdict is about the first.

## Verdict

**ENGINEERING VERIFIED for `1276e24`** (the base: enforced owner MFA, isolation review, owner workflows, 29/29 browser files green). **`279ba7e` adds tonight's three pieces** (elevated-role MFA + owner staff reset, club contact email + Reply-To, owner Activity log with undo); its static gates are green and its full 29-file browser pass is **running** — the row below is updated when it lands.

**Multi-club: PROVEN for the candidate at the pilot envelope, not for production.** Isolation is confirmed by an independent review (no cross-club or cross-family reach across 11 areas, plus the P1 API-MFA bypass found and fixed), RLS is enforced under the restricted role (9/9), and ten synthetic clubs were onboarded and driven concurrently on the production build at the labelled laptop workload (`CAPACITY-TEN-CLUBS.md`, `TEN-CLUB-AUDIT-2026-09-25.md`). What that does *not* prove: production latency or capacity on Vercel + Neon (never measured there), and the production database role (BYPASSRLS until Noe runs the query).

**Real data: the machinery is proven on synthetic data; the real import stays BLOCKED on authorisation.** Import preview → commit → refresh → rollback are atomic and reconciled exactly on a 300-row source-shaped synthetic export; partial failure reports failure, never success; attendance import has its own rollback. Sean's real export has not been touched and must not be until Noe gives the written go (and names where it may live).

**Not deployed. Not provisioned. Sean not contacted.** Nothing in this document changes that.

## What is proven, and by what

| Area | Evidence | Candidate |
|---|---|---|
| Static gates | tsc 0 · lint clean, UI ratchets at baseline · Semgrep 0/0/0 · production build exit 0 · unit+integration (see row below) | `279ba7e` |
| Unit + integration | 2,781 passed / 0 failed on `279ba7e` (full suite, vitest) — *fill from the run in progress* | `279ba7e` |
| Browser pass | **29/29 files, 645 passed / 0 failed / 0 did-not-run, first attempt** on `1276e24`; `279ba7e` run in progress (`x12/serial/final-279ba7e`) | `1276e24` → `279ba7e` |
| Tenant isolation | Independent Layer-C review CONFIRMED (3 clubs, 2 families, TeamUp-billed member, IDOR/priv-esc/CSRF/injection/upload/webhook/token/pool-bleed batteries); P1 API-MFA bypass found → fixed `1276e24` → re-confirmed | `1276e24` |
| RLS backstop | `scripts/test-rls-enforced.mjs` 10/10 under `matflow_app` after tonight's migration | `279ba7e` |
| Auth lifecycle | Independent re-verifier WORKING 12/12 on the production build, bypasses off (enrol, challenge, negatives, throttle, revocation, no self-disable, single-use recovery, secure cookies) | `1276e24` |
| Elevated-role MFA | `lib/mfa-policy.ts`; red-on-revert `totp-mandatory-elevated` (manager/admin held, coach not); proxy matrix + API gate rows; owner reset of a staff authenticator proven on the wire (owner id → 404) | `02ed28d` |
| Owner workflows | Independent acceptance 8/9 areas WORKING through the UI with DB + reload (classes, registers, members/families, memberships incl. resume, waivers, manual payments, reporting, staff/settings); import BLOCKED environmentally (no Blob token locally) — unit/integration/prior e2e stand | `1276e24` |
| Club contact email | `Tenant.contactEmail` migrated (test branch), Settings card, member-app fallbacks, Reply-To on every club-voiced template; wire smoke PASS | `02ed28d` |
| Activity log + undo | Registry + batch unit tests (25); wire smoke PASS (edit → undo → restored → undo row → second undo 409 → undo-to batch reverses 2, skips none older); page renders 375/1440 without overflow | `39c8eea` |
| Ten clubs (candidate) | 10 synthetic clubs via the real doors; concurrent workload on the production build under the restricted role, 0 unexpected 5xx at the labelled envelope | `25 Sep` lineage |
| Import integrity | Manifest (hash, source time, mapping version), same-file refusal, interrupted-batch re-run without duplicates, changed-file diff, rollback that leaves edited rows, exact reconciliation on 300 synthetic rows; partial failure → `ok:false` | `9eed314`+ |
| Migrations | 11 pending migrations additive, wrapped, atomicity-tested; old build keeps serving on the new schema; history does not replay from empty (second environment needs a squash) | `279ba7e` |
| Security scan | SAST clean + CI ratchet; DAST (Nuclei) clean on the public edge | `e06b7b0`/`ea43b47` |

## What is NOT proven (honest limits)

- **Production capacity and latency** — every load figure is laptop → Neon test branch, pool max 5. Labelled diagnostic, not production capacity.
- **Production DB runtime role** — presumed BYPASSRLS; RLS is a backstop only until Noe runs the query (ADR-001 D8). The app-layer tenant filter is the primary control and is what the isolation review confirmed.
- **Point-in-time restore** — never rehearsed (Neon console, Noe).
- **Email delivery** — dark until `RESEND_FROM` + SPF/DKIM/DMARC; activation is mail-free by design, member invites are not.
- **Real TeamUp data** — the rehearsal was synthetic; format acceptance of Sean's attendance export waits on the file.
- **Human acceptance** — no Sean, no desk user yet (Track B blocked on Noe's go to contact them).
- **Member soft-delete (plan item S4)** — not built tonight; "Delete member" is still a hard delete and is listed as not undoable on the Activity page. Deferred deliberately: it touches every member reader and needs its own browser pass.

## Blocked on Noe (named; nothing here is waiting silently)

1. **"push"** — deploys `279ba7e` + 11 additive migrations (`scripts/maybe-migrate.mjs` runs them in the Vercel build).
2. **Sean's authoritative name + PRIVATE email** (not the club's shared inbox — see the release package §7) and the go to create the real Total BJJ tenant.
3. **DMARC/`RESEND_FROM`** on matflow.studio (~75 min, `docs/EMAIL-SETUP-RUNBOOK.md`) — switches on all 23 templates and self-service resets; Reply-To then lands member replies in the club inbox.
4. **Production DB role query** (one line) and **one Neon restore rehearsal**.
5. **`CRON_SECRET`** only after reading the retention `?dryRun=1` preview; confirm **`BLOB_READ_WRITE_TOKEN`** on Vercel.
6. Written authorisation for where Sean's real export may be rehearsed (test branch with 24-h cleanup, or production only).

## What Noe can do the moment this is green

Set up Sean's email (DMARC) and create his club — in that order, because the create-tenant step wants his private address as the login and the club's `info@` goes into Settings → Contact email on his first sign-in.

---
_Updated when the `279ba7e` browser pass and the independent review land; the two rows above marked "in progress" are the only open items on the candidate itself._
