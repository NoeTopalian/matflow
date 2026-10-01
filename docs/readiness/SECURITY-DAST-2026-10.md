# Security gate — Layer B (DAST): Nuclei (public surface)

Part of the v5 Security gate. Live-surface scan of the running **production build** at `https://localhost:3950` (TLS proxy → `next start` :3949) under the restricted role `matflow_app`, candidate `e06b7b0`, 1 Oct 2026.

## Tool and scope
[`projectdiscovery/nuclei`](https://github.com/projectdiscovery/nuclei) v3.11.1, templates v10.4.9. Template sets: `http/misconfiguration`, `http/exposures`, `http/exposed-panels`, `ssl`, `http/miscellaneous`, all severities, host-error skipping disabled. **3,304 templates, 5,709 requests, 100% complete.**

Scope is honestly the **unauthenticated public edge** only (login, `/apply`, public pages, `/api/health`, 404s, TLS, headers, cookies). Nuclei has no session/CSRF/TOTP handling, so it cannot reach the authenticated multi-tenant surface — that is Layer C's job. (First two runs under-counted: Nuclei's own resolver would not resolve `localhost`; fixed by targeting `127.0.0.1` with a `Host: localhost:3950` header and `-no-mhe`.)

## Result: 11 matches — no vulnerability
| Template | Sev | Disposition |
|---|---|---|
| `self-signed-ssl`, `tls-version` ×2, `ssl-dns-names` | low/info | **Test-proxy artifact.** The local TLS proxy uses a self-signed cert; production terminates TLS at Vercel with a real cert. N/A to production. |
| `weak-csp-detect` | info | **Known / deferred.** CSP is strong (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `upgrade-insecure-requests`) but uses `'unsafe-inline'` for script/style — the standard Next.js tradeoff. A nonce-based CSP is the gated follow-up, not a new finding. |
| `missing-cookie-samesite-strict` | info | **Intentional / correct.** The flagged cookies are NextAuth's `__Host-authjs.csrf-token` and `__Secure-authjs.callback-url`, `SameSite=Lax` by necessity (sign-in redirects break under Strict). Both are `__Host-`/`__Secure-`-prefixed, HttpOnly, Secure. |
| `http-missing-security-headers` | info | **Core headers present** (X-Frame-Options: DENY, X-Content-Type-Options: nosniff, HSTS 2y preload, Referrer-Policy, a full Permissions-Policy, CSP). The "missing" set is optional COOP/CORP/COEP-type headers; adding them blindly risks Stripe/embeds, so left as optional hardening. |
| `robots-txt`, `security-txt`, `options-method`, `google-floc-disabled` | info | **Informational.** A `robots.txt` and a `security.txt` (contact present) exist; `OPTIONS` returns `GET, HEAD`; FLoC is already disabled via `Permissions-Policy: interest-cohort=()`. None is a weakness. |

## Fix applied
`X-Powered-By: Next.js` was disclosed on every response (framework/stack disclosure). **Fixed:** `poweredByHeader: false` in `next.config.ts` (applies on the next build). Free hardening, no functional impact.

## Verdict
**Layer B CLEAN** on the public surface: no vulnerability; the app already ships a strong security-header and CSP posture. One stack-disclosure header removed; nonce-based CSP and optional COOP/CORP headers remain gated follow-ups. Raw output: `scratchpad/sec/nuclei-public3.jsonl`.
