# Review of lane I (independent architect) — saved by lead
1 Carrier never a usable session alone: PASS (auth.ts:973-985 resolver throw → null; :1068 not active/carrier stash → null; edge guard :858-863 unreachable/untested). Latent: proxy.ts:284 `!req.auth` and lib/authz.ts:33 `!session` accept {user: undefined}.
2 Mint order + attributes: PASS (impersonate route: CSRF 98, authed 101, rate 106, named MFA op 129-137, no live 140, admission 159, step-up 166, mint 180, durable audit 191-215, startSupportSession 217, cookie 227-235). E2E caveat: cookie name by NODE_ENV vs Auth.js by protocol — use https in E2E. Doc nit auth.ts:145-146.
3 After stop/expiry/logout/suspension: PARTIAL — D-I1 route.ts:311 store.delete sends Set-Cookie without Secure → __Secure- session cookie not cleared in prod (club session restored from stash instead of cleared).
4 30-day reissue: PASS; low: hasAuthJsSession (route.ts:71-79) counts stale carrier as club session.
5 LoginEvent always written: PASS; gaps: void fire-and-forget (auth.ts:512,572,808) may be lost; new always-on processing not in privacy page; no LoginEvent retention purge. Written at password match (before TOTP).
6 D-I2 Medium: create-tenant (route.ts:32,76,90-96) operator-chosen ownerPassword, no mustChangePassword, audit admin.tenant.create not in OPERATOR_RESET_ACTIONS and not fetched by callers → operator sign-in + enrol reads ALREADY ACTIVATED.
Suspend guard PASS; nit: step-up spent (78) before 409 (90).
7 Replay 8 files 74 passed; mutants c1, c3, r1 killed; c2/c4/c5/c6 survived (redundant/unreachable).
