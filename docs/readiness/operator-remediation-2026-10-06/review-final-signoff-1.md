# Ralph completion sign-off #1 (architect) — REJECT (documentation/procedure only)
Spot-run 12 key unit files at 2203087: 562 passed. Gate logs: unit 4160/4160, tsc 0, lint 0, build OK.
Stories US-001..US-010 PASS (US-004 inventory not in repo; US-010 build provenance caveat). US-011 FAIL:
1 Rollback via promote/Instant Rollback keeps old env → old known MATFLOW_ADMIN_SECRET; every retained old deployment URL accepts the old secret against prod even after deploy unless Deployment Protection covers generated URLs. → package rewritten: never promote; fix forward or rebuild old code fresh; Deployment Protection + delete old deployments; smoke check 9. Lead rehearsed e8afb6a migrate deploy on the test branch with the 4 new migrations applied: exit 0.
2 Rollback table incomplete → all reopened doors listed with fallbacks.
3 Over-claims: CSRF "(browser)" → unit replay; "browser-verified" provenance → exact builds per flow; Gate 1 → also except runtime role. Fixed.
4 Tested SHA missing → §9 + audit doc state 2203087 and the browser build diff hashes.
5 Register/evidence only in scratchpad → committed under docs/readiness/operator-remediation-2026-10-06/; H and J verdicts written.
Unaddressed: XSS breadth, multi-instance, cache keys → OPEN/UNVERIFIED/UNCHECKED rows added; RUNTIME-DB-ROLE-CHECK.md:55 → /api/health.
