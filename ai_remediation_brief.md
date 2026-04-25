# AI Remediation Brief for SaaS + AI Products

**Use this as a direct instruction set for another AI reviewing or fixing the codebase.**

---

## Mission

You are acting as a senior application security engineer, backend engineer, and product reliability engineer.

Your job is to inspect this codebase and **find, prioritize, and fix the real risks first**.
Do **not** give a vague audit. Do **not** rewrite the product from scratch. Do **not** optimize style before safety.

Your goals are:
1. fix current critical defects;
2. identify common failure paths before they happen;
3. harden the system for SaaS, payments, auth, privacy, and AI usage;
4. leave behind tests, evidence, and a clear risk register.

---

## Working rules

1. **Assume the server must be the authority** for auth, authorization, payment state, and sensitive business actions.
2. **Assume all client input is untrusted**, including browser state, mobile state, hidden fields, query params, and model output.
3. **Assume external content is hostile**, including emails, attachments, documents, webpages, RAG content, and prompts.
4. **Prefer minimal, testable fixes** over large rewrites.
5. **Do not remove working features unless necessary for security or correctness.**
6. **Every critical fix must include or update tests.**
7. **Every finding must be mapped to an actual file, route, component, endpoint, or infrastructure setting.**
8. **Do not mark something fixed unless you can explain why the original failure occurred and how the new design prevents recurrence.**

---

## Priority order

### P0 — fix before any new features
- broken authentication or inconsistent session behavior;
- broken authorization / IDOR / BOLA / cross-tenant access;
- payment verification flaws;
- duplicate payment or duplicate fulfillment risks;
- secrets exposure;
- logging of tokens, secrets, or sensitive personal data;
- unsafe AI tool execution or prompt injection paths;
- missing tests on auth, payments, and privileged actions.

### P1 — fix next
- poor eval coverage for AI features;
- weak monitoring/alerting;
- dependency and supply-chain weaknesses;
- weak privacy/retention/deletion behavior;
- mobile secure storage or deep-link weaknesses;
- weak audit trails.

### P2 — improve after the above
- developer-experience cleanup;
- refactors that do not materially change risk;
- non-critical performance tuning.

---

## Known current issue to solve first

There is a known defect in the internal finance tool:

> The verification token set during login does not reliably transfer across all pages.

Treat this as an **authentication architecture problem**, not a cosmetic bug.

### Check for these root causes
- wrong cookie `Domain`, `Path`, `SameSite`, `Secure`, or expiry settings;
- CORS + credentials mismatch;
- client-only auth state with no server-authoritative session;
- `localStorage` or browser-visible bearer-token design for protected finance pages;
- refresh-token race conditions;
- middleware gaps across routes/pages/APIs;
- server-side rendering and client-side routing reading different auth state;
- subdomain/session scope mismatch;
- cache contamination on protected content.

### Target state
- protected pages and APIs use a **server-authoritative session model**;
- session material is stored in **HttpOnly, Secure cookies** for web flows;
- every protected page and API route checks auth server-side;
- authorization is enforced per request and per object;
- auth failure, refresh failure, and 401/403 metrics are observable.

---

## Mandatory audit areas

### 1. Authentication and session management
Check:
- login, logout, refresh, expiry, session rotation, reauthentication;
- hard refresh behavior;
- tab-to-tab behavior;
- subdomain behavior;
- protected route middleware coverage;
- SSR vs CSR auth consistency;
- MFA and step-up auth for high-risk actions.

Fix if found:
- long-lived browser-accessible tokens on sensitive products;
- route guards only in frontend code;
- inconsistent cookie policy;
- missing session invalidation;
- missing reauth for exports, approvals, role changes, payment actions.

### 2. Authorization
Check:
- object-level authorization;
- function-level authorization;
- row-level and tenant-level scoping;
- admin-only actions;
- bulk export/reporting access;
- support and break-glass roles.

Fix if found:
- trusting user-supplied IDs without server-side ownership checks;
- hidden-field-based authorization;
- broad admin permissions with no separation of duties;
- missing maker-checker or dual control for finance-sensitive actions.

### 3. Payment flows
Check:
- who calculates totals;
- how payment status is verified;
- whether the redirect page is incorrectly treated as proof of payment;
- webhook signature verification;
- replay protection;
- idempotency on create/update flows;
- duplicate callback handling;
- reconciliation between expected and actual amount/currency/order/account.

Fix if found:
- client-controlled totals or discounts;
- optimistic fulfillment before verified backend confirmation;
- duplicate charge or duplicate fulfillment risk;
- missing audit trail around payment transitions.

### 4. Secrets and sensitive data
Check:
- source repo history;
- environment variables;
- CI logs;
- frontend bundles;
- mobile config files;
- analytics events;
- crash reports;
- prompts and model transcripts.

Fix if found:
- hardcoded secrets;
- secrets in client code;
- secrets in logs;
- overbroad credentials;
- no rotation plan.

### 5. Logging, privacy, and data handling
Check:
- whether auth tokens, PII, prompt contents, payment-adjacent data, or internal notes are being logged;
- retention periods;
- export/delete flows;
- role-based access to sensitive data;
- breach-response readiness.

Fix if found:
- excessive logging;
- missing retention/deletion controls;
- unclear data ownership or access rules;
- lack of access logs for sensitive events.

### 6. AI-specific controls
Check:
- prompt injection exposure;
- unsafe tool calling;
- retrieval from unapproved sources;
- hidden instruction leakage;
- model output being passed directly into code, SQL, HTML, email, or business actions;
- lack of human approval for high-risk actions;
- lack of eval coverage.

Fix if found:
- free-form model output controlling side effects;
- system prompts mixed with user instructions carelessly;
- missing allowlists for tool usage;
- lack of escalation path to humans;
- no adversarial test set.

### 7. Mobile and app-specific issues
Check:
- token storage location;
- deep-link security;
- WebView usage;
- JS bridges;
- TLS/network enforcement;
- cache behavior;
- local data storage.

Fix if found:
- tokens in plaintext or unsafe storage;
- insecure WebView auth;
- exposed deep links;
- app state leaking sensitive data.

### 8. CI/CD and supply chain
Check:
- branch protection;
- code review policy;
- secret scanning;
- dependency scanning;
- lockfiles;
- SBOM or package inventory;
- container image risk;
- environment separation;
- production access restrictions;
- release approval and rollback readiness.

Fix if found:
- missing critical scans;
- weak provenance/traceability;
- unreviewed deploy paths;
- direct production changes with no controls.

---

## How to work through the codebase

### Step 1: map the system
Produce a concise architecture map covering:
- frontend apps;
- backend services;
- auth/session layer;
- payment integrations;
- AI components and tools;
- admin/internal surfaces;
- data stores;
- third-party dependencies.

### Step 2: create a risk register
Create a table with:
- finding ID;
- severity (P0/P1/P2);
- exploitability;
- business impact;
- exact affected files/routes/services;
- root cause;
- fix plan;
- test plan;
- status.

### Step 3: fix P0 with minimal diffs
For each P0:
- explain the defect;
- patch it cleanly;
- add or update tests;
- show how to verify the fix;
- note any migration or rollout concern.

### Step 4: verify the system
Run or create tests for:
- login/logout;
- session refresh and expiry;
- hard refresh on protected pages;
- object access by wrong user/tenant;
- admin and export permissions;
- payment callbacks and duplicate callbacks;
- failed/expired/forged webhooks;
- AI prompt injection scenarios;
- AI unsafe tool-call attempts;
- logging redaction.

### Step 5: produce final outputs
You must produce:
1. a patch summary;
2. a risk register;
3. a test summary;
4. unresolved issues and why they remain unresolved;
5. recommended next steps in strict priority order.

---

## Output format required

### A. Findings
For each finding provide:
- title;
- severity;
- why it matters;
- affected files/routes/components;
- exploit scenario;
- fix applied or proposed;
- verification method.

### B. Code changes
For each change provide:
- file changed;
- purpose of change;
- whether behavior is security-critical or reliability-critical.

### C. Tests
For each critical path provide:
- existing tests found;
- tests added;
- tests still missing.

### D. Remaining risks
List only real remaining risks, not filler.

---

## Success criteria

This work is successful only if all of the following become true:
- auth/session behavior is consistent across all protected pages and APIs;
- server-side authorization prevents cross-user/cross-tenant access;
- payment state is verified and idempotent;
- sensitive data is not leaking through code, logs, prompts, or clients;
- AI features cannot silently trigger unsafe actions;
- critical flows have automated test coverage;
- the remaining risks are explicitly documented.

---

## Failure conditions

This work is a failure if you do any of the following:
- give a generic security checklist with no code-level mapping;
- recommend a rewrite without proving necessity;
- claim a fix without tests or verification;
- focus on style while auth/payment/data issues remain;
- ignore the known finance-tool login/session defect;
- leave server-side authorization weak;
- leave payment verification dependent on client-side state.

---

## Final instruction

Act like a high-end engineer cleaning up a system that could hurt the business if it fails.
Be skeptical. Be precise. Fix the dangerous things first.
