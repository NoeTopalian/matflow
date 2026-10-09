# Standards mapping for the coverage matrix (ASVS 5.0.0 / WSTG checklist / CWE)

Lane S, security campaign iteration 2, 9 Oct 2026. Branch `security/assurance-2026-10`. This document explains every
identifier written into the `Standard refs` column of [COVERAGE-MATRIX.md](COVERAGE-MATRIX.md). It maps catalogue risks to
standards; it is not a verification result and does not change any row's applicability or verification status. A row
citing a requirement does not mean that requirement was tested or passes.

## 1. Sources

Every ASVS and WSTG identifier below was looked up in the staged local files listed here (staged by the lead under the
campaign scratchpad, `security/standards/`; nothing else was fetched). CWE has no local copy (see the CWE row).

| Source file | Standard | Version / date | Items | SHA-256 | Used for |
|---|---|---|---|---|---|
| asvs-5.0.0-en.flat.json | OWASP ASVS | 5.0.0, tag v5.0.0_release, 2025-05-30 | 345 requirements, 17 chapters, 80 sections | `8201b20eec2908c3380ac600c91c8ba746346fbb808859366abb232027532311` | Existence of every ASVS id (field `req_id`) and the quoted text (field `req_description`) |
| OWASP_Application_Security_Verification_Standard_5.0.0_en.cdx.json | OWASP ASVS (CycloneDX 1.6 export) | standard version 5.0.0, metadata timestamp 2025-05-30T05:13:11Z | — | `e845f3cba63a6fcfdb110b4e4cd8d7a8fb7a1abbed77387197381d2a0d892cf9` | Confirms the version and release date of the flat JSON |
| asvs-5.0.0-index.md | readable index generated from the flat JSON | 5.0.0 | 345 lines of requirements | `5e7fc03c619271f3c5a78759324f30dac30643c52de549b3c7bdfddd086a6067` | Browsing only |
| wstg-20230928-checklist.md | OWASP WSTG testing checklist | v4.2 checklist as of 2023-09-28 | 99 test ids in 12 categories | `9c7a78609a3337c5e4f7a36345798432f9093602bf87552d6f649dc5f3ca6031` | Existence and title of every WSTG id |
| wstg-toc-master.md | OWASP WSTG table of contents | master, 4.0–4.13 | 14 chapters | `64ef8a535ad4140d99c0f17f2056e207cf0043c373c8bec638a5061e6f61bcb3` | Section names only (no ids taken from it) |
| (none) | MITRE CWE | CWE list 4.x, from knowledge, not a local copy | — | — | CWE ids named with their full weakness name in §7; an id was left out wherever the lane was not certain of it. CWE-1333, CWE-1336, CWE-1395 and CWE-1427 are later 4.x additions: check them against the current CWE list before citing externally |

Note on the brief: it describes the ASVS items as having `Shortcode` and `Description` fields. The staged flat JSON calls
them `req_id` and `req_description`; the values are the same shortcodes (e.g. `V6.3.1`). The WSTG checklist file's
Business Logic heading reads `WSTG-BUSLOGIC` but its test ids are `WSTG-BUSL-NN`; the ids are used as printed.

## 2. Method and fit grades

For each of the 96 rows the Area, Risk and Required invariant were read, and 1–3 requirement-level ASVS shortcodes, 0–2
WSTG ids and 0–2 CWE ids chosen. Chapter- or section-level ASVS ids are never used. Cell grammar:
`ASVS V6.3.1, V6.3.4; WSTG-ATHN-03; CWE-307`, or `ASVS — (no requirement; see mapping §5)` where no ASVS requirement fits.
Each row carries a fit grade:

- **direct**: the requirement text names this risk or control.
- **partial**: the requirements cover part of the invariant; the note says which part is not covered by any ASVS text.
- **none**: no ASVS 5.0.0 requirement fits without stretching; explained in §5. WSTG/CWE may still be given.

Totals: 61 direct, 21 partial, 14 none (no ASVS requirement).

## 3. Per-row mapping

`Refs` is the exact text of the matrix cell (the check script in §8 asserts they are identical). ASVS text is quoted from
`req_description`, truncated to about 80 characters.

| SEC | Refs (as in matrix) | Fit | ASVS requirement text | WSTG titles | Note |
|---|---|---|---|---|---|
| SEC-001 | `ASVS V6.3.1, V6.3.4, V15.3.4; WSTG-ATHN-03, WSTG-ATHN-10; CWE-307` | direct | V6.3.1 [L1] "Verify that controls to prevent attacks such as credential stuffing and password…"<br>V6.3.4 [L2] "Verify that, if the application includes multiple authentication pathways, there…"<br>V15.3.4 [L2] "Verify that all proxying and middleware components transfer the user's original…" | WSTG-ATHN-03 Testing for Weak Lock Out Mechanism<br>WSTG-ATHN-10 Testing for Weaker Authentication in Alternative Channel | V15.3.4 covers the x-forwarded-for residual (client IP used for rate limiting). |
| SEC-002 | `ASVS V6.3.8; WSTG-IDNT-04; CWE-204` | direct | V6.3.8 [L3] "Verify that valid users cannot be deduced from failed authentication challenges,…" | WSTG-IDNT-04 Testing for Account Enumeration and Guessable User Account |  |
| SEC-003 | `ASVS V6.4.3, V11.5.1; WSTG-ATHN-09; CWE-640` | partial | V6.4.3 [L2] "Verify that a secure process for resetting a forgotten password is implemented,…"<br>V11.5.1 [L2] "Verify that all random numbers and strings which are intended to be non-guessabl…" | WSTG-ATHN-09 Testing for Weak Password Change or Reset Functionalities | ASVS 5.0.0 has no requirement that names reset-token lifetime or single use; V6.4.3 (secure reset process) and V11.5.1 (CSPRNG for non-guessable values) cover the unpredictability half only. |
| SEC-004 | `ASVS V6.4.1, V7.5.1; WSTG-IDNT-03, WSTG-ATHN-09` | partial | V6.4.1 [L1] "Verify that system generated initial passwords or activation codes are securely…"<br>V7.5.1 [L2] "Verify that the application requires full re-authentication before allowing modi…" | WSTG-IDNT-03 Test Account Provisioning Process<br>WSTG-ATHN-09 Testing for Weak Password Change or Reset Functionalities | V6.4.1 covers activation codes expiring/single use; V7.5.1 covers re-authentication before an email change. Neither names invalidation of outstanding links on an email move. No CWE chosen with confidence. |
| SEC-005 | `ASVS V6.8.1, V10.5.2, V10.2.1` | direct | V6.8.1 [L2] "Verify that, if the application supports multiple identity providers (IdPs), the…"<br>V10.5.2 [L2] "Verify that the client uniquely identifies the user from ID Token claims, usuall…"<br>V10.2.1 [L2] "Verify that, if the code flow is used, the OAuth client has protection against b…" | — | The WSTG 2023-09-28 checklist has no OAuth/OIDC test id, so no WSTG ref. |
| SEC-006 | `ASVS V6.4.3, V6.4.4, V6.3.3; WSTG-ATHN-04; CWE-288` | direct | V6.4.3 [L2] "Verify that a secure process for resetting a forgotten password is implemented,…"<br>V6.4.4 [L2] "Verify that if a multi-factor authentication factor is lost, evidence of identit…"<br>V6.3.3 [L2] "Verify that either a multi-factor authentication mechanism or a combination of s…" | WSTG-ATHN-04 Testing for Bypassing Authentication Schema |  |
| SEC-007 | `ASVS V6.5.1; WSTG-BUSL-05; CWE-294` | direct | V6.5.1 [L2] "Verify that lookup secrets, out-of-band authentication requests or codes, and ti…" | WSTG-BUSL-05 Test Number of Times a Function Can Be Used Limits |  |
| SEC-008 | `ASVS V8.2.1, V8.4.2, V6.3.2; WSTG-IDNT-02, WSTG-IDNT-03; CWE-269` | partial | V8.2.1 [L1] "Verify that the application ensures that function-level access is restricted to…"<br>V8.4.2 [L3] "Verify that access to administrative interfaces incorporates multiple layers of…"<br>V6.3.2 [L1] "Verify that default user accounts (e.g., "root", "admin", or "sa") are not prese…" | WSTG-IDNT-02 Test User Registration Process<br>WSTG-IDNT-03 Test Account Provisioning Process | No ASVS requirement names an operator allowlist or bootstrap path; V8.2.1/V8.4.2 cover privileged-function restriction and V6.3.2 covers default privileged accounts. |
| SEC-009 | `ASVS V7.2.4; WSTG-SESS-03; CWE-384` | direct | V7.2.4 [L1] "Verify that the application generates a new session token on user authentication…" | WSTG-SESS-03 Testing for Session Fixation |  |
| SEC-010 | `ASVS V9.1.1, V9.2.2, V7.2.1; WSTG-SESS-10; CWE-347` | direct | V9.1.1 [L1] "Verify that self-contained tokens are validated using their digital signature or…"<br>V9.2.2 [L2] "Verify that the service receiving a token validates the token to be the correct…"<br>V7.2.1 [L1] "Verify that the application performs all session token verification using a trus…" | WSTG-SESS-10 Testing JSON Web Tokens |  |
| SEC-011 | `ASVS V3.3.1, V3.3.4, V14.3.3; WSTG-SESS-02, WSTG-CLNT-12; CWE-1004, CWE-614` | direct | V3.3.1 [L1] "Verify that cookies have the 'Secure' attribute set, and if the '\__Host-' prefi…"<br>V3.3.4 [L2] "Verify that if the value of a cookie is not meant to be accessible to client-sid…"<br>V14.3.3 [L2] "Verify that data stored in browser storage (such as localStorage, sessionStorage…" | WSTG-SESS-02 Testing for Cookies Attributes<br>WSTG-CLNT-12 Test Browser Storage |  |
| SEC-012 | `ASVS V7.4.1, V16.5.3; WSTG-SESS-06; CWE-636` | direct | V7.4.1 [L1] "Verify that when session termination is triggered (such as logout or expiration)…"<br>V16.5.3 [L2] "Verify that the application fails gracefully and securely, including when an exc…" | WSTG-SESS-06 Testing for Logout Functionality |  |
| SEC-013 | `ASVS V8.3.2, V7.4.2; WSTG-ATHZ-02; CWE-613` | direct | V8.3.2 [L3] "Verify that changes to values on which authorization decisions are made are appl…"<br>V7.4.2 [L1] "Verify that the application terminates all active sessions when a user account i…" | WSTG-ATHZ-02 Testing for Bypassing Authorization Schema |  |
| SEC-014 | `ASVS V7.5.3, V7.5.1; WSTG-BUSL-06; CWE-863` | partial | V7.5.3 [L3] "Verify that the application requires further authentication with at least one fa…"<br>V7.5.1 [L2] "Verify that the application requires full re-authentication before allowing modi…" | WSTG-BUSL-06 Testing for the Circumvention of Work Flows | V7.5.3 requires step-up before sensitive operations; no ASVS requirement names binding the approval to actor, tenant, subject, values and version (the substitution invariant). |
| SEC-015 | `ASVS V15.4.2, V2.3.4; WSTG-BUSL-05; CWE-362` | partial | V15.4.2 [L3] "Verify that checks on a resource's state, such as its existence or permissions,…"<br>V2.3.4 [L2] "Verify that business logic level locking mechanisms are used to ensure that limi…" | WSTG-BUSL-05 Test Number of Times a Function Can Be Used Limits | A single-use grant treated as a limited-quantity resource (V2.3.4) spent atomically (V15.4.2); ASVS has no grant-replay requirement as such. |
| SEC-016 | `ASVS V8.2.1, V3.5.4; WSTG-SESS-08` | partial | V8.2.1 [L1] "Verify that the application ensures that function-level access is restricted to…"<br>V3.5.4 [L2] "Verify that separate applications are hosted on different hostnames to leverage…" | WSTG-SESS-08 Testing for Session Puzzling | Owner session plus operator cookie in one browser. V3.5.4 (separate applications on separate hostnames, incl. cookie scoping) is the structural control; V8.2.1 the function-level check. No CWE chosen with confidence. |
| SEC-017 | `ASVS V8.2.2, V8.4.1; WSTG-ATHZ-04; CWE-639` | direct | V8.2.2 [L1] "Verify that the application ensures that data-specific access is restricted to c…"<br>V8.4.1 [L2] "Verify that multi-tenant applications use cross-tenant controls to ensure consum…" | WSTG-ATHZ-04 Testing for Insecure Direct Object References |  |
| SEC-018 | `ASVS V8.2.1, V8.3.1; WSTG-ATHZ-02, WSTG-ATHZ-03; CWE-285` | direct | V8.2.1 [L1] "Verify that the application ensures that function-level access is restricted to…"<br>V8.3.1 [L1] "Verify that the application enforces authorization rules at a trusted service la…" | WSTG-ATHZ-02 Testing for Bypassing Authorization Schema<br>WSTG-ATHZ-03 Testing for Privilege Escalation |  |
| SEC-019 | `ASVS V15.3.3, V8.2.3, V15.3.7; WSTG-INPV-04; CWE-915` | direct | V15.3.3 [L2] "Verify that the application has countermeasures to protect against mass assignme…"<br>V8.2.3 [L2] "Verify that the application ensures that field-level access is restricted to con…"<br>V15.3.7 [L2] "Verify that the application has defenses against HTTP parameter pollution attack…" | WSTG-INPV-04 Testing for HTTP Parameter pollution | The checklist has no mass-assignment id; WSTG-INPV-04 (parameter pollution) covers the duplicate-key half. |
| SEC-020 | `ASVS V8.4.1, V8.3.1; WSTG-ATHZ-02, WSTG-INPV-17` | partial | V8.4.1 [L2] "Verify that multi-tenant applications use cross-tenant controls to ensure consum…"<br>V8.3.1 [L1] "Verify that the application enforces authorization rules at a trusted service la…" | WSTG-ATHZ-02 Testing for Bypassing Authorization Schema<br>WSTG-INPV-17 Testing for Host Header Injection | V8.4.1 is the cross-tenant control; no ASVS requirement names host/URL/cookie/body disagreement over tenant selection. |
| SEC-021 | `ASVS V8.4.1, V13.2.2; CWE-250` | direct | V8.4.1 [L2] "Verify that multi-tenant applications use cross-tenant controls to ensure consum…"<br>V13.2.2 [L2] "Verify that communications between backend application components, including loc…" | — | Database-role inspection has no WSTG checklist id. |
| SEC-022 | `ASVS V8.2.2, V15.3.1, V14.2.6; WSTG-ATHZ-02; CWE-200` | direct | V8.2.2 [L1] "Verify that the application ensures that data-specific access is restricted to c…"<br>V15.3.1 [L1] "Verify that the application only returns the required subset of fields from a da…"<br>V14.2.6 [L3] "Verify that the application only returns the minimum required sensitive data for…" | WSTG-ATHZ-02 Testing for Bypassing Authorization Schema |  |
| SEC-023 | `ASVS V8.4.2, V8.2.1; WSTG-ATHZ-03; CWE-269` | partial | V8.4.2 [L3] "Verify that access to administrative interfaces incorporates multiple layers of…"<br>V8.2.1 [L1] "Verify that the application ensures that function-level access is restricted to…" | WSTG-ATHZ-03 Testing for Privilege Escalation | No ASVS requirement names support impersonation; V8.4.2 covers layered controls on administrative interfaces. |
| SEC-024 | `ASVS V8.3.3, V13.2.1; CWE-441` | direct | V8.3.3 [L3] "Verify that access to an object is based on the originating subject's (e.g. cons…"<br>V13.2.1 [L2] "Verify that communications between backend application components that don't sup…" | — | No WSTG checklist id covers background-job authority. |
| SEC-025 | `ASVS — (no requirement; see mapping §5); WSTG-IDNT-02` | none | — | WSTG-IDNT-02 Test User Registration Process | Identity uniqueness across the staff and member tables. ASVS 5.0.0 has no requirement on identifier uniqueness within one application (V6.8.1 is about multiple identity providers and was not stretched). WSTG-IDNT-02 is a partial fit (registration allowing a second identity for one email). |
| SEC-026 | `ASVS V1.1.1; CWE-178` | partial | V1.1.1 [L2] "Verify that input is decoded or unescaped into a canonical form only once, it is…" | — | V1.1.1 requires canonicalisation once and before validation; email case/whitespace normalisation is a canonical-form concern but the requirement is written about decoding. |
| SEC-027 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Legacy duplicate identities in existing data. No ASVS 5.0.0 requirement covers pre-existing duplicate identifiers; no WSTG checklist id; no CWE chosen with confidence. |
| SEC-028 | `ASVS V15.4.2; CWE-367` | direct | V15.4.2 [L3] "Verify that checks on a resource's state, such as its existence or permissions,…" | — |  |
| SEC-029 | `ASVS V2.2.2; WSTG-BUSL-01` | partial | V2.2.2 [L1] "Verify that the application is designed to enforce input validation at a trusted…" | WSTG-BUSL-01 Test Business Logic Data Validation | Every write path (upserts, nested writes, raw SQL, imports, jobs) must pass the same server-side guard; V2.2.2 (enforce at a trusted service layer) is the nearest requirement. |
| SEC-030 | `ASVS V2.3.3, V2.3.1; WSTG-BUSL-06` | direct | V2.3.3 [L2] "Verify that transactions are being used at the business logic level such that ei…"<br>V2.3.1 [L1] "Verify that the application will only process business logic flows for the same…" | WSTG-BUSL-06 Testing for the Circumvention of Work Flows |  |
| SEC-031 | `ASVS V2.3.3; WSTG-BUSL-05` | partial | V2.3.3 [L2] "Verify that transactions are being used at the business logic level such that ei…" | WSTG-BUSL-05 Test Number of Times a Function Can Be Used Limits | Idempotency under retry after a lost response is not named in ASVS 5.0.0; V2.3.3 (all-or-nothing transactions) covers the corruption half. |
| SEC-032 | `ASVS V15.4.2, V2.3.3; CWE-362` | direct | V15.4.2 [L3] "Verify that checks on a resource's state, such as its existence or permissions,…"<br>V2.3.3 [L2] "Verify that transactions are being used at the business logic level such that ei…" | — |  |
| SEC-033 | `ASVS V1.2.4; WSTG-INPV-05; CWE-89` | direct | V1.2.4 [L1] "Verify that data selection or database queries (e.g., SQL, HQL, NoSQL, Cypher) u…" | WSTG-INPV-05 Testing for SQL Injection |  |
| SEC-034 | `ASVS V1.2.5; WSTG-INPV-12; CWE-78, CWE-88` | direct | V1.2.5 [L1] "Verify that the application protects against OS command injection and that opera…" | WSTG-INPV-12 Testing for Command Injection |  |
| SEC-035 | `ASVS V1.3.7, V1.3.2; WSTG-INPV-18, WSTG-INPV-11; CWE-1336, CWE-94` | direct | V1.3.7 [L2] "Verify that the application protects against template injection attacks by not a…"<br>V1.3.2 [L1] "Verify that the application avoids the use of eval() or other dynamic code execu…" | WSTG-INPV-18 Testing for Server-Side Template Injection<br>WSTG-INPV-11 Testing for Code Injection |  |
| SEC-036 | `ASVS V15.3.6; CWE-1321` | direct | V15.3.6 [L2] "Verify that JavaScript code is written in a way that prevents prototype pollutio…" | — | No prototype-pollution id in the 2023-09-28 WSTG checklist. |
| SEC-037 | `ASVS V1.5.2; CWE-502` | direct | V1.5.2 [L2] "Verify that deserialization of untrusted data enforces safe input handling, such…" | — | No deserialisation id in the 2023-09-28 WSTG checklist. |
| SEC-038 | `ASVS V5.3.2; WSTG-ATHZ-01; CWE-22` | direct | V5.3.2 [L1] "Verify that when the application creates file paths for file operations, instead…" | WSTG-ATHZ-01 Testing Directory Traversal File Include |  |
| SEC-039 | `ASVS V1.3.6, V15.3.2, V13.2.5; WSTG-INPV-19; CWE-918` | direct | V1.3.6 [L2] "Verify that the application protects against Server-side Request Forgery (SSRF)…"<br>V15.3.2 [L2] "Verify that where the application backend makes calls to external URLs, it is co…"<br>V13.2.5 [L2] "Verify that the web or application server is configured with an allowlist of res…" | WSTG-INPV-19 Testing for Server-Side Request Forgery |  |
| SEC-040 | `ASVS V1.5.1; WSTG-INPV-07; CWE-611, CWE-776` | direct | V1.5.1 [L1] "Verify that the application configures XML parsers to use a restrictive configur…" | WSTG-INPV-07 Testing for XML Injection |  |
| SEC-041 | `ASVS V1.2.1, V3.2.2, V3.4.3; WSTG-INPV-02, WSTG-CLNT-01; CWE-79` | direct | V1.2.1 [L1] "Verify that output encoding for an HTTP response, HTML document, or XML document…"<br>V3.2.2 [L1] "Verify that content intended to be displayed as text, rather than rendered as HT…"<br>V3.4.3 [L2] "Verify that HTTP responses include a Content-Security-Policy response header fie…" | WSTG-INPV-02 Testing for Stored Cross Site Scripting<br>WSTG-CLNT-01 Testing for DOM Based Cross Site Scripting |  |
| SEC-042 | `ASVS V3.5.1, V3.5.3, V3.3.2; WSTG-SESS-05; CWE-352` | direct | V3.5.1 [L1] "Verify that, if the application does not rely on the CORS preflight mechanism to…"<br>V3.5.3 [L1] "Verify that HTTP requests to sensitive functionality use appropriate HTTP method…"<br>V3.3.2 [L2] "Verify that each cookie's 'SameSite' attribute value is set according to the pur…" | WSTG-SESS-05 Testing for Cross Site Request Forgery |  |
| SEC-043 | `ASVS V3.4.2; WSTG-CLNT-07; CWE-942` | direct | V3.4.2 [L1] "Verify that the Cross-Origin Resource Sharing (CORS) Access-Control-Allow-Origin…" | WSTG-CLNT-07 Test Cross Origin Resource Sharing |  |
| SEC-044 | `ASVS V3.4.6; WSTG-CLNT-09; CWE-1021` | direct | V3.4.6 [L2] "Verify that the web application uses the frame-ancestors directive of the Conten…" | WSTG-CLNT-09 Testing for Clickjacking |  |
| SEC-045 | `ASVS V3.7.2, V4.1.3; WSTG-CLNT-04, WSTG-INPV-17; CWE-601` | partial | V3.7.2 [L2] "Verify that the application will only automatically redirect the user to a diffe…"<br>V4.1.3 [L2] "Verify that any HTTP header field used by the application and set by an intermed…" | WSTG-CLNT-04 Testing for Client-Side URL Redirect<br>WSTG-INPV-17 Testing for Host Header Injection | Open redirect is direct (V3.7.2); ASVS 5.0.0 has no Host-header requirement, V4.1.3 (intermediary headers such as X-Forwarded-* not user-overridable) covers forwarded-host only. |
| SEC-046 | `ASVS V4.2.1, V4.1.3, V15.3.4; WSTG-INPV-15; CWE-444` | direct | V4.2.1 [L2] "Verify that all application components (including load balancers, firewalls, and…"<br>V4.1.3 [L2] "Verify that any HTTP header field used by the application and set by an intermed…"<br>V15.3.4 [L2] "Verify that all proxying and middleware components transfer the user's original…" | WSTG-INPV-15 Testing for HTTP Splitting Smuggling |  |
| SEC-047 | `ASVS V14.2.2, V14.2.5, V14.3.2; WSTG-ATHN-06; CWE-524, CWE-525` | direct | V14.2.2 [L2] "Verify that the application prevents sensitive data from being cached in server…"<br>V14.2.5 [L3] "Verify that caching mechanisms are configured to only cache responses which have…"<br>V14.3.2 [L2] "Verify that the application sets sufficient anti-caching HTTP response header fi…" | WSTG-ATHN-06 Testing for Browser Cache Weakness |  |
| SEC-048 | `ASVS V8.3.1, V15.2.1; WSTG-ATHN-04, WSTG-ATHZ-02` | partial | V8.3.1 [L1] "Verify that the application enforces authorization rules at a trusted service la…"<br>V15.2.1 [L1] "Verify that the application only contains components which have not breached the…" | WSTG-ATHN-04 Testing for Bypassing Authentication Schema<br>WSTG-ATHZ-02 Testing for Bypassing Authorization Schema | Framework-specific routing (middleware, Server Actions, RSC) is not named in ASVS; V8.3.1 covers enforcement at a trusted layer and V15.2.1 the vendor-advisory half. No CWE chosen with confidence. |
| SEC-049 | `ASVS V5.2.2, V5.1.1; WSTG-BUSL-08, WSTG-BUSL-09; CWE-434` | direct | V5.2.2 [L1] "Verify that when the application accepts a file, either on its own or within an…"<br>V5.1.1 [L2] "Verify that the documentation defines the permitted file types, expected file ex…" | WSTG-BUSL-08 Test Upload of Unexpected File Types<br>WSTG-BUSL-09 Test Upload of Malicious Files |  |
| SEC-050 | `ASVS V5.2.6, V15.2.1, V15.1.2; WSTG-BUSL-09` | direct | V5.2.6 [L3] "Verify that the application rejects uploaded images with a pixel size larger tha…"<br>V15.2.1 [L1] "Verify that the application only contains components which have not breached the…"<br>V15.1.2 [L2] "Verify that an inventory catalog, such as software bill of materials (SBOM), is…" | WSTG-BUSL-09 Test Upload of Malicious Files |  |
| SEC-051 | `ASVS V5.2.3, V5.2.6, V5.2.1; WSTG-BUSL-09; CWE-409` | direct | V5.2.3 [L2] "Verify that the application checks compressed files (e.g., zip, gz, docx, odt) a…"<br>V5.2.6 [L3] "Verify that the application rejects uploaded images with a pixel size larger tha…"<br>V5.2.1 [L1] "Verify that the application will only accept files of a size which it can proces…" | WSTG-BUSL-09 Test Upload of Malicious Files |  |
| SEC-052 | `ASVS V1.2.10; CWE-1236` | direct | V1.2.10 [L3] "Verify that the application is protected against CSV and Formula Injection. The…" | — | No CSV/formula-injection id in the 2023-09-28 WSTG checklist. |
| SEC-053 | `ASVS V2.2.3; WSTG-BUSL-01` | partial | V2.2.3 [L2] "Verify that the application ensures that combinations of related data items are…" | WSTG-BUSL-01 Test Business Logic Data Validation | Imported rows bound to the wrong person. V2.2.3 (combinations of related data items are reasonable) is the nearest requirement; no ASVS requirement names import identity binding. |
| SEC-054 | `ASVS V15.3.3, V8.2.3; WSTG-BUSL-01; CWE-915` | direct | V15.3.3 [L2] "Verify that the application has countermeasures to protect against mass assignme…"<br>V8.2.3 [L2] "Verify that the application ensures that field-level access is restricted to con…" | WSTG-BUSL-01 Test Business Logic Data Validation |  |
| SEC-055 | `ASVS V15.4.2, V2.3.3; WSTG-BUSL-05; CWE-362` | direct | V15.4.2 [L3] "Verify that checks on a resource's state, such as its existence or permissions,…"<br>V2.3.3 [L2] "Verify that transactions are being used at the business logic level such that ei…" | WSTG-BUSL-05 Test Number of Times a Function Can Be Used Limits |  |
| SEC-056 | `ASVS V8.2.2; WSTG-ATHZ-04; CWE-639` | direct | V8.2.2 [L1] "Verify that the application ensures that data-specific access is restricted to c…" | WSTG-ATHZ-04 Testing for Insecure Direct Object References |  |
| SEC-057 | `ASVS V15.2.1, V15.1.1; CWE-1395` | direct | V15.2.1 [L1] "Verify that the application only contains components which have not breached the…"<br>V15.1.1 [L1] "Verify that application documentation defines risk based remediation time frames…" | — |  |
| SEC-058 | `ASVS V15.1.2, V15.2.4; CWE-494` | direct | V15.1.2 [L2] "Verify that an inventory catalog, such as software bill of materials (SBOM), is…"<br>V15.2.4 [L3] "Verify that third-party components and all of their transitive dependencies are…" | — |  |
| SEC-059 | `ASVS V15.2.4` | direct | V15.2.4 [L3] "Verify that third-party components and all of their transitive dependencies are…" | — | V15.2.4 names dependency confusion explicitly. |
| SEC-060 | `ASVS V15.2.4; CWE-506, CWE-494` | partial | V15.2.4 [L3] "Verify that third-party components and all of their transitive dependencies are…" | — | ASVS 5.0.0 has no requirement on install scripts or maintainer compromise; V15.2.4 (components from the expected repository) is the nearest. |
| SEC-061 | `ASVS — (no requirement; see mapping §5); CWE-77` | none | — | — | CI workflow injection (GitHub Actions expressions). ASVS 5.0.0 verifies the application, not its CI system; no requirement covers workflow definitions. |
| SEC-062 | `ASVS V13.3.1, V13.4.1; WSTG-INFO-05; CWE-798, CWE-540` | direct | V13.3.1 [L2] "Verify that a secrets management solution, such as a key vault, is used to secur…"<br>V13.4.1 [L1] "Verify that the application is deployed either without any source control metada…" | WSTG-INFO-05 Review Webpage Content for Information Leakage | V13.3.1 states secrets must not be in source code or build artifacts. |
| SEC-063 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Promotion of a build artifact that CI did not produce. ASVS 5.0.0 has no build-provenance requirement (V15.2.4 is about third-party components and was not stretched); no WSTG id; no CWE chosen with confidence. |
| SEC-064 | `ASVS V15.2.1, V15.1.4; CWE-1104` | direct | V15.2.1 [L1] "Verify that the application only contains components which have not breached the…"<br>V15.1.4 [L3] "Verify that application documentation highlights third-party libraries which are…" | — |  |
| SEC-065 | `ASVS — (no requirement; see mapping §5); CWE-308` | none | — | — | Takeover of hosting/repository accounts (Vercel, GitHub, Neon). ASVS 5.0.0 MFA requirements (V6.3.3) apply to users of the application, not to the operator accounts of its providers. |
| SEC-066 | `ASVS — (no requirement; see mapping §5); WSTG-INFO-04` | none | — | WSTG-INFO-04 Enumerate Applications on Webserver | Stale preview/production deployments and aliases on the host. No ASVS 5.0.0 requirement covers retired deployments; WSTG-INFO-04 (enumerate applications on the web server) is a partial fit. |
| SEC-067 | `ASVS V13.3.4, V13.1.4, V13.3.1; CWE-522` | direct | V13.3.4 [L3] "Verify that secrets are configured to expire and be rotated based on the applica…"<br>V13.1.4 [L3] "Verify that the application's documentation defines the secrets that are critica…"<br>V13.3.1 [L2] "Verify that a secrets management solution, such as a key vault, is used to secur…" | — |  |
| SEC-068 | `ASVS V13.2.2; CWE-250` | direct | V13.2.2 [L2] "Verify that communications between backend application components, including loc…" | — |  |
| SEC-069 | `ASVS V8.2.2; WSTG-CONF-11; CWE-552` | partial | V8.2.2 [L1] "Verify that the application ensures that data-specific access is restricted to c…" | WSTG-CONF-11 Test Cloud Storage | Public blob storage is WSTG-CONF-11 directly; ASVS 5.0.0 has no cloud-storage requirement, V8.2.2 covers data-specific access. The Neon network allow-list half has no ASVS requirement. |
| SEC-070 | `ASVS — (no requirement; see mapping §5); WSTG-CONF-10` | none | — | WSTG-CONF-10 Test for Subdomain Takeover | Dangling DNS and email-domain authentication (SPF/DMARC). ASVS 5.0.0 has no DNS or mail-domain requirement; WSTG-CONF-10 covers subdomain takeover only. |
| SEC-071 | `ASVS V12.2.1, V12.1.1, V3.4.1; WSTG-CRYP-01, WSTG-CONF-07; CWE-319` | direct | V12.2.1 [L1] "Verify that TLS is used for all connectivity between a client and external facin…"<br>V12.1.1 [L1] "Verify that only the latest recommended versions of the TLS protocol are enabled…"<br>V3.4.1 [L1] "Verify that a Strict-Transport-Security header field is included on all response…" | WSTG-CRYP-01 Testing for Weak Transport Layer Security<br>WSTG-CONF-07 Test HTTP Strict Transport Security |  |
| SEC-072 | `ASVS V13.4.2, V13.4.5, V13.2.1; WSTG-CONF-05; CWE-489, CWE-306` | direct | V13.4.2 [L2] "Verify that debug modes are disabled for all components in production environmen…"<br>V13.4.5 [L2] "Verify that documentation (such as for internal APIs) and monitoring endpoints a…"<br>V13.2.1 [L2] "Verify that communications between backend application components that don't sup…" | WSTG-CONF-05 Enumerate Infrastructure and Application Admin Interfaces | V13.2.1 and CWE-306 cover the unset CRON_SECRET (cron endpoint authentication). |
| SEC-073 | `ASVS V15.2.2, V2.4.1; CWE-770` | direct | V15.2.2 [L2] "Verify that the application has implemented defenses against loss of availabilit…"<br>V2.4.1 [L2] "Verify that anti-automation controls are in place to protect against excessive c…" | — |  |
| SEC-074 | `ASVS V1.3.12, V15.2.2; CWE-1333` | direct | V1.3.12 [L3] "Verify that regular expressions are free from elements causing exponential backt…"<br>V15.2.2 [L2] "Verify that the application has implemented defenses against loss of availabilit…" | — |  |
| SEC-075 | `ASVS V15.2.2, V15.1.3; CWE-770` | direct | V15.2.2 [L2] "Verify that the application has implemented defenses against loss of availabilit…"<br>V15.1.3 [L2] "Verify that the application documentation identifies functionality which is time…" | — |  |
| SEC-076 | `ASVS V13.1.2, V15.4.4, V15.4.3; CWE-400` | direct | V13.1.2 [L3] "Verify that for each service the application uses, the documentation defines the…"<br>V15.4.4 [L3] "Verify that resource allocation policies prevent thread starvation by ensuring f…"<br>V15.4.3 [L3] "Verify that locks are used consistently to avoid threads getting stuck, whether…" | — |  |
| SEC-077 | `ASVS V15.2.2, V16.5.2; CWE-400` | direct | V15.2.2 [L2] "Verify that the application has implemented defenses against loss of availabilit…"<br>V16.5.2 [L2] "Verify that the application continues to operate securely when external resource…" | — |  |
| SEC-078 | `ASVS V2.4.1, V15.2.2; WSTG-BUSL-07; CWE-770` | direct | V2.4.1 [L2] "Verify that anti-automation controls are in place to protect against excessive c…"<br>V15.2.2 [L2] "Verify that the application has implemented defenses against loss of availabilit…" | WSTG-BUSL-07 Test Defenses Against Application Misuse | V2.4.1 names overuse of costly resources. |
| SEC-079 | `ASVS V6.1.1, V6.3.1; WSTG-ATHN-03; CWE-645` | direct | V6.1.1 [L1] "Verify that application documentation defines how controls such as rate limiting…"<br>V6.3.1 [L1] "Verify that controls to prevent attacks such as credential stuffing and password…" | WSTG-ATHN-03 Testing for Weak Lock Out Mechanism | V6.1.1 names prevention of malicious account lockout. |
| SEC-080 | `ASVS V16.5.2, V16.5.3; CWE-636` | direct | V16.5.2 [L2] "Verify that the application continues to operate securely when external resource…"<br>V16.5.3 [L2] "Verify that the application fails gracefully and securely, including when an exc…" | — |  |
| SEC-081 | `ASVS V16.3.3, V16.1.1; CWE-778` | partial | V16.3.3 [L2] "Verify that the application logs the security events that are defined in the doc…"<br>V16.1.1 [L2] "Verify that an inventory exists documenting the logging performed at each layer…" | — | ASVS requires the defined events to be logged; it does not name audit loss when the business transaction rolls back. |
| SEC-082 | `ASVS V16.4.1, V16.2.5; CWE-117, CWE-532` | direct | V16.4.1 [L2] "Verify that all logging components appropriately encode data to prevent log inje…"<br>V16.2.5 [L2] "Verify that when logging sensitive data, the application enforces logging based…" | — |  |
| SEC-083 | `ASVS V16.4.2, V16.4.3; CWE-778` | direct | V16.4.2 [L2] "Verify that logs are protected from unauthorized access and cannot be modified."<br>V16.4.3 [L2] "Verify that logs are securely transmitted to a logically separate system for ana…" | — |  |
| SEC-084 | `ASVS V7.5.3, V2.3.5` | partial | V7.5.3 [L3] "Verify that the application requires further authentication with at least one fa…"<br>V2.3.5 [L3] "Verify that high-value business logic flows require multi-user approval to preve…" | — | Step-up (V7.5.3) and multi-user approval (V2.3.5) for destructive bulk operations; recovery after malicious deletion has no ASVS requirement. No CWE chosen with confidence. |
| SEC-085 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Backup confidentiality and ransomware resistance. ASVS 5.0.0 contains no backup requirement (searched all 345 descriptions for backup/restore: no hit). |
| SEC-086 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Restore drills. ASVS 5.0.0 contains no backup or restore requirement (same search). |
| SEC-087 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Rollback to an older deployment reintroducing fixed defects. No ASVS 5.0.0 requirement covers deployment rollback; V15.2.1 is about component versions and was not stretched. |
| SEC-088 | `ASVS — (no requirement; see mapping §5)` | none | — | — | False assurance from the test harness (skips, exit codes, superuser test role). Assurance-process property, outside ASVS/WSTG scope; no CWE. |
| SEC-089 | `ASVS V4.1.5; WSTG-BUSL-02; CWE-347, CWE-294` | partial | V4.1.5 [L3] "Verify that per-message digital signatures are used to provide additional assura…" | WSTG-BUSL-02 Test Ability to Forge Requests | V4.1.5 (per-message signatures for sensitive transactions) covers signature checking; ASVS 5.0.0 has no webhook-replay/timestamp requirement. |
| SEC-090 | `ASVS V2.3.1, V8.3.1; WSTG-BUSL-01, WSTG-BUSL-06` | partial | V2.3.1 [L1] "Verify that the application will only process business logic flows for the same…"<br>V8.3.1 [L1] "Verify that the application enforces authorization rules at a trusted service la…" | WSTG-BUSL-01 Test Business Logic Data Validation<br>WSTG-BUSL-06 Testing for the Circumvention of Work Flows | Entitlement must follow the payment-provider state, not client input; no ASVS requirement names payment entitlement. |
| SEC-091 | `ASVS V1.3.11, V2.4.1; WSTG-INPV-10; CWE-93` | direct | V1.3.11 [L2] "Verify that the application sanitizes user input before passing to mail systems…"<br>V2.4.1 [L2] "Verify that anti-automation controls are in place to protect against excessive c…" | WSTG-INPV-10 Testing for IMAP SMTP Injection |  |
| SEC-092 | `ASVS V13.2.1, V13.3.2, V13.2.2` | direct | V13.2.1 [L2] "Verify that communications between backend application components that don't sup…"<br>V13.3.2 [L2] "Verify that access to secret assets adheres to the principle of least privilege."<br>V13.2.2 [L2] "Verify that communications between backend application components, including loc…" | — | No CWE chosen with confidence. |
| SEC-093 | `ASVS — (no requirement; see mapping §5); CWE-1427` | none | — | — | Prompt injection / unsafe AI tool use. ASVS 5.0.0 contains no LLM or AI requirement (searched descriptions for AI/LLM/prompt: no hit). |
| SEC-094 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Compromise of a developer machine. Outside ASVS/WSTG scope; no CWE. |
| SEC-095 | `ASVS V6.4.4, V6.4.6, V6.3.7; WSTG-ATHN-09; CWE-640` | partial | V6.4.4 [L2] "Verify that if a multi-factor authentication factor is lost, evidence of identit…"<br>V6.4.6 [L3] "Verify that administrative users can initiate the password reset process for the…"<br>V6.3.7 [L3] "Verify that users are notified after updates to authentication details, such as…" | WSTG-ATHN-09 Testing for Weak Password Change or Reset Functionalities | Identity proofing on factor loss (V6.4.4), admin-initiated reset without choosing the password (V6.4.6) and change notification (V6.3.7) are the technical half; the human tabletop has no standard id. |
| SEC-096 | `ASVS — (no requirement; see mapping §5)` | none | — | — | Physical, provider and unknown residual risks. No ASVS/WSTG requirement; no CWE. |

## 4. ASVS 5.0.0 reverse view (chapters V1–V17)

Rows = SEC rows citing at least one requirement in the chapter. Cited = distinct requirements cited / requirements in the
chapter. Uncited sections = sections of the chapter with no requirement cited by any row.

| Chapter | Name | Cited / total | SEC rows | Uncited sections |
|---|---|---|---|---|
| V1 | Encoding and Sanitization | 12 / 30 | SEC-026, SEC-033, SEC-034, SEC-035, SEC-037, SEC-039, SEC-040, SEC-041, SEC-052, SEC-074, SEC-091 | V1.4 Memory, String, and Unmanaged Code |
| V2 | Validation and Business Logic | 7 / 13 | SEC-015, SEC-029, SEC-030, SEC-031, SEC-032, SEC-053, SEC-055, SEC-073, SEC-078, SEC-084, SEC-090, SEC-091 | V2.1 Validation and Business Logic Documentation |
| V3 | Web Frontend Security | 12 / 31 | SEC-011, SEC-016, SEC-041, SEC-042, SEC-043, SEC-044, SEC-045, SEC-071 | V3.1 Web Frontend Security Documentation; V3.6 External Resource Integrity |
| V4 | API and Web Service | 3 / 16 | SEC-045, SEC-046, SEC-089 | V4.3 GraphQL; V4.4 WebSocket |
| V5 | File Handling | 6 / 13 | SEC-038, SEC-049, SEC-050, SEC-051 | V5.4 File Download |
| V6 | Authentication | 13 / 47 | SEC-001, SEC-002, SEC-003, SEC-004, SEC-005, SEC-006, SEC-007, SEC-008, SEC-079, SEC-095 | V6.2 Password Security; V6.6 Out-of-Band authentication mechanisms; V6.7 Cryptographic authentication mechanism |
| V7 | Session Management | 6 / 19 | SEC-004, SEC-009, SEC-010, SEC-012, SEC-013, SEC-014, SEC-084 | V7.1 Session Management Documentation; V7.3 Session Timeout; V7.6 Federated Re-authentication |
| V8 | Authorization | 8 / 13 | SEC-008, SEC-013, SEC-016, SEC-017, SEC-018, SEC-019, SEC-020, SEC-021, SEC-022, SEC-023, SEC-024, SEC-048, SEC-054, SEC-056, SEC-069, SEC-090 | V8.1 Authorization Documentation |
| V9 | Self-contained Tokens | 2 / 7 | SEC-010 | — |
| V10 | OAuth and OIDC | 2 / 36 | SEC-005 | V10.1 Generic OAuth and OIDC Security; V10.3 OAuth Resource Server; V10.4 OAuth Authorization Server; V10.6 OpenID Provider; V10.7 Consent Management |
| V11 | Cryptography | 1 / 24 | SEC-003 | V11.1 Cryptographic Inventory and Documentation; V11.2 Secure Cryptography Implementation; V11.3 Encryption Algorithms; V11.4 Hashing and Hash-based Functions; V11.6 Public Key Cryptography; V11.7 In-Use Data Cryptography |
| V12 | Secure Communication | 2 / 12 | SEC-071 | V12.3 General Service to Service Communication Security |
| V13 | Configuration | 11 / 21 | SEC-021, SEC-024, SEC-039, SEC-062, SEC-067, SEC-068, SEC-072, SEC-076, SEC-092 | — |
| V14 | Data Protection | 5 / 13 | SEC-011, SEC-022, SEC-047 | V14.1 Data Protection Documentation |
| V15 | Secure Coding and Architecture | 16 / 21 | SEC-001, SEC-015, SEC-019, SEC-022, SEC-028, SEC-032, SEC-036, SEC-039, SEC-046, SEC-048, SEC-050, SEC-054, SEC-055, SEC-057, SEC-058, SEC-059, SEC-060, SEC-064, SEC-073, SEC-074, SEC-075, SEC-076, SEC-077, SEC-078 | — |
| V16 | Security Logging and Error Handling | 8 / 17 | SEC-012, SEC-077, SEC-080, SEC-081, SEC-082, SEC-083 | — |
| V17 | WebRTC | 0 / 12 | **none** | V17.1 TURN Server; V17.2 Media; V17.3 Signaling |

Distinct ASVS requirements cited: 114 of 345 (33.0 %).

### 4.1 Gaps: what the campaign catalogue does not reach

**Chapters with no coverage at all:** V17 WebRTC.

**Sections with no requirement cited (30 of 80):** V1.4 Memory, String, and Unmanaged Code; V2.1 Validation and Business Logic Documentation; V3.1 Web Frontend Security Documentation; V3.6 External Resource Integrity; V4.3 GraphQL; V4.4 WebSocket; V5.4 File Download; V6.2 Password Security; V6.6 Out-of-Band authentication mechanisms; V6.7 Cryptographic authentication mechanism; V7.1 Session Management Documentation; V7.3 Session Timeout; V7.6 Federated Re-authentication; V8.1 Authorization Documentation; V10.1 Generic OAuth and OIDC Security; V10.3 OAuth Resource Server; V10.4 OAuth Authorization Server; V10.6 OpenID Provider; V10.7 Consent Management; V11.1 Cryptographic Inventory and Documentation; V11.2 Secure Cryptography Implementation; V11.3 Encryption Algorithms; V11.4 Hashing and Hash-based Functions; V11.6 Public Key Cryptography; V11.7 In-Use Data Cryptography; V12.3 General Service to Service Communication Security; V14.1 Data Protection Documentation; V17.1 TURN Server; V17.2 Media; V17.3 Signaling.

Reading the gaps honestly:

- **V6.2 Password Security (12 requirements, 8 of them L1) has no catalogue row.** The application has password login, so minimum length, 64-character support, breached/top-3000 password checks, and change-requires-current-password are applicable and untested by this campaign. This is the largest applicable gap.
- **V7.3 Session Timeout and V7.1 Session Management Documentation.** No row covers inactivity timeout or absolute session lifetime; SEC-009…SEC-016 cover fixation, forgery, revocation and step-up only.
- **V11 Cryptography is reached only through V11.5.1 (SEC-003).** Password hashing parameters (V11.4.2; bcrypt cost was measured in SEC-073 for availability, not judged against V11.4.2), encryption of stored secrets such as TOTP seeds (V11.3), the cryptographic inventory (V11.1) and constant-time comparison (V11.2.4, L3) are not catalogued.
- **V12.3 service-to-service TLS.** SEC-071 maps only the external-facing half (V12.2.1). Database and provider connections (V12.3.1, V12.3.2) are not catalogued, although lane E2 tooling forces TLS for its own inspection connections.
- **V5.4 File Download.** Exports and blob downloads are covered for authorisation (SEC-022) but not for Content-Disposition filenames (V5.4.1, V5.4.2) or malware scanning of served files (V5.4.3).
- **V14.2.7 data retention and V14.2.8 upload metadata stripping** (section V14.2 is otherwise cited) and **V14.1 data classification** have no catalogue row.
- **Documentation requirements** (V2.1, V3.1, V7.1, V8.1, V11.1, V14.1; plus V5.1.1, V6.1.1, V13.1.x and V16.1.1 which are cited) are mostly outside the catalogue, which is test-oriented. An ASVS L2 claim would need them.
- **Emailed login links and codes** (SEC-004, SEC-009) behave like out-of-band authenticators; V6.6.2/V6.6.3 (binding to the originating request; brute-force limits on codes) and V6.3.6 (email not used as an authentication factor, L3) were not mapped because the catalogue rows are about takeover and fixation, not about the email channel itself. Worth a row.
- **Probably not applicable, not verified by this lane:** V10.3/V10.4/V10.6/V10.7 (the app is at most an OAuth client, not a resource server, authorisation server or OpenID provider), V10.1 (generic OAuth, would apply if Google sign-in is enabled — SEC-005 is UNKNOWN), V4.3 GraphQL, V4.4 WebSocket, V6.7 WebAuthn/cryptographic authenticators, V7.6 federated re-authentication, V1.4 unmanaged memory (JavaScript; the native libraries are covered by SEC-064 through V15), V3.6 subresource integrity (L3) and V17 WebRTC. Each needs a one-line NOT APPLICABLE WITH EVIDENCE before an ASVS claim, not an assumption.

By level: L1 34 / 70 cited, L2 58 / 183, L3 22 / 92. Citing is mapping, not passing.

### 4.2 Level 1 requirements no row cites

| Req | Section | Text |
|---|---|---|
| V1.2.2 | Injection Prevention | "Verify that when dynamically building URLs, untrusted data is encoded according…" |
| V1.2.3 | Injection Prevention | "Verify that output encoding or escaping is used when dynamically building JavaSc…" |
| V1.3.1 | Sanitization | "Verify that all untrusted HTML input from WYSIWYG editors or similar is sanitize…" |
| V2.1.1 | Validation and Business Logic Documentation | "Verify that the application's documentation defines input validation rules for h…" |
| V2.2.1 | Input Validation | "Verify that input is validated to enforce business or functional expectations fo…" |
| V3.2.1 | Unintended Content Interpretation | "Verify that security controls are in place to prevent browsers from rendering co…" |
| V3.5.2 | Browser Origin Separation | "Verify that, if the application relies on the CORS preflight mechanism to preven…" |
| V4.1.1 | Generic Web Service Security | "Verify that every HTTP response with a message body contains a Content-Type head…" |
| V4.4.1 | WebSocket | "Verify that WebSocket over TLS (WSS) is used for all WebSocket connections." |
| V5.3.1 | File Storage | "Verify that files uploaded or generated by untrusted input and stored in a publi…" |
| V6.2.1 | Password Security | "Verify that user set passwords are at least 8 characters in length although a mi…" |
| V6.2.2 | Password Security | "Verify that users can change their password." |
| V6.2.3 | Password Security | "Verify that password change functionality requires the user's current and new pa…" |
| V6.2.4 | Password Security | "Verify that passwords submitted during account registration or password change a…" |
| V6.2.5 | Password Security | "Verify that passwords of any composition can be used, without rules limiting the…" |
| V6.2.6 | Password Security | "Verify that password input fields use type=password to mask the entry. Applicati…" |
| V6.2.7 | Password Security | "Verify that "paste" functionality, browser password helpers, and external passwo…" |
| V6.2.8 | Password Security | "Verify that the application verifies the user's password exactly as received fro…" |
| V6.4.2 | Authentication Factor Lifecycle and Recovery | "Verify that password hints or knowledge-based authentication (so-called "secret…" |
| V7.2.2 | Fundamental Session Management Security | "Verify that the application uses either self-contained or reference tokens that…" |
| V7.2.3 | Fundamental Session Management Security | "Verify that if reference tokens are used to represent user sessions, they are un…" |
| V8.1.1 | Authorization Documentation | "Verify that authorization documentation defines rules for restricting function-l…" |
| V9.1.2 | Token source and integrity | "Verify that only algorithms on an allowlist can be used to create and verify sel…" |
| V9.1.3 | Token source and integrity | "Verify that key material that is used to validate self-contained tokens is from…" |
| V9.2.1 | Token content | "Verify that, if a validity time span is present in the token data, the token and…" |
| V10.4.1 | OAuth Authorization Server | "Verify that the authorization server validates redirect URIs based on a client-s…" |
| V10.4.2 | OAuth Authorization Server | "Verify that, if the authorization server returns the authorization code in the a…" |
| V10.4.3 | OAuth Authorization Server | "Verify that the authorization code is short-lived. The maximum lifetime can be u…" |
| V10.4.4 | OAuth Authorization Server | "Verify that for a given client, the authorization server only allows the usage o…" |
| V10.4.5 | OAuth Authorization Server | "Verify that the authorization server mitigates refresh token replay attacks for…" |
| V11.3.1 | Encryption Algorithms | "Verify that insecure block modes (e.g., ECB) and weak padding schemes (e.g., PKC…" |
| V11.3.2 | Encryption Algorithms | "Verify that only approved ciphers and modes such as AES with GCM are used." |
| V11.4.1 | Hashing and Hash-based Functions | "Verify that only approved hash functions are used for general cryptographic use…" |
| V12.2.2 | HTTPS Communication with External Facing Services | "Verify that external facing services use publicly trusted TLS certificates." |
| V14.2.1 | General Data Protection | "Verify that sensitive data is only sent to the server in the HTTP message body o…" |
| V14.3.1 | Client-side Data Protection | "Verify that authenticated data is cleared from client storage, such as the brows…" |

## 5. Rows with no ASVS requirement

These rows carry `ASVS — (no requirement; see mapping §5)`. In each case the stated reason is that ASVS 5.0.0 verifies the
application itself and has no requirement for the subject; nearby requirements were considered and rejected rather than
stretched. A keyword search of all 345 `req_description` values for backup, restore, pipeline, build, deploy, repository,
DNS, domain, webhook, AI, LLM and prompt found no requirement on backups, CI, DNS/mail domains, provider accounts or AI.

| SEC | Risk | Reason |
|---|---|---|
| SEC-025 | Cross-table email collision | Identity uniqueness across the staff and member tables. ASVS 5.0.0 has no requirement on identifier uniqueness within one application (V6.8.1 is about multiple identity providers and was not stretched). WSTG-IDNT-02 is a partial fit (registration allowing a second identity for one email). |
| SEC-027 | Legacy duplicate ambiguity | Legacy duplicate identities in existing data. No ASVS 5.0.0 requirement covers pre-existing duplicate identifiers; no WSTG checklist id; no CWE chosen with confidence. |
| SEC-061 | CI workflow injection | CI workflow injection (GitHub Actions expressions). ASVS 5.0.0 verifies the application, not its CI system; no requirement covers workflow definitions. |
| SEC-063 | Untrusted artifact promotion (C). SEC-064 Memory-safety/runtime exploitation | Promotion of a build artifact that CI did not produce. ASVS 5.0.0 has no build-provenance requirement (V15.2.4 is about third-party components and was not stretched); no WSTG id; no CWE chosen with confidence. |
| SEC-065 | Cloud/repository account takeover | Takeover of hosting/repository accounts (Vercel, GitHub, Neon). ASVS 5.0.0 MFA requirements (V6.3.3) apply to users of the application, not to the operator accounts of its providers. |
| SEC-066 | Stale deployments/aliases | Stale preview/production deployments and aliases on the host. No ASVS 5.0.0 requirement covers retired deployments; WSTG-INFO-04 (enumerate applications on the web server) is a partial fit. |
| SEC-070 | DNS/dangling-domain takeover | Dangling DNS and email-domain authentication (SPF/DMARC). ASVS 5.0.0 has no DNS or mail-domain requirement; WSTG-CONF-10 covers subdomain takeover only. |
| SEC-085 | Backup compromise/ransomware | Backup confidentiality and ransomware resistance. ASVS 5.0.0 contains no backup requirement (searched all 345 descriptions for backup/restore: no hit). |
| SEC-086 | Unrestorable backup | Restore drills. ASVS 5.0.0 contains no backup or restore requirement (same search). |
| SEC-087 | Rollback reintroduces vulnerabilities | Rollback to an older deployment reintroducing fixed defects. No ASVS 5.0.0 requirement covers deployment rollback; V15.2.1 is about component versions and was not stretched. |
| SEC-088 | Test-harness false assurance | False assurance from the test harness (skips, exit codes, superuser test role). Assurance-process property, outside ASVS/WSTG scope; no CWE. |
| SEC-093 | Prompt injection/unsafe AI tools | Prompt injection / unsafe AI tool use. ASVS 5.0.0 contains no LLM or AI requirement (searched descriptions for AI/LLM/prompt: no hit). |
| SEC-094 | Developer endpoint compromise | Compromise of a developer machine. Outside ASVS/WSTG scope; no CWE. |
| SEC-096 | Physical/provider/unknown residual risks | Physical, provider and unknown residual risks. No ASVS/WSTG requirement; no CWE. |

## 6. WSTG checklist reverse view

| Category | Ids cited / in checklist | Cited ids (rows) | Uncited ids |
|---|---|---|---|
| WSTG-INFO | 2 / 10 | WSTG-INFO-04 (SEC-066); WSTG-INFO-05 (SEC-062) | WSTG-INFO-01 Conduct Search Engine Discovery and Reconnaissance for Information Leakage; WSTG-INFO-02 Fingerprint Web Server; WSTG-INFO-03 Review Webserver Metafiles for Information Leakage; WSTG-INFO-06 Identify Application Entry Points; WSTG-INFO-07 Map Execution Paths Through Application; WSTG-INFO-08 Fingerprint Web Application Framework; WSTG-INFO-09 Fingerprint Web Application; WSTG-INFO-10 Map Application Architecture |
| WSTG-CONF | 4 / 12 | WSTG-CONF-05 (SEC-072); WSTG-CONF-07 (SEC-071); WSTG-CONF-10 (SEC-070); WSTG-CONF-11 (SEC-069) | WSTG-CONF-01 Test Network Infrastructure Configuration; WSTG-CONF-02 Test Application Platform Configuration; WSTG-CONF-03 Test File Extensions Handling for Sensitive Information; WSTG-CONF-04 Review Old Backup and Unreferenced Files for Sensitive Information; WSTG-CONF-06 Test HTTP Methods; WSTG-CONF-08 Test RIA Cross Domain Policy; WSTG-CONF-09 Test File Permission; WSTG-CONF-12 Testing for Content Security Policy |
| WSTG-IDNT | 3 / 5 | WSTG-IDNT-02 (SEC-008, SEC-025); WSTG-IDNT-03 (SEC-004, SEC-008); WSTG-IDNT-04 (SEC-002) | WSTG-IDNT-01 Test Role Definitions; WSTG-IDNT-05 Testing for Weak or Unenforced Username Policy |
| WSTG-ATHN | 5 / 10 | WSTG-ATHN-03 (SEC-001, SEC-079); WSTG-ATHN-04 (SEC-006, SEC-048); WSTG-ATHN-06 (SEC-047); WSTG-ATHN-09 (SEC-003, SEC-004, SEC-095); WSTG-ATHN-10 (SEC-001) | WSTG-ATHN-01 Testing for Credentials Transported over an Encrypted Channel; WSTG-ATHN-02 Testing for Default Credentials; WSTG-ATHN-05 Testing for Vulnerable Remember Password; WSTG-ATHN-07 Testing for Weak Password Policy; WSTG-ATHN-08 Testing for Weak Security Question Answer |
| WSTG-ATHZ | 4 / 4 | WSTG-ATHZ-01 (SEC-038); WSTG-ATHZ-02 (SEC-013, SEC-018, SEC-020, SEC-022, SEC-048); WSTG-ATHZ-03 (SEC-018, SEC-023); WSTG-ATHZ-04 (SEC-017, SEC-056) | — |
| WSTG-SESS | 6 / 10 | WSTG-SESS-02 (SEC-011); WSTG-SESS-03 (SEC-009); WSTG-SESS-05 (SEC-042); WSTG-SESS-06 (SEC-012); WSTG-SESS-08 (SEC-016); WSTG-SESS-10 (SEC-010) | WSTG-SESS-01 Testing for Session Management Schema; WSTG-SESS-04 Testing for Exposed Session Variables; WSTG-SESS-07 Testing Session Timeout; WSTG-SESS-09 Testing for Session Hijacking |
| WSTG-INPV | 11 / 19 | WSTG-INPV-02 (SEC-041); WSTG-INPV-04 (SEC-019); WSTG-INPV-05 (SEC-033); WSTG-INPV-07 (SEC-040); WSTG-INPV-10 (SEC-091); WSTG-INPV-11 (SEC-035); WSTG-INPV-12 (SEC-034); WSTG-INPV-15 (SEC-046); WSTG-INPV-17 (SEC-020, SEC-045); WSTG-INPV-18 (SEC-035); WSTG-INPV-19 (SEC-039) | WSTG-INPV-01 Testing for Reflected Cross Site Scripting; WSTG-INPV-03 Testing for HTTP Verb Tampering; WSTG-INPV-06 Testing for LDAP Injection; WSTG-INPV-08 Testing for SSI Injection; WSTG-INPV-09 Testing for XPath Injection; WSTG-INPV-13 Testing for Format String Injection; WSTG-INPV-14 Testing for Incubated Vulnerabilities; WSTG-INPV-16 Testing for HTTP Incoming Requests |
| WSTG-ERRH | 0 / 2 | **none** | WSTG-ERRH-01 Testing for Improper Error Handling; WSTG-ERRH-02 Testing for Stack Traces |
| WSTG-CRYP | 1 / 4 | WSTG-CRYP-01 (SEC-071) | WSTG-CRYP-02 Testing for Padding Oracle; WSTG-CRYP-03 Testing for Sensitive Information Sent Via Unencrypted Channels; WSTG-CRYP-04 Testing for Weak Encryption |
| WSTG-BUSL | 7 / 9 | WSTG-BUSL-01 (SEC-029, SEC-053, SEC-054, SEC-090); WSTG-BUSL-02 (SEC-089); WSTG-BUSL-05 (SEC-007, SEC-015, SEC-031, SEC-055); WSTG-BUSL-06 (SEC-014, SEC-030, SEC-090); WSTG-BUSL-07 (SEC-078); WSTG-BUSL-08 (SEC-049); WSTG-BUSL-09 (SEC-049, SEC-050, SEC-051) | WSTG-BUSL-03 Test Integrity Checks; WSTG-BUSL-04 Test for Process Timing |
| WSTG-CLNT | 5 / 13 | WSTG-CLNT-01 (SEC-041); WSTG-CLNT-04 (SEC-045); WSTG-CLNT-07 (SEC-043); WSTG-CLNT-09 (SEC-044); WSTG-CLNT-12 (SEC-011) | WSTG-CLNT-02 Testing for JavaScript Execution; WSTG-CLNT-03 Testing for HTML Injection; WSTG-CLNT-05 Testing for CSS Injection; WSTG-CLNT-06 Testing for Client-Side Resource Manipulation; WSTG-CLNT-08 Testing for Cross Site Flashing; WSTG-CLNT-10 Testing WebSockets; WSTG-CLNT-11 Test Web Messaging; WSTG-CLNT-13 Testing for Cross Site Script Inclusion |
| WSTG-APIT | 0 / 1 | **none** | WSTG-APIT-01 Testing GraphQL |

Distinct WSTG ids cited: 48 of 99. Categories with no id cited: WSTG-ERRH, WSTG-APIT.

Topics the catalogue covers that have no id in this 2023-09-28 checklist (so the row carries no WSTG ref): OAuth/OIDC
(SEC-005), mass assignment (SEC-019, partly), prototype pollution (SEC-036), deserialisation (SEC-037), CSV/formula
injection (SEC-052), supply chain and CI (SEC-057…SEC-064), database roles (SEC-021, SEC-068), logging and audit
(SEC-081…SEC-083), backups (SEC-085, SEC-086) and resource exhaustion (SEC-073…SEC-077).

## 7. CWE glossary (CWE list 4.x, no local copy)

| CWE | Name | Rows |
|---|---|---|
| CWE-22 | Improper Limitation of a Pathname to a Restricted Directory ('Path Traversal') | SEC-038 |
| CWE-77 | Improper Neutralization of Special Elements used in a Command ('Command Injection') | SEC-061 |
| CWE-78 | Improper Neutralization of Special Elements used in an OS Command ('OS Command Injection') | SEC-034 |
| CWE-79 | Improper Neutralization of Input During Web Page Generation ('Cross-site Scripting') | SEC-041 |
| CWE-88 | Improper Neutralization of Argument Delimiters in a Command ('Argument Injection') | SEC-034 |
| CWE-89 | Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection') | SEC-033 |
| CWE-93 | Improper Neutralization of CRLF Sequences ('CRLF Injection') | SEC-091 |
| CWE-94 | Improper Control of Generation of Code ('Code Injection') | SEC-035 |
| CWE-117 | Improper Output Neutralization for Logs | SEC-082 |
| CWE-178 | Improper Handling of Case Sensitivity | SEC-026 |
| CWE-200 | Exposure of Sensitive Information to an Unauthorized Actor | SEC-022 |
| CWE-204 | Observable Response Discrepancy | SEC-002 |
| CWE-250 | Execution with Unnecessary Privileges | SEC-021, SEC-068 |
| CWE-269 | Improper Privilege Management | SEC-008, SEC-023 |
| CWE-285 | Improper Authorization | SEC-018 |
| CWE-288 | Authentication Bypass Using an Alternate Path or Channel | SEC-006 |
| CWE-294 | Authentication Bypass by Capture-replay | SEC-007, SEC-089 |
| CWE-306 | Missing Authentication for Critical Function | SEC-072 |
| CWE-307 | Improper Restriction of Excessive Authentication Attempts | SEC-001 |
| CWE-308 | Use of Single-factor Authentication | SEC-065 |
| CWE-319 | Cleartext Transmission of Sensitive Information | SEC-071 |
| CWE-347 | Improper Verification of Cryptographic Signature | SEC-010, SEC-089 |
| CWE-352 | Cross-Site Request Forgery (CSRF) | SEC-042 |
| CWE-362 | Concurrent Execution using Shared Resource with Improper Synchronization ('Race Condition') | SEC-015, SEC-032, SEC-055 |
| CWE-367 | Time-of-check Time-of-use (TOCTOU) Race Condition | SEC-028 |
| CWE-384 | Session Fixation | SEC-009 |
| CWE-400 | Uncontrolled Resource Consumption | SEC-076, SEC-077 |
| CWE-409 | Improper Handling of Highly Compressed Data (Data Amplification) | SEC-051 |
| CWE-434 | Unrestricted Upload of File with Dangerous Type | SEC-049 |
| CWE-441 | Unintended Proxy or Intermediary ('Confused Deputy') | SEC-024 |
| CWE-444 | Inconsistent Interpretation of HTTP Requests ('HTTP Request/Response Smuggling') | SEC-046 |
| CWE-489 | Active Debug Code | SEC-072 |
| CWE-494 | Download of Code Without Integrity Check | SEC-058, SEC-060 |
| CWE-502 | Deserialization of Untrusted Data | SEC-037 |
| CWE-506 | Embedded Malicious Code | SEC-060 |
| CWE-522 | Insufficiently Protected Credentials | SEC-067 |
| CWE-524 | Use of Cache Containing Sensitive Information | SEC-047 |
| CWE-525 | Use of Web Browser Cache Containing Sensitive Information | SEC-047 |
| CWE-532 | Insertion of Sensitive Information into Log File | SEC-082 |
| CWE-540 | Inclusion of Sensitive Information in Source Code | SEC-062 |
| CWE-552 | Files or Directories Accessible to External Parties | SEC-069 |
| CWE-601 | URL Redirection to Untrusted Site ('Open Redirect') | SEC-045 |
| CWE-611 | Improper Restriction of XML External Entity Reference | SEC-040 |
| CWE-613 | Insufficient Session Expiration | SEC-013 |
| CWE-614 | Sensitive Cookie in HTTPS Session Without 'Secure' Attribute | SEC-011 |
| CWE-636 | Not Failing Securely ('Failing Open') | SEC-012, SEC-080 |
| CWE-639 | Authorization Bypass Through User-Controlled Key | SEC-017, SEC-056 |
| CWE-640 | Weak Password Recovery Mechanism for Forgotten Password | SEC-003, SEC-095 |
| CWE-645 | Overly Restrictive Account Lockout Mechanism | SEC-079 |
| CWE-770 | Allocation of Resources Without Limits or Throttling | SEC-073, SEC-075, SEC-078 |
| CWE-776 | Improper Restriction of Recursive Entity References in DTDs ('XML Entity Expansion') | SEC-040 |
| CWE-778 | Insufficient Logging | SEC-081, SEC-083 |
| CWE-798 | Use of Hard-coded Credentials | SEC-062 |
| CWE-863 | Incorrect Authorization | SEC-014 |
| CWE-915 | Improperly Controlled Modification of Dynamically-Determined Object Attributes | SEC-019, SEC-054 |
| CWE-918 | Server-Side Request Forgery (SSRF) | SEC-039 |
| CWE-942 | Permissive Cross-domain Policy with Untrusted Domains | SEC-043 |
| CWE-1004 | Sensitive Cookie Without 'HttpOnly' Flag | SEC-011 |
| CWE-1021 | Improper Restriction of Rendered UI Layers or Frames | SEC-044 |
| CWE-1104 | Use of Unmaintained Third Party Components | SEC-064 |
| CWE-1236 | Improper Neutralization of Formula Elements in a CSV File | SEC-052 |
| CWE-1321 | Improperly Controlled Modification of Object Prototype Attributes ('Prototype Pollution') | SEC-036 |
| CWE-1333 | Inefficient Regular Expression Complexity | SEC-074 |
| CWE-1336 | Improper Neutralization of Special Elements Used in a Template Engine | SEC-035 |
| CWE-1395 | Dependency on Vulnerable Third-Party Component | SEC-057 |
| CWE-1427 | Improper Neutralization of Input Used for LLM Prompting | SEC-093 |

Rows with no CWE: SEC-004, SEC-005, SEC-016, SEC-020, SEC-025, SEC-027, SEC-029, SEC-030, SEC-031, SEC-048, SEC-050, SEC-053, SEC-059, SEC-063, SEC-066, SEC-070, SEC-084, SEC-085, SEC-086, SEC-087, SEC-088, SEC-090, SEC-092, SEC-094, SEC-096.

## 8. Verification

Runtime: Node v24.21.0 (the lead's binary under `<scratchpad>/security/node24/node-v24.21.0-win-x64`, prefixed to PATH),
9 Oct 2026, working tree of `security/assurance-2026-10` at HEAD `3bb4fb5` plus this lane's uncommitted edits (the lane
started at `4b06d31`; the lead's `3bb4fb5` changed two matrix rows in other columns while the lane worked, and every check
below was re-run after it). Scratchpad paths are shortened to `<scratchpad>` below.

### 8.1 Standard refs check

`scripts/readiness/standards-refs-check.mjs` parses every `Standard refs` cell, checks each ASVS id against `req_id` in the
flat JSON (requirement-level ids only), each WSTG id against the checklist table, each CWE id for syntax and for an entry in
§7, and that §3 of this document carries the identical cell text for every row. It exits 1 on any invalid id, unrecognised
segment or mismatch (and on unmapped rows with `--require-all`).

```text
$ node --version
v24.21.0
$ node scripts/readiness/standards-refs-check.mjs --asvs=<scratchpad>/security/standards/asvs-5.0.0-en.flat.json --wstg=<scratchpad>/security/standards/wstg-20230928-checklist.md --require-all
{
  "sources": {
    "asvs": "<scratchpad>/security/standards/asvs-5.0.0-en.flat.json",
    "asvsRequirements": 345,
    "wstg": "<scratchpad>/security/standards/wstg-20230928-checklist.md",
    "wstgIds": 99,
    "matrix": "docs/security/COVERAGE-MATRIX.md",
    "mapping": "docs/security/STANDARDS-MAPPING.md"
  },
  "rows": 96,
  "mapped": 96,
  "unmapped": 0,
  "asvsNone": 14,
  "asvsRefs": 162,
  "wstgRefs": 71,
  "cweRefs": 81,
  "invalid": 0,
  "mismatch": 0,
  "distinctAsvs": 114,
  "distinctWstg": 48,
  "distinctCwe": 66,
  "unmappedRows": [],
  "problems": [],
  "verdict": "PASS"
}
exit=0
```

The first run of the script reported 28 problems (exit 1): the explicit `ASVS — (no requirement; see mapping §5)` segment
contains a semicolon inside its parentheses and the parser split on it. The parser now splits on top-level `;` only; no
matrix cell changed as a result.

### 8.2 Negative controls

Each control copies the matrix, plants one defect in the SEC-001 cell and runs the check (the first five with the mapping
cross-check off so only the planted id is reported). Every control must exit 1 and name the defect.

```text
[fake-asvs] exit=1 problems: ["SEC-001: ASVS V6.3.99 not in <scratchpad>/security/standards/asvs-5.0.0-en.flat.json"]
[chapter-only] exit=1 problems: ["SEC-001: \"V6\" is not a requirement-level ASVS id"]
[fake-wstg] exit=1 problems: ["SEC-001: WSTG-ATHN-99 not in <scratchpad>/security/standards/wstg-20230928-checklist.md"]
[bad-cwe] exit=1 problems: ["SEC-001: unrecognised segment \"CWE307\""]
[junk-segment] exit=1 problems: ["SEC-001: unrecognised segment \"CAPEC-16\""]
[mapping-mismatch] exit=1 1 mismatch line(s)
[unglossed-cwe] exit=1 1 hit(s)
```

### 8.3 Matrix still reconciles

```text
$ node scripts/readiness/coverage-reconcile.mjs --findings-strict
{"rows":96,"missing":[],"dups":[],"unexpected":[],"malformed":[],"unparsed":[],"inconsistent":[],"applicability":{"APPLICABLE":92,"NOT APPLICABLE WITH EVIDENCE":3,"UNKNOWN":1},"verification":{"BLOCKED":4,"FAIL":14,"FIXED AWAITING RETEST":13,"N/A (guard test)":3,"NOT RUN":7,"PARTIAL":1,"PASS":50,"UNKNOWN":4},"requireReviewed":false,"rowsWithResidualQualifiers":30,"verdict":"RECONCILED","findings":{"rows":89,"dups":[],"gaps":[],"outOfOrder":[],"problems":[],"verdict":"RECONCILED"}}
exit=0
```

96 rows, 0 missing, 0 malformed, 0 unparsed, RECONCILED. The same command with `--matrix=` pointed at the committed matrix
(`git show HEAD:docs/security/COVERAGE-MATRIX.md`, HEAD `3bb4fb5`) produced byte-identical output (`cmp`), and a
line-by-line comparison against that file showed the 96 changed lines differ only after the last ` | ` (the `Standard refs`
cell); no other column or line changed.

### 8.4 Re-running

```sh
node scripts/readiness/standards-refs-check.mjs --asvs=<path>/asvs-5.0.0-en.flat.json \
  --wstg=<path>/wstg-20230928-checklist.md --require-all
node scripts/readiness/coverage-reconcile.mjs --findings-strict
```

The ASVS and WSTG source files are not in the repository; their SHA-256 values are in §1 so a re-run can confirm it is
reading the same versions.
