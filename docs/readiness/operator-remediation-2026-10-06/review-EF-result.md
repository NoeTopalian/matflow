# Review of lanes E+F — all PASS (independent architect replay)
Matrix 54/54 both roles; roster 3/3 both; rls-foundation restricted 9/9; units 37/37; class-schedule-edit 5/5 both; eslint+tsc clean.
Defects: D1 push bypass on caller memberId (FIXED by lead: tenant-scoped withTenantContext, callers pass tenant, test renamed push-tenant-scope 6/6);
D3 maybe-migrate endpoint mismatch (FIXED by lead: exit 1 before migrate, test 5/5); D4 backup comment overclaimed (FIXED wording; pointer to BACKUP-SECRETS-SETUP.md);
D2 info (soft-deleted own belt accepted) no change; coverage gap: integration positive control for same-tenant locationId PATCH (unit only).
Runbook notes: RUNTIME §1A step 2 "load a dashboard page" writes login rows — use /api/health; Option B: Sensitive vars pull empty (confirmed by lead: Vercel returns [SENSITIVE]).
