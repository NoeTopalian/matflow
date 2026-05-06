# ChatGPT Prompt — MatFlow Super-Admin Dashboard With Email Login

```text
You are helping me design and generate code for a super-admin dashboard inside an existing multi-tenant SaaS called MatFlow.

I do NOT want a greenfield admin product. I want you to extend and rationalise the admin/operator layer that already exists in this codebase.

Your job is to produce buildable code proposals for a super-admin surface that lets me manage:
- clients / gym tenants
- owner accounts
- members inside a client
- member payments
- client health / setup gaps

This must be a simple, operator-friendly UI. Not bloated. No fake BI dashboard. No invented enterprise complexity.

--------------------------------------------------
PRODUCT CONTEXT
--------------------------------------------------

MatFlow is a multi-tenant gym-management SaaS.

Hierarchy:
- platform operator / super-admin (me, Noe)
- tenant owner (runs one gym)
- members under that tenant

Important:
- I sit ABOVE the tenant owner role
- this is a platform-level operator console
- it must NOT duplicate the normal owner dashboard under /dashboard/*
- it must NOT redesign the member portal under /member/*

The primary goal is:
- see all clients at a glance
- open a client and inspect members, owners, payment state, setup state
- log manual payments against members
- onboard a new client / owner
- manage owner-account recovery and client-level support actions safely

I want the UI to feel:
- white / light themed
- minimal
- fast to scan
- operational, not decorative
- easy to use when I am handling support or onboarding

--------------------------------------------------
CRITICAL AUTH / ROUTING TRUTH
--------------------------------------------------

The current repo already has an /admin area.

Existing /admin surfaces already include:
- /admin
- /admin/tenants
- /admin/tenants/[id]
- /admin/applications
- /admin/activity
- /admin/billing

There are also existing admin/customer actions in some form:
- suspend tenant
- soft-delete tenant
- force owner password reset
- owner TOTP reset
- transfer ownership
- impersonation / login-as-owner

Current truth:
- today, /admin/login is gated by MATFLOW_ADMIN_SECRET
- that secret gate is the v1 bootstrap / recovery path
- there is ALSO an Operator model in the schema that is clearly intended to become the real admin identity system

You must design the revised super-admin auth around a REAL operator login connected to my email, using the existing Operator model as the canonical direction.

That means:
- primary admin login UX = email/password operator login
- optional TOTP if Operator.totpEnabled is true
- operator sessions respect sessionVersion invalidation
- show the signed-in operator identity in the admin header/menu
- include operator logout

BUT:
- do NOT delete the existing MATFLOW_ADMIN_SECRET path conceptually
- treat MATFLOW_ADMIN_SECRET as a bootstrap / fallback / recovery auth path until the operator-login path is fully adopted

--------------------------------------------------
CURRENT SYSTEM TRUTH YOU MUST RESPECT
--------------------------------------------------

1. This is NOT a blank repo.
   The admin area already exists and already has operator pages.

2. The codebase already distinguishes tenant-scoped and cross-tenant access:
- tenant-scoped work uses withTenantContext(tenantId, fn)
- true cross-tenant operator/platform work uses withRlsBypass(fn)

3. Do NOT invent a fake global Prisma access pattern.

4. The current operator identity layer is only partially mature:
- current admin auth is still secret-cookie based
- operator identity today is still partly deferred
- audit identity for operators is still thinner than tenant-user identity

5. There are known platform gaps and risks:
- tenant-scope discipline still matters; never use bare `findUnique({ where: { id } })` for tenant-owned resources
- some routes still leak raw `error.message` back to clients — your routes must NOT do that; return a generic message and log the original server-side
- some payment flows still need stronger transactionality / reconciliation visibility — wrap multi-step money writes in `prisma.$transaction`
- some cross-tenant/member views need pagination and lighter selects — paginate every list, prefer `_count` over loaded relation arrays for summary metrics
- operational visibility is still incomplete: no rich rate-limit-event surface, no reconciliation dashboard, no Sentry/deploy-alert assumptions
- existing tenant-creation route to reuse: `/api/admin/create-tenant` (do not invent a parallel one)

Your design should help close those gaps, not ignore them.

--------------------------------------------------
STACK / CONSTRAINTS
--------------------------------------------------

Use these constraints exactly:

- Next.js 15 App Router
- TypeScript
- Tailwind CSS
- shadcn/ui
- Prisma
- Neon Postgres
- NextAuth v5 patterns where appropriate

The generated code should be consistent with an existing app, not a greenfield template.

Do not invent:
- Redux
- Zustand
- TanStack Query unless clearly justified
- a new ORM
- a new auth provider unrelated to the current stack

--------------------------------------------------
CANONICAL ACCESS PATTERN
--------------------------------------------------

Use these repo-aligned access patterns conceptually:

Tenant-scoped:

```ts
const result = await withTenantContext(tenantId, (tx) =>
  tx.member.findMany({
    where: { tenantId },
  })
);
```

Cross-tenant operator/platform:

```ts
const result = await withRlsBypass((tx) =>
  tx.tenant.findMany({
    where: { deletedAt: null },
  })
);
```

Important rules:
- never use bare findUnique({ where: { id } }) for tenant-owned resources when tenant scope is expected
- tenant-owned resources must stay tenant-scoped
- only true platform/operator queries should bypass RLS

--------------------------------------------------
RELEVANT PRISMA SCHEMA SNIPPETS
--------------------------------------------------

Use these model shapes as canonical. Do not invent new core fields unless you clearly label them as proposed additions.

Tenant:

```prisma
model Tenant {
  id                   String   @id @default(cuid())
  name                 String
  slug                 String   @unique
  logoUrl              String?
  logoSize             String   @default("md")
  primaryColor         String   @default("#3b82f6")
  secondaryColor       String   @default("#2563eb")
  textColor            String   @default("#ffffff")
  bgColor              String   @default("#111111")
  fontFamily           String   @default("'Inter', sans-serif")
  customDomain         String?  @unique
  subscriptionStatus   String   @default("trial")
  subscriptionTier     String   @default("pro")
  onboardingCompleted  Boolean  @default(false)
  onboardingAnswers    Json?
  stripeAccountId      String?
  stripeConnected      Boolean  @default(false)
  stripeAccountStatus  Json?
  currency             String   @default("GBP")
  timezone             String   @default("Europe/London")
  address              String?
  country              String?
  acceptsBacs          Boolean  @default(false)
  memberSelfBilling    Boolean  @default(false)
  billingContactEmail  String?
  billingContactUrl    String?
  privacyContactEmail  String?
  privacyPolicyUrl     String?
  instagramUrl         String?
  facebookUrl          String?
  tiktokUrl            String?
  youtubeUrl           String?
  twitterUrl           String?
  websiteUrl           String?
  waiverTitle          String?
  waiverContent        String?
  kioskTokenHash       String?
  kioskTokenIssuedAt   DateTime?
  featureFlags         Json?
  createdAt            DateTime @default(now())
  deletedAt            DateTime?
}
```

User:

```prisma
model User {
  id                String   @id @default(cuid())
  tenantId          String
  email             String
  passwordHash      String
  name              String
  role              String   @default("admin") // owner | manager | coach | admin
  sessionVersion    Int      @default(0)
  totpSecret        String?
  totpEnabled       Boolean  @default(false)
  totpRecoveryCodes Json?
  failedLoginCount  Int      @default(0)
  lockedUntil       DateTime?
  notifyOnNewLogin  Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([tenantId, email])
}
```

Member:

```prisma
model Member {
  id                       String   @id @default(cuid())
  tenantId                 String
  email                    String
  passwordHash             String?
  name                     String
  phone                    String?
  membershipType           String?
  status                   String   @default("active")
  paymentStatus            String   @default("paid")
  notes                    String?
  onboardingCompleted      Boolean  @default(false)
  sessionVersion           Int      @default(0)
  emergencyContactName     String?
  emergencyContactPhone    String?
  emergencyContactRelation String?
  medicalConditions        String?
  dateOfBirth              DateTime?
  accountType              String   @default("adult")
  waiverAccepted           Boolean  @default(false)
  waiverAcceptedAt         DateTime?
  waiverIpAddress          String?
  stripeCustomerId         String?
  stripeSubscriptionId     String?
  preferredPaymentMethod   String   @default("card")
  lastAnnouncementSeenAt   DateTime?
  parentMemberId           String?
  hasKidsHint              Boolean  @default(false)
  failedLoginCount         Int      @default(0)
  lockedUntil              DateTime?
  classReminders           Boolean  @default(true)
  beltPromotions           Boolean  @default(true)
  gymAnnouncements         Boolean  @default(true)
  notifyOnNewLogin         Boolean  @default(true)
  joinedAt                 DateTime @default(now())
  updatedAt                DateTime @updatedAt

  @@unique([tenantId, email])
  @@index([tenantId, status])
}
```

Payment:

```prisma
model Payment {
  id                    String   @id @default(cuid())
  tenantId              String
  memberId              String?
  stripeInvoiceId       String?  @unique
  stripePaymentIntentId String?  @unique
  stripeChargeId        String?
  amountPence           Int
  currency              String   @default("GBP")
  status                String   // succeeded | failed | refunded | disputed | pending
  description           String?
  paidAt                DateTime?
  refundedAt            DateTime?
  refundedAmountPence   Int?
  failureReason         String?
  createdAt             DateTime @default(now())

  @@index([tenantId, createdAt])
  @@index([memberId, createdAt])
  @@index([tenantId, status])
  @@index([tenantId, paidAt])
}
```

Operator:

```prisma
model Operator {
  id               String   @id @default(cuid())
  email            String   @unique
  name             String
  passwordHash     String
  role             String   @default("super_admin") // super_admin | billing_admin | support_admin | read_only
  totpEnabled      Boolean  @default(false)
  totpSecret       String?
  failedLoginCount Int      @default(0)
  lockedUntil      DateTime?
  sessionVersion   Int      @default(0)
  createdAt        DateTime @default(now())
  lastLoginAt      DateTime?
}
```

--------------------------------------------------
WHAT I WANT YOU TO DESIGN
--------------------------------------------------

Design a super-admin/operator console that extends the current /admin area.

Prefer keeping existing route structure if possible.

If you think the existing operator term should remain “tenants” in routes, keep that.
If you prefer “clients” as a UI label, that is fine, but preserve route compatibility with the existing /admin/tenants area.

Build or revise these surfaces:

1. Operator login
- /admin/login
- email/password login using Operator
- optional TOTP follow-up if Operator.totpEnabled is true
- logout path
- session invalidation via sessionVersion
- show operator identity in header/menu

2. Admin dashboard home
- lightweight platform overview
- key counts and health signals only
- no fake charts
- links into deeper operator views

3. Client / tenant list
- all tenants at a glance
- logo + name prominent
- filters/search
- health badges such as:
  - trial / active / suspended / cancelled
  - Stripe connected / disconnected
  - onboarding complete / incomplete
  - payment-risk indicators where possible

4. Client detail page
- tenant branding/basic info
- owner account info
- members list for that tenant
- recent payment summary
- setup / health gaps
- recovery/support actions

5. Member management inside a client
- member list with pagination
- enough summary fields to support support/admin tasks
- do NOT dump massive member payloads by default

6. Manual payment logger
- simple modal or drawer
- record a manual payment against a member
- built safely and audibly
- do not fake persistence

7. Owner account edit / recovery
- owner name/email review
- clearly separated support actions such as:
  - password reset
  - TOTP reset
  - transfer ownership
- actions should be framed as auditable / operator-only

8. Client health section
- Stripe connection state
- subscription tier / status
- member count
- overdue / failed / refunded / disputed payment clues
- waiver setup completeness
- onboarding completeness
- import/setup status if available

--------------------------------------------------
WHAT NOT TO DESIGN
--------------------------------------------------

Do NOT:
- redesign the owner dashboard under /dashboard/*
- redesign the member app under /member/*
- create a whole IAM platform
- invent analytics that the current DB does not support
- invent schema fields unless you clearly label them as proposed additions
- invent fake APIs and pretend they already exist

--------------------------------------------------
SECURITY / CORRECTNESS / PERFORMANCE RULES
--------------------------------------------------

Your output must respect these rules:

- tenant-owned resources stay tenant-scoped
- cross-tenant reads/writes are only for true operator/platform functions
- paginate member lists
- prefer select / _count / summary queries over heavy includes by default
- do not return raw backend error messages to the UI
- use transactions for multi-step payment writes
- avoid unaudited destructive actions
- assume some current admin helpers may need extension rather than replacement

Design the operator UI to help close real platform gaps:
- client health visibility
- payment exception visibility
- owner recovery/admin actions
- setup completeness
- safe cross-tenant operations

--------------------------------------------------
OUTPUT FORMAT I WANT FROM YOU
--------------------------------------------------

Return:

1. A short architecture summary
2. A route map showing how you are extending the existing /admin area
3. Full file contents for each page / component / route you propose
4. Prisma queries inline in the code
5. One short paragraph per file explaining what it does
6. A final section called:
   - “Repo-aligned and directly implementable”
   - “New work required / helper gaps”

--------------------------------------------------
HONESTY CLAUSE
--------------------------------------------------

This is very important.

If something is ambiguous or unsupported by the schema/context above:
- STOP and FLAG IT clearly in your output
- do NOT silently invent a fake implementation
- it is better to ship a smaller correct proposal with explicit gaps than a larger one that lies

Specifically:
- do not invent a different admin-user table — use the `Operator` model above
- do not invent operator session abstractions, billing-state tables, reconciliation tables, or impersonation flows unless explicitly marked "PROPOSED — NEW WORK REQUIRED"
- do not invent fields on Tenant / User / Member / Payment beyond the canonical snippets above
- do not pretend a helper or API endpoint already exists when you have not been shown it
- if current auth helpers are insufficient, say so clearly under the "New work required / helper gaps" section
- if an existing /admin route should be revised instead of duplicated, prefer revision and call out which file
- preserve the existing `/api/admin/create-tenant` endpoint shape — do not invent a parallel one

--------------------------------------------------
SUCCESS CRITERIA
--------------------------------------------------

The output is successful only if:
- the super-admin UX is tied to a real operator email login (Operator.email + Operator.passwordHash)
- MATFLOW_ADMIN_SECRET remains only a bootstrap/fallback path
- the proposal extends the existing /admin area rather than replacing it blindly
- the Operator model is used as the canonical admin identity
- tenant/client management stays clearly separate from owner/member product flows
- the code feels realistic for this existing repo and stack
- every list query is paginated; no unbounded findMany on Member or Payment
- no route returns a raw `error.message` to the client
- multi-step money writes use `prisma.$transaction`
- no schema field is invented without a "PROPOSED — NEW WORK REQUIRED" label
- the Client Health view exists on `/admin/tenants/[id]` (or chosen detail route) with: Stripe state, owner email + role, recent payment summary, member count, overdue count, waiver completion, onboarding gaps
- output ends with two clearly-labelled sections: "Repo-aligned and directly implementable" and "New work required / helper gaps"

Now produce the design and code.
```

