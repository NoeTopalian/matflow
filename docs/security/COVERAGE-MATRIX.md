# Security coverage matrix (campaign of 9 Oct 2026)

Candidate under test: `2a6487e` (source build `c837e38`), branch `security/assurance-2026-10`. One row per catalogue ID from the
brief; applicability APPLICABLE / NOT APPLICABLE WITH EVIDENCE / UNKNOWN; verification NOT RUN / FAIL / FIXED AWAITING RETEST /
PASS / BLOCKED. NOT APPLICABLE is not PASS; UNKNOWN and BLOCKED are never folded into a green count. Levels: U I B C S L R Fuzz.
Lanes update their rows through their evidence reports; the coordinator integrates. Standard IDs (ASVS 5.0.0 / WSTG / CWE /
CAPEC) are filled only when a lane has looked the ID up — never invented.

| ID | Area | Lane | Risk | Required invariant | Level | Applicability | Verification | Evidence (SHA, file, exit) | Reviewer | Standard refs |
|---|---|---|---|---|---|---|---|---|---|---|
| SEC-001 | Authentication and account recovery | A | Credential guessing/stuffing | throttling and account protections cannot be bypassed via alternate entry points | U/I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-002 | Authentication and account recovery | A | Account enumeration | unauthenticated responses reveal no existence via content/status/timing | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-003 | Authentication and account recovery | A | Password reset takeover | tokens unpredictable, scoped, short-lived, single-use | U/I: wrong subject, expiry, replay, concurrent consumption, post-change invalidation | UNKNOWN | NOT RUN | — | — | — |
| SEC-004 | Authentication and account recovery | A | Passwordless/activation takeover | no-password accounts cannot inherit old login/activation credentials after an email move | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-005 | Authentication and account recovery | A | OAuth/SSO linking | if present | U/I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-006 | Authentication and account recovery | A | MFA bypass / recovery downgrade | incomplete MFA and recovery states never obtain privileged sessions | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-007 | Authentication and account recovery | A | TOTP/recovery-code replay | consumed factors cannot authorize another operation | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-008 | Authentication and account recovery | A | Operator provisioning/bootstrap abuse | only the allowlisted operator; no second privileged identity via signup/bootstrap | I/B/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-009 | Sessions and sensitive action approval | A | Session fixation | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-010 | Sessions and sensitive action approval | A | Token forgery/validation confusion | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-011 | Sessions and sensitive action approval | A | Cookie theft/unsafe storage | see brief | B/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-012 | Sessions and sensitive action approval | A | Revocation fails open | unavailable revocation/authorization state never grants protected access | I/B: inject DB timeout, connection loss, malformed results | UNKNOWN | NOT RUN | — | — | — |
| SEC-013 | Sessions and sensitive action approval | A | Stale roles/allowlists | removal, de-listing, suspension invalidate authority promptly | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-014 | Sessions and sensitive action approval | A | Step-up substitution | approval binds actor, session, tenant, subject, action, values, version | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-015 | Sessions and sensitive action approval | A | Grant replay/duplicate mutation | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-016 | Sessions and sensitive action approval | A | Confused session precedence | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-017 | Authorization and tenant isolation | B | Object-level authorization (I/B). SEC-018 Function-level escalation | role-by-route matrix with positive controls | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-018 | Authorization and tenant isolation | B | Function-level escalation — role-by-route matrix with positive controls | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-019 | Authorization and tenant isolation | B | Property-level authorization/mass assignment | unknown, duplicate, nested keys | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-020 | Authorization and tenant isolation | B | Tenant selection confusion | host/URL/cookie/body/session disagreement fails closed | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-021 | Authorization and tenant isolation | B | RLS bypass / privileged runtime role | actual deployed role, grants, policies, tenant context | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-022 | Authorization and tenant isolation | B | Search/list/export disclosure | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-023 | Authorization and tenant isolation | B | Support impersonation escalation | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-024 | Authorization and tenant isolation | B | Background-job authority confusion | see brief | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-025 | Identity and transactional business rules | B | Cross-table email collision | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-026 | Identity and transactional business rules | B | Normalisation mismatch | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-027 | Identity and transactional business rules | B | Legacy duplicate ambiguity | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-028 | Identity and transactional business rules | B | TOCTOU/stale version writes (I). SEC-029 Writer bypass | upserts, nested writes, raw SQL, imports, jobs | Review/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-029 | Identity and transactional business rules | B | Writer bypass — upserts, nested writes, raw SQL, imports, jobs | see brief | Review/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-030 | Identity and transactional business rules | B | Partial multi-step completion | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-031 | Identity and transactional business rules | B | Lost response/retry corruption | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-032 | Identity and transactional business rules | B | Ownership/destructive-action races | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-033 | Input handling and server execution | C | SQL/ORM injection incl. raw SQL and dynamic identifiers | Untrusted values cannot change query structure or escape tenant scoping | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-034 | Input handling and server execution | C | Command/argument injection | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-035 | Input handling and server execution | C | Template/expression injection | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-036 | Input handling and server execution | C | Prototype pollution | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-037 | Input handling and server execution | C | Unsafe deserialization | see brief | Review/U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-038 | Input handling and server execution | C | Path traversal/unsafe file resolution | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-039 | Input handling and server execution | C | SSRF/cloud credential exposure | see brief | U/I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-040 | Input handling and server execution | C | XML entities/parser expansion | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-041 | Browser, HTTP and framework boundaries | C | Stored/reflected/DOM XSS | see brief | U/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-042 | Browser, HTTP and framework boundaries | C | CSRF/cross-origin state changes | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-043 | Browser, HTTP and framework boundaries | C | CORS | see brief | B/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-044 | Browser, HTTP and framework boundaries | C | Clickjacking | see brief | B/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-045 | Browser, HTTP and framework boundaries | C | Redirect/host-header abuse | see brief | U/I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-046 | Browser, HTTP and framework boundaries | C | Request smuggling/proxy disagreement | see brief | C/I, staging only | UNKNOWN | NOT RUN | — | — | — |
| SEC-047 | Browser, HTTP and framework boundaries | C | Cache poisoning/private cache leaks | see brief | I/B/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-048 | Browser, HTTP and framework boundaries | C | Middleware/Server Actions/RSC exposure incl. vendor advisories | Framework routing shortcuts cannot bypass endpoint authorization or leak server-only material | I/B/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-049 | Files, TeamUp imports and data integrity | D | Malicious upload types (U/I/B). SEC-050 Image/document parser vulnerabilities | exact native inventory | S/U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-050 | Files, TeamUp imports and data integrity | D | Image/document parser vulnerabilities — exact native inventory | see brief | S/U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-051 | Files, TeamUp imports and data integrity | D | Archive/decompression bombs | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-052 | Files, TeamUp imports and data integrity | D | CSV formula injection | see brief | U/I/manual | UNKNOWN | NOT RUN | — | — | — |
| SEC-053 | Files, TeamUp imports and data integrity | D | Import identity misbinding | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-054 | Files, TeamUp imports and data integrity | D | Import overwrites security state | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-055 | Files, TeamUp imports and data integrity | D | Concurrent/replayed imports | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-056 | Files, TeamUp imports and data integrity | D | Family/guardian access confusion | see brief | I/B | UNKNOWN | NOT RUN | — | — | — |
| SEC-057 | Dependencies, native runtime and build chain | E | Known dependency vulnerabilities | see brief | S/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-058 | Dependencies, native runtime and build chain | E | Transitive/optional/native blind spots | see brief | S/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-059 | Dependencies, native runtime and build chain | E | Typosquatting/dependency confusion | see brief | C | UNKNOWN | NOT RUN | — | — | — |
| SEC-060 | Dependencies, native runtime and build chain | E | Install-script/maintainer compromise | see brief | C | UNKNOWN | NOT RUN | — | — | — |
| SEC-061 | Dependencies, native runtime and build chain | E | CI workflow injection | see brief | C/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-062 | Dependencies, native runtime and build chain | E | Leaked source/build secrets | see brief | S/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-063 | Dependencies, native runtime and build chain | E | Untrusted artifact promotion (C). SEC-064 Memory-safety/runtime exploitation | Node, sharp/libvips, OS | S/C/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-064 | Dependencies, native runtime and build chain | E | Memory-safety/runtime exploitation — Node, sharp/libvips, OS | see brief | S/C/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-065 | Hosting, database and control-plane access | E | Cloud/repository account takeover | see brief | C/manual | UNKNOWN | NOT RUN | — | — | — |
| SEC-066 | Hosting, database and control-plane access | E | Stale deployments/aliases | see brief | C, read-only | UNKNOWN | NOT RUN | — | — | — |
| SEC-067 | Hosting, database and control-plane access | E | Exposed secrets/unsafe rotation | see brief | C/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-068 | Hosting, database and control-plane access | E | Overprivileged DB access | actual current_user/session_user, flags, memberships, grants, policies | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-069 | Hosting, database and control-plane access | E | DB/storage exposure | see brief | C/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-070 | Hosting, database and control-plane access | E | DNS/dangling-domain takeover | see brief | C, passive | UNKNOWN | NOT RUN | — | — | — |
| SEC-071 | Hosting, database and control-plane access | E | TLS/transport | see brief | C/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-072 | Hosting, database and control-plane access | E | Debug/management surface exposure | see brief | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-073 | Availability and financial resource abuse | F | Auth/crypto resource exhaustion | see brief | U/I/L | UNKNOWN | NOT RUN | — | — | — |
| SEC-074 | Availability and financial resource abuse | F | Regex/parser CPU exhaustion | see brief | U/Fuzz | UNKNOWN | NOT RUN | — | — | — |
| SEC-075 | Availability and financial resource abuse | F | Unbounded DB queries | see brief | I/L | UNKNOWN | NOT RUN | — | — | — |
| SEC-076 | Availability and financial resource abuse | F | Pool/lock exhaustion | see brief | I/L | UNKNOWN | NOT RUN | — | — | — |
| SEC-077 | Availability and financial resource abuse | F | Queue floods/retry storms | see brief | I/L | UNKNOWN | NOT RUN | — | — | — |
| SEC-078 | Availability and financial resource abuse | F | Serverless cost amplification | see brief | C/I/L | UNKNOWN | NOT RUN | — | — | — |
| SEC-079 | Availability and financial resource abuse | F | DoS through lockout (U/I). SEC-080 Provider/dependency outage | no permissive fallback | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-080 | Availability and financial resource abuse | F | Provider/dependency outage — no permissive fallback | see brief | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-081 | Audit, destruction prevention and recovery | F | Audit omission/rollback confusion | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-082 | Audit, destruction prevention and recovery | F | Log injection/secret disclosure | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-083 | Audit, destruction prevention and recovery | F | Audit tampering/blind spots | see brief | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-084 | Audit, destruction prevention and recovery | F | Malicious bulk deletion/corruption | see brief | I | UNKNOWN | NOT RUN | — | — | — |
| SEC-085 | Audit, destruction prevention and recovery | F | Backup compromise/ransomware | see brief | C/manual | UNKNOWN | NOT RUN | — | — | — |
| SEC-086 | Audit, destruction prevention and recovery | F | Unrestorable backup | see brief | R | UNKNOWN | NOT RUN | — | — | — |
| SEC-087 | Audit, destruction prevention and recovery | F | Rollback reintroduces vulnerabilities | see brief | R/I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-088 | Audit, destruction prevention and recovery | F | Test-harness false assurance | see brief | U/I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-089 | Integrations, human access and emerging surfaces | D | Forged/replayed webhooks | see brief | U/I | UNKNOWN | NOT RUN | — | — | — |
| SEC-090 | Integrations, human access and emerging surfaces | D | Payment/entitlement manipulation | see brief | I/B if enabled | UNKNOWN | NOT RUN | — | — | — |
| SEC-091 | Integrations, human access and emerging surfaces | D | Email delivery/notification abuse | see brief | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-092 | Integrations, human access and emerging surfaces | D | API key/service identity abuse | see brief | I/C | UNKNOWN | NOT RUN | — | — | — |
| SEC-093 | Integrations, human access and emerging surfaces | D | Prompt injection/unsafe AI tools | see brief | I if present | UNKNOWN | NOT RUN | — | — | — |
| SEC-094 | Integrations, human access and emerging surfaces | D | Developer endpoint compromise | see brief | C/manual | UNKNOWN | NOT RUN | — | — | — |
| SEC-095 | Integrations, human access and emerging surfaces | D | Social engineering/recovery fraud | see brief | manual/tabletop | UNKNOWN | NOT RUN | — | — | — |
| SEC-096 | Integrations, human access and emerging surfaces | D | Physical/provider/unknown residual risks | see brief | C/manual | UNKNOWN | NOT RUN | — | — | — |
