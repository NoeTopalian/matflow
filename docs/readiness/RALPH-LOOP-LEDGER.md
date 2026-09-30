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

## Harness corrections (each recorded with its faulty assumption)
Recorded in the commit that made them: subscribe-guard lookup by position (`426f595`); two checkout tests reaching the card path (`6a7b1c3`); fake databases learning Prisma operators (`2572e50`); F-21 form tests signing before the text loaded (`c7e48fd`); stale member-stats mocks (`5f9122d`, `794197b`). No assertion was removed or loosened to make a gate green.
