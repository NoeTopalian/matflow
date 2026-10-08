# Account editing — evidence (8–9 Oct 2026)
Supports `docs/runbooks/ACCOUNT-EDITING.md` and the Total BJJ handover. Synthetic fixtures on the Neon test branch only.

| File | What |
|---|---|
| `report-R-account.md` | Own profile, own password, operator owner-name control, My account page (lane R) |
| `review-R-result.md` | Independent review of lane R — D1–D4 found and fixed |
| `report-S-staff.md` | Owner edits of staff follow the self-service rules; shared password policy (lane S) |
| `review-S-result.md` | Independent review of lane S — S-1..S-3 found and fixed |
| `report-G-account-e2e.md` | Production-mode browser runs A1–A9, both database roles, plus the A1 re-check |

Final delta review (name refresh, staff audit in transaction, undo): APPROVE. Gates on `4c1825c`: unit 393 files /
4,447 tests, typecheck, lint; production build exit 0.
