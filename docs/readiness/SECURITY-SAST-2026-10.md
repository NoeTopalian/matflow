# Security gate — Layer A (SAST): Semgrep

Part of the v5 Security gate (release-assessment plan). Static analysis of the codebase; the live-surface scan (Layer B, Nuclei) and the independent isolation/identity/money review (Layer C) are separate documents.

## Tool
[`semgrep/semgrep-rules`](https://github.com/semgrep/semgrep-rules) via the Semgrep CLI (1.178.0), rulesets pinned in `scripts/security-scan.mjs`:
`p/owasp-top-ten`, `p/nextjs`, `p/typescript`, `p/javascript`, `p/react`, `p/secrets` (community packs, no login; fetched from the registry at run time).

## Scope and run
- Targets: `app lib components auth.ts proxy.ts scripts` (excludes in `.semgrepignore`: build output, `.omc`, `scratchpad`, `test-results`, `prisma/migrations`, minified/generated).
- **595 files scanned**, 1 Oct 2026, on candidate `021556e`+ (test branch, local).
- Four non-fatal `PartialParsing` warnings on JSX text containing `&` (e.g. "Emergency Contact & Privacy"); the files are still scanned. No coverage gap worth blocking.

## Findings and disposition
| # | Rule | Location | Severity | Disposition |
|---|---|---|---|---|
| 1 | `javascript.node-crypto.security.gcm-no-tag-length` | `lib/encryption.ts:30` | ERROR | **FIXED.** AES-256-GCM `createCipheriv`/`createDecipheriv` now pass `{ authTagLength: 16 }`, so Node rejects a forged or truncated tag rather than relying only on the 16-byte slice. Tests added: `tests/unit/encryption.test.ts` (round-trip incl. unicode/empty/5 KB; random IV; tampered tag rejected; tampered body rejected; truncated tag rejected). 5/5 pass; `lib/google-drive.ts` (the only caller) round-trips unchanged. |
| 2 | `generic.secrets.security.detected-bcrypt-hash` | `lib/operator-auth.ts:39` | ERROR | **FALSE POSITIVE — annotated `nosemgrep` with the reason.** The literal is `PLACEHOLDER_HASH`, a dummy bcrypt hash compared against when an operator email is not found, to equalise timing (anti-enumeration). Its plaintext grants nothing: the compare result is discarded when the row is absent. Not a credential. |

## Ratchet and gate
- `scripts/security-scan.mjs` runs the scan, counts by severity, and compares to `scripts/security-baseline.json`. **Baseline: ERROR 0 · WARNING 0 · INFO 0.** ERROR is held at zero regardless of the baseline; any severity rising above baseline fails. Counts may only fall (same discipline as the UI-RULES and RLS ratchets).
- CI: a gating "Security SAST ratchet" step in `.github/workflows/ci.yml` after the lint gate (installs Semgrep via pipx, runs the ratchet). Fails the build on any new finding.
- Local (Windows): Semgrep 1.178.0 runs natively; `export PATH=$PATH:~/AppData/Roaming/Python/Python312/Scripts` then `node scripts/security-scan.mjs`.

## Verdict
**Layer A CLEAN** on `021556e`+: zero ERROR after one real hardening and one annotated false positive, held by a CI ratchet. Independent confirmation of the two dispositions belongs to the Layer C reviewer (crypto hardening is tool-confirmed by the re-scan; the placeholder-hash call is a code-reading judgement to be seconded).
