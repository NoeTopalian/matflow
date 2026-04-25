# SaaS + AI Product Assurance Playbook

**Prepared for:** a customer-facing email chatbot, a payment-enabled web/mobile app, and an internal finance tool  
**Date:** 19 April 2026  
**Purpose:** a practical report and operator's guide you can hand to another AI or engineer to harden these systems, fix current defects, and block the most common failures in SaaS and AI-enabled products.

> **Hard truth:** “Perfect security” and “no errors” are fantasy. The real target is a system that is hard to break, easy to verify, fast to monitor, and fast to recover. If you chase perfection, you will ship late and still miss obvious failure modes. If you build strong controls, release gates, observability, and rollback paths, you can run a serious product.

---

## 1. Executive summary

### What matters most

1. **Your biggest risks are not exotic AI failures.** They are boring engineering failures with expensive consequences: broken authentication, broken authorization, insecure payment state handling, secrets leakage, bad logging, weak dependency hygiene, and missing release gates.
2. **AI adds a second class of risk:** prompt injection, insecure tool use, data leakage through outputs, overreliance on model answers, weak evaluations, and excessive autonomy.
3. **Your finance-tool login defect is not “just a token bug.”** It is an authentication architecture problem until proven otherwise.
4. **You should default to server-authoritative state.** The server should be the source of truth for auth, permissions, payment status, pricing, and business-critical decisions.
5. **Do not let AI own critical truth.** AI can classify, draft, summarize, and recommend. It should not silently finalize payments, permissions, legal statements, irreversible updates, or high-risk finance actions without deterministic controls and human review.

### Immediate priorities

**P0: do these before adding more features**

- Replace fragile token handling with a deliberate auth/session design.
- Verify authorization at every object, page, API route, and action.
- Make payment status server-driven, signature-verified, and idempotent.
- Stop secrets from living in code, client bundles, logs, prompts, or mobile storage.
- Add release-blocking tests for auth, payment flows, and AI evals.
- Add monitoring, audit logs, rollback, and breach/incident runbooks.

**P1: do these next**

- Add AI guardrails: prompt injection defenses, tool scoping, output validation, human escalation.
- Add supply-chain controls: SBOM, dependency policy, CI security checks, signed builds/provenance where practical.
- Add data-minimization, retention, deletion, and privacy-by-design controls.
- Add mobile-specific hardening for token storage, network transport, WebView handling, and deep links.

### Cross-vendor consensus from current guidance

Across current guidance from NIST, OWASP, OpenAI, Anthropic, Google, Microsoft, ICO, Stripe, and FCA, the pattern is consistent:

- start simpler than you want;
- define success criteria before you tune prompts;
- evaluate continuously, not vibes-first;
- separate instructions from data;
- limit tool permissions and automation authority;
- assume external content can be hostile;
- verify critical state on the server;
- log enough to investigate, but not enough to leak sensitive data;
- make rollback and recovery part of the design, not an afterthought.

---

## 2. What you are actually building

You effectively have **three different security profiles**:

### A. Customer-facing email chatbot
This is an **AI application with data-access risk**.
Its main failure modes are:
- prompt injection;
- sensitive information disclosure;
- hallucinated or overconfident responses;
- tool misuse;
- hidden instructions in retrieved content, emails, attachments, or web pages;
- weak escalation to humans;
- poor logging and eval coverage.

### B. Payment-enabled web/mobile app
This is a **high-trust SaaS product with payment and identity risk**.
Its main failure modes are:
- broken auth/session handling;
- weak access control;
- untrusted client-side pricing or order state;
- spoofed/replayed callbacks;
- duplicate charges or duplicate fulfillment;
- poor secrets handling;
- insufficient data protection and incident response.

### C. Internal finance tool
This is a **privileged business system**.
Its main failure modes are:
- fragile login/session state;
- broken row-level authorization;
- overprivileged internal users;
- weak audit trails;
- insufficient reauthentication for sensitive actions;
- exported data leakage;
- weak maker-checker controls;
- bad operational discipline hidden behind “it’s only internal.”

**Internal does not mean safe.** Internal tools are often more dangerous because they expose more money, more data, and more authority with less scrutiny.

---

## 3. Non-negotiable design rules

### Rule 1: The server is the authority
Never trust the client for:
- user identity;
- role/permission decisions;
- object access;
- payment success;
- prices, discounts, taxes, credits, or balances;
- whether a sensitive action is allowed.

### Rule 2: Use boring authentication
Do not invent auth unless you have no choice.
Prefer well-understood patterns:
- Web: server-side session or short-lived access/session token in an **HttpOnly, Secure cookie**.
- Mobile/native: OAuth with **external browser + PKCE**, not a raw credential flow inside a WebView.
- High-risk/internal finance surfaces: MFA, ideally phishing-resistant where practical.

### Rule 3: Keep long-lived secrets and tokens off the frontend
Avoid storing long-lived auth material in:
- `localStorage`;
- raw browser-accessible JS variables;
- mobile shared preferences / AsyncStorage / plaintext caches;
- logs, analytics events, or crash reports.

### Rule 4: Authorization is a per-request discipline
Every object access and every action must be checked server-side. Not just at login. Not just in the UI.

### Rule 5: Payment state is webhook-verified and idempotent
The user's redirect back to your app is **not proof of payment**. The server-to-server verification path is.

### Rule 6: AI is not trusted input processing
Treat model input, retrieved content, attachments, documents, code comments, and web pages as hostile until sanitized and constrained.

### Rule 7: Every release must have evidence
No release should rely on “it seemed fine in manual testing.” You need test evidence, security evidence, and rollback readiness.

---

## 4. Common failure modes you should assume will happen unless you block them

| Failure mode | Where it shows up | What it looks like in real life | Minimum control |
|---|---|---|---|
| Broken authentication | web, mobile, internal tools | login works inconsistently; stale sessions; users appear logged out on some pages; token mismatch | server-authoritative session design; secure cookies or PKCE-native pattern; reauth policy |
| Broken authorization / IDOR / BOLA | APIs, dashboards, internal tools | user changes an ID and sees another user's record; staff sees data outside assigned scope | server-side object-level and function-level authorization on every request |
| Cookie / token misconfiguration | SaaS and finance tools | token exists but not on all pages; SSR and API disagree; logout/login behaves randomly | deliberate cookie domain/path/samesite/secure policy; middleware on every route |
| Payment callback spoofing or replay | payment apps | orders fulfilled from fake callback; repeated webhook causes duplicate credits | verify signatures, compare amount/currency/order ID, enforce idempotency |
| Client-side price/order tampering | checkout flows | altered totals, fake discounts, changed order IDs | server recalculates totals from trusted data |
| Secrets exposure | repos, CI, mobile app, prompts | leaked API keys, hardcoded config, reusable prod creds | secret manager, rotation, scanning, least privilege |
| Logging sensitive data | all products | auth tokens, prompts, PII, card-adjacent data in logs or crash reports | explicit logging policy and field allowlist/denylist |
| Supply-chain compromise | CI/CD, dependencies, models | malicious package, vulnerable library, bad container, poisoned model artifact | dependency policy, SBOM, CI scanning, provenance, signed artifacts where possible |
| Prompt injection | chatbots, agents, RAG | “ignore previous instructions”; hidden instructions in documents or emails | structured prompts, tool scoping, input/output validation, human review |
| Insecure output handling | AI features | model output is passed directly into code, SQL, HTML, or tools | output validation, safe rendering, deterministic parsers |
| Overreliance on AI | support, finance, ops tools | staff trusts wrong model answer; harmful automated action taken | HITL for high-risk actions, confidence rules, audit trail |
| Unrestricted resource consumption / DoS | APIs, LLM endpoints | high cost, latency spikes, failed service, abuse | rate limits, quotas, timeouts, budget ceilings |
| Weak observability | all products | incidents cannot be reconstructed; no idea who did what | request tracing, immutable audit logs, alerts, dashboards |
| Weak incident response | all products | breach detected too late; no triage, rollback, or notification path | runbooks, on-call owner, breach log, restore testing |

---

## 5. Specific diagnosis of your finance-tool login problem

### Brutal assessment
If the “verification token upon login doesn’t transfer across all pages,” the problem is not cosmetic. Your authentication boundary is inconsistent. Until that is fixed, you do not have a trustworthy finance tool.

### Most likely root causes

1. **Cookie attributes are wrong**
   - bad `Domain`, `Path`, `SameSite`, or `Secure` configuration;
   - cookie set on one subdomain but pages load from another;
   - cookie not sent where you think it is.

2. **CORS / credentials mismatch**
   - frontend fetch/XHR is not using credentials;
   - server CORS policy rejects credentialed requests;
   - browser ignores `Set-Cookie` on cross-origin requests.

3. **SSR/CSR split-brain auth**
   - client-side router thinks user is logged in;
   - server-rendered pages or middleware do not read the same auth state;
   - route guards exist only in the client.

4. **Bearer token in localStorage pattern**
   - initial page works because client state is warm;
   - hard refresh, server navigation, or middleware breaks because the server cannot trust/access that state.

5. **Refresh/rotation race conditions**
   - token expires between pages;
   - refresh logic runs too late or inconsistently;
   - multiple tabs overwrite each other.

6. **Middleware coverage gaps**
   - some API routes/pages read auth from one place;
   - others read from another;
   - some routes are effectively unauthenticated.

7. **Cache contamination**
   - CDN or framework caching returns stale unauthenticated or wrong-user content.

### The target state you should move to

For a finance tool, the sane default is:

- use **server-managed session state** or short-lived server-validated session cookies;
- store session identifier or access token in **HttpOnly, Secure cookie**;
- use **SameSite=Lax or Strict** unless a true cross-site flow forces something else;
- run auth middleware on **every page** and **every API route**;
- keep authorization checks on the server, not in the UI;
- if there is refresh logic, make it explicit, deterministic, and observable;
- log auth failures, refresh failures, 401/403 spikes, and route mismatches.

### Debugging checklist for the current bug

1. Inspect the login response and verify the exact `Set-Cookie` headers.
2. Verify whether the cookie is present after login, after navigation, and after hard refresh.
3. Confirm whether cross-origin requests include credentials and whether the server allows them.
4. Check whether pages rendered on the server can access the same session state as API routes.
5. Verify `Domain`, `Path`, `SameSite`, and `Secure` against your actual deployment topology.
6. Check whether refresh token or session rotation runs before protected routes execute.
7. Verify clock skew, expiry windows, and duplicated refresh attempts.
8. Disable caches for protected responses and verify the issue disappears.
9. Test navigation across subdomains, tabs, hard refreshes, logout/login, and expired-session paths.
10. Confirm that unauthorized pages return server-side redirect/401, not just client-side UI hiding.

### Red flag decisions to avoid

Do **not** do these unless you have a very strong, well-tested reason:
- long-lived bearer tokens in `localStorage` for a finance tool;
- auth checks only in frontend route guards;
- hidden form/user IDs trusted without server re-check;
- “temporary” bypasses on internal admin pages.

---

## 6. Authentication and session design standard

### Web standard

Use this as the baseline unless a documented constraint forces otherwise:

- short session lifetime for high-risk areas;
- HttpOnly, Secure cookies;
- restrictive `SameSite` value by default;
- explicit reauthentication for sensitive actions;
- session rotation after login, privilege change, and security-sensitive events;
- server invalidation on logout;
- device/session visibility for users where appropriate;
- alerting on repeated auth anomalies.

### Mobile standard

For mobile/native or hybrid apps:

- use OAuth/native-app best practice with **external browser + PKCE**;
- store secrets/tokens only in platform secure storage such as **Keychain** or **Android Keystore**;
- do not embed login inside insecure WebViews unless you fully understand the tradeoffs and hardening requirements;
- enforce TLS and platform secure networking defaults;
- scrutinize deep links, custom URL schemes, and WebView JS bridges.

### Finance/internal-tool extra rules

For privileged internal finance tools:

- require MFA;
- prefer phishing-resistant options where practical;
- step up auth for exports, approvals, role changes, payment actions, and bulk operations;
- cap session inactivity and overall lifetime;
- keep immutable audit logs for auth events and privileged actions.

---

## 7. Authorization standard

### What most teams get wrong
They authenticate the user once and then stop thinking.
That is how you get IDOR, BOLA, cross-tenant access, and staff overreach.

### Required model

- Deny by default.
- Check authorization at **object level**, **function level**, and **data field level**.
- Multi-tenant products must scope every query by tenant and actor.
- Internal tools need role design, separation of duties, and row-level restrictions.
- Use server-side lookups tied to the authenticated principal, not user-controlled object IDs alone.
- Never trust hidden fields for authorization decisions.

### Finance-tool minimums

- role model documented and reviewed;
- maker-checker / dual control where money or approvals are involved;
- separate read, export, approve, admin, and support permissions;
- break-glass roles heavily logged and time-bounded;
- bulk export/report access limited and monitored.

---

## 8. Payments and money movement standard

### Your safest move
If you can avoid directly handling raw card data, do it.
Use a reputable payment processor’s hosted/tokenized flow to reduce exposure and scope.

### Non-negotiables

- server computes totals, discounts, taxes, order status;
- payment gateway callback/webhook is signature-verified;
- webhook processing is idempotent;
- user redirect page is **informational**, not authoritative;
- amount, currency, order ID, and account mapping are rechecked server-side;
- duplicate callbacks do not create duplicate money movement or fulfillment;
- callback payloads and outcomes are logged for forensics;
- retries are safe;
- fraud/abuse signals are monitored.

### Architecture pattern for payment completion

1. User initiates checkout.
2. Your backend creates order/payment intent from trusted server-side data.
3. User completes payment with processor.
4. Processor sends webhook/callback to your backend.
5. Backend verifies signature and payment status.
6. Backend matches expected amount/currency/order/account.
7. Backend transitions state exactly once.
8. User-facing app polls or reads final server state.

### Things that get companies charged twice or defrauded

- trusting client-return URLs;
- processing the same webhook multiple times;
- letting the client decide the amount;
- not comparing order/account/amount/currency;
- no idempotency key on create/update requests;
- optimistic updates before server verification;
- no replay protection or insufficient timestamp checking.

### Regulatory / market note
If you are in payment flows covered by UK/EU rules, strong customer authentication expectations may apply to online payment initiation, account access, or remote actions that imply fraud risk.

---

## 9. Data protection and privacy standard

### The practical rule
Collect less. Keep less. Expose less. Log less. Retain less.

### What “privacy by design” means in practice

Before building or changing a feature, define:
- what personal data you collect;
- why you collect it;
- who can access it;
- how long you keep it;
- how it is deleted;
- what legal/operational reason justifies that design.

### Minimum controls

- data inventory and classification;
- default least-access configuration;
- encryption in transit and at rest;
- retention schedule by data class;
- deletion/erasure workflows;
- export controls and access logs;
- privacy review for new AI features;
- breach log and notification process.

### Logging rules

Do not log:
- raw auth tokens;
- API secrets;
- password-reset artifacts;
- full prompts/responses containing sensitive data without a policy reason;
- raw payment-sensitive data;
- unnecessary personal data.

### Breach readiness

You need a 72-hour clock discipline, breach log template, technical containment steps, stakeholder notification path, and preserved evidence.

---

## 10. AI application standard

### Rule: treat the model as a powerful but untrusted component
Models are probabilistic. They are not access-control systems, payment verifiers, or legal compliance engines.

### Main AI-specific risks

- prompt injection;
- insecure output handling;
- sensitive information disclosure;
- model denial of service / runaway cost;
- supply-chain/model artifact risk;
- insecure plugin/tool design;
- excessive agency;
- overreliance by users;
- model theft or abuse;
- weak eval coverage.

### Guardrail design for your email chatbot

**Allowed by default**
- summarize inbound content;
- classify/triage;
- suggest replies;
- retrieve approved knowledge;
- hand off to human.

**Not allowed by default**
- silently send emails without explicit authority;
- retrieve arbitrary sensitive records;
- change customer account state;
- execute irreversible actions from free-form model output;
- reveal system prompts, hidden instructions, keys, internal notes, or cross-user data.

### Mandatory controls for AI features

1. **Separate instructions from data**
   - do not concatenate raw user content into system instructions naively;
   - structure prompts so retrieved/user content is treated as data, not command.

2. **Limit tool authority**
   - every tool should have minimal scope;
   - write permissions should be explicit and narrow;
   - high-risk actions should require deterministic approval logic and, often, a human.

3. **Validate output before action**
   - never pass model output directly into SQL, shell, code execution, templates, emails, or payment actions without deterministic validation.

4. **Treat external content as hostile**
   - emails, attachments, docs, code comments, webpages, and RAG documents can all carry indirect prompt injection.

5. **Add human-in-the-loop for high-risk actions**
   - account changes;
   - legal/compliance messaging;
   - payment or finance actions;
   - sensitive customer communications;
   - mass outbound actions.

6. **Instrument evals and production monitoring**
   - measure refusal correctness, policy adherence, tool correctness, hallucination rate proxies, escalation rate, prompt-injection resistance, and user outcome quality.

### Cross-vendor engineering pattern you should copy

- **OpenAI**: eval-driven development, logs mined into datasets, continuous evaluation, and explicit graders.
- **Anthropic**: define measurable success criteria first; simple, composable agent patterns beat unnecessary framework complexity.
- **Google**: define system-level policies, evaluate safety/factuality/fairness, deploy safeguards, and apply SAIF for AI-specific security.
- **Microsoft**: discover, protect, and govern AI apps/data, not just model endpoints.

### Email-chatbot operating model

Use this decision chain:

1. Is the user asking for content generation, retrieval, or action?
2. If retrieval, can the tool access only approved data scopes?
3. If action, is the action reversible, low-risk, and authorized?
4. If not low-risk, require review/approval.
5. Validate the output and record tool calls.
6. If confidence or policy checks fail, escalate to human.

---

## 11. Development process you should standardize now

### Phase 1: design before code
Before building a feature, produce:
- system context diagram;
- trust boundaries;
- data classification;
- threat model;
- abuse cases;
- release evidence requirements.

### Phase 2: build with policy, not improvisation
Every repo should have:
- branch protection;
- code review;
- secret scanning;
- dependency scanning;
- SAST;
- tests for critical flows;
- deployment policy;
- environment separation;
- production access restrictions.

### Phase 3: verify before release
Release evidence should include:
- unit + integration + end-to-end test pass;
- auth/session test pass;
- authorization/object-access tests;
- payment verification/idempotency tests;
- AI eval suite pass for the relevant feature;
- vulnerability scan results reviewed;
- rollback path tested;
- logging/alerting confirmed.

### Phase 4: operate like incidents are inevitable
You need:
- alert thresholds;
- owner on call;
- breach/incident runbooks;
- backup restore tests;
- access review schedule;
- dependency patching SLA;
- postmortem discipline.

---

## 12. CI/CD and supply-chain standard

### Minimum CI/CD security gates

Block merge or release if any of these fail:

- secret leak detected;
- critical dependency vulnerability without accepted exception;
- failing tests on auth, payments, or privileged actions;
- failing AI eval threshold for affected flows;
- unsigned or untraceable build artifact where you expect provenance;
- deployment manifest/config drift outside policy;
- container image with critical unremediated issues;
- missing SBOM for production artifact.

### What you should generate and keep

- SBOM for application artifact;
- dependency inventory;
- build provenance/attestation if your platform supports it;
- artifact hashes;
- release manifest;
- security exceptions register.

### Why this matters
A supply chain is not just code dependencies. It is code, build system, CI, container images, deployment config, model artifacts, and every tool with power over your release path.

---

## 13. Observability, audit, and response standard

### Observability metrics that matter

Track at least:
- login success/failure rate;
- session refresh failures;
- 401/403 trends by route;
- authorization denials by action;
- webhook signature failures;
- duplicate webhook suppression count;
- payment reconciliation mismatches;
- prompt injection detections;
- AI escalation-to-human rate;
- cost spikes / model usage anomalies;
- dependency risk backlog;
- backup restore time;
- mean time to detect / restore.

### Audit log rules for finance/internal tools

Audit logs should record:
- who did what;
- when;
- from where;
- on which object/account/tenant;
- before/after state for sensitive changes where appropriate;
- approval chain for high-risk actions.

They should be:
- append-only or tamper-evident where practical;
- retained per policy;
- queryable for investigations;
- protected from broad admin editing.

### Incident response

Have explicit playbooks for:
- auth/session failure or token leakage;
- payment-webhook fraud or duplicate processing;
- data exposure;
- AI prompt-injection event or unauthorized tool use;
- secret compromise;
- model/output safety failure;
- third-party outage.

For each playbook define:
- trigger;
- owner;
- first 15-minute actions;
- containment;
- rollback/kill-switch;
- communication path;
- evidence to preserve;
- closure/postmortem requirements.

---

## 14. Release gate checklist

Use this before every production release.

| Gate | Release must prove | Block release if |
|---|---|---|
| Architecture | threat model updated; trust boundaries understood | new high-risk flow shipped without review |
| Auth/session | protected pages and APIs behave consistently across refresh/navigation/expiry | token/cookie state inconsistent; logout/login broken |
| Authorization | object-level and function-level checks tested | cross-tenant/object access possible |
| Payments | webhook verification and idempotency tested | duplicate or spoofed completion possible |
| Data protection | retention, access, deletion, logging policy understood | sensitive data exposure path unresolved |
| AI safety | eval thresholds pass; prompt-injection and tool-use tests reviewed | model can trigger unsafe action or leak data |
| Supply chain | dependency/secret scans reviewed; artifact traceability present | critical unresolved issue in release path |
| Operations | alerts, dashboards, rollback, restore path confirmed | no safe recovery path |

---

## 15. Project-specific hardening plan

### A. Customer-facing email chatbot

**Ship only if:**
- knowledge sources are approved and scoped;
- hidden or retrieved hostile content cannot directly override instructions;
- tool permissions are minimal;
- sensitive actions require deterministic checks and human review;
- eval set includes normal, edge, adversarial, and injection cases;
- logs are useful but do not leak sensitive data;
- there is a clear fallback to human support.

**Do next:**
- create a prompt-injection/adversarial test suite;
- add tool-call allowlists;
- add answer-quality and refusal-quality evals;
- separate internal notes from customer-visible response generation;
- review data retention for prompts, outputs, and attachments.

### B. Payment-enabled app (web + mobile)

**Ship only if:**
- auth/session is stable across web/mobile/page refresh/expiry;
- prices and order state are server-calculated;
- payment completion requires verified webhook/server confirmation;
- idempotency exists for all create/update payment operations;
- mobile token storage uses Keychain/Keystore, not plaintext/local app storage;
- privacy, retention, export, and deletion behavior are defined.

**Do next:**
- document exact auth architecture;
- add payment reconciliation checks;
- add duplicate callback and retry tests;
- add mobile network/security testing and deep-link review;
- create incident playbook for payment mismatch or fraud signal.

### C. Internal finance tool

**Ship only if:**
- MFA and role model are in place;
- object-level access control is verified;
- sensitive actions require reauth and/or approvals;
- audit logs are sufficient for investigations;
- exports and admin functions are restricted and monitored;
- session behavior is stable across all pages.

**Do next:**
- replace fragile token pattern with server-authoritative session model;
- add step-up auth for approvals/exports/admin changes;
- add maker-checker where money or approval authority exists;
- add row-level authorization tests;
- run permission review on every role.

---

## 16. What another AI should do with this playbook

The AI you hand this to should not give you a vague audit. It should do the following, in order:

1. map the codebase and identify auth, session, payment, data, AI, and admin flows;
2. build a risk register tied to actual files/routes/components;
3. classify findings into P0/P1/P2 by exploitability and business impact;
4. fix P0 first with minimal, testable patches;
5. add or repair tests for each fixed critical flow;
6. produce a clear diff summary, test summary, and remaining risks;
7. refuse to “fix” by deleting working features or rewriting the app blindly.

It should explicitly check for:
- cookie and token behavior across pages and routes;
- missing server-side authorization;
- insecure payment trust assumptions;
- secret exposure;
- logging of sensitive fields;
- prompt injection and unsafe tool usage;
- weak eval coverage;
- supply-chain weaknesses;
- missing incident and rollback readiness.

---

## 17. Research basis used for this playbook

This report is grounded in a representative set of current primary sources and major industry frameworks, not random blog spam.

### Core software and app security
- OWASP Application Security Verification Standard (ASVS) v5.0.0
- OWASP Top 10:2021
- OWASP API Security Top 10 (API1:2023 through API10:2023)
- OWASP Authentication, Authorization, IDOR, MFA, Threat Modeling, Logging, Secrets Management, Secure Product Design, Software Supply Chain Security, and Third-Party Payment Gateway Integration cheat sheets
- OWASP MASVS / MASTG for mobile controls
- MITRE CWE Top 25 (2025)
- NIST SP 800-218 (SSDF v1.1) and current 2025 draft revision context
- NIST SP 800-218A for generative AI / dual-use foundation model secure development

### AI-specific guidance
- OWASP Top 10 for LLM Applications
- OWASP LLM Prompt Injection Prevention Cheat Sheet
- OWASP Secure AI/ML Model Ops Cheat Sheet
- OWASP AISVS project docs
- NIST AI RMF 1.0 and AI RMF Playbook
- Google SAIF and Responsible Generative AI Toolkit
- OpenAI guidance on practical agent building and evaluation best practices
- Anthropic guidance on building effective agents, defining success criteria, and evaluation workflows
- Microsoft security posture guidance for AI apps and data

### Privacy, auth, and identity
- ICO guidance on integrity/confidentiality, privacy by design/default, and breach handling
- NIST SP 800-63B-4 authentication guidance
- RFC 9700 (OAuth 2.0 Security BCP)
- RFC 8252 (OAuth 2.0 for Native Apps)
- MDN secure cookie guidance and `Set-Cookie` behavior

### Payments
- Stripe webhook signature, replay protection, and idempotency guidance
- FCA Strong Customer Authentication guidance

---

## 18. Final recommendation

Your next-level move is not “add more features and hope security catches up.”
Your next-level move is this:

1. freeze architecture drift;
2. fix auth/session properly;
3. harden authorization and payments;
4. put AI behind guardrails and evals;
5. make release evidence mandatory;
6. instrument the system so failure is visible;
7. only then scale features.

If you do not do that, the product may still work in demos, but you will be building on sand.
