# Review of lane S (independent architect) — saved by lead
PASS, 3 LOW. Replays: 7 unit files 173 passed; account-editing-db 14/14 both roles; cross-tenant matrix 54/54 both roles. Mutation 8/8 killed.
Areas PASS: targeting (404 for owner/own/other club), escalation/mass assignment, requireApiOwner gate + support refusal, stale tokens after staff email change, partial updates (P2002 rollback opaque 409), reset/set-password on shared policy, lane R D1–D4.
S-1 LOW-MED staff.update audit best-effort → FIXED by lead (logAudit({tx}) inside the transaction; test: audit failure → 500).
S-2 LOW undo could restore an old email bypassing checks → FIXED by lead (email removed from RESTORABLE.User; test renamed).
S-3 LOW owner-takeover property undocumented + staff provisional mark has no clearing path → FIXED by lead (ACCOUNT-EDITING.md principles).
Test gaps (not defects): P2002 → 409 branch untested; DB constraint for staff/member address collision (known gap).
