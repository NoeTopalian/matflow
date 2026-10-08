# Review of lane R (independent architect) — saved by lead
Replays: unit 5 files 277 passed; integration account-editing-db 12/12 engine + 12/12 restricted. Mutants 17/19 killed (survivors f2 token.id check, l2 history limit — test gaps).
Areas: takeover via profile/password PASS (session user only; mass assignment incl. __proto__/nested/arrays refused; member/temp/TOTP-pending/unenrolled/support refused; replay refused) EXCEPT D1; MFA bypass PASS (D2 low); stale tokens/sessions/partial updates/audit PASS; operator step-up binding PASS; matrix: two mismatches.
D1 MED password route checks strength/reuse after current password but before the code → password-correctness oracle for a stolen session without the authenticator (+ bcrypt timing). Fix: non-spending code check right after bcrypt; generic REFUSED.
D2 LOW password-only path chosen from row alone; refuse unenrolled roles that require TOTP.
D3 LOW name rule misses U+0080–009F, U+2028/2029, bidi controls.
D4 LOW doc: "every self-service change" (GET profile allowed for support).
Not checked: browser; integration mocks step-up/getToken.
