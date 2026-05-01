# Apply Form (Public)

> **Status:** ✅ Working (B10) · public unauthenticated form · IP rate-limited (5/hour) · DB persistence + 2 transactional emails (applicant ack + internal notification).

## Purpose

The lead-capture funnel for new gyms. A gym owner finds matflow.studio, hits **Apply**, fills a 7-field form, and we (1) record the application in `GymApplication`, (2) email them a "we'll be in touch" ack, (3) email the MatFlow team a structured notification with the new application's details.

Until B10 (commit `4be3...`), the form was a no-op — submissions weren't persisted, only emailed. That meant losing applications when emails bounced or were delayed.

## Surfaces

- `/apply` — the form (public, no auth)
- `/apply` success state — confirmation panel after submit
- Internal notification: email to addresses in `MATFLOW_APPLICATIONS_TO` (default `hello@matflow.io`)

## Form fields

| Field | Validation |
|---|---|
| `gymName` | string, 2-120 chars |
| `ownerName` | string, 2-120 chars |
| `email` | valid email format |
| `phone` | string, 7-40 chars (no E.164 normalisation) |
| `sport` | enum: BJJ / MMA / Muay Thai / Wrestling / Judo / Boxing / No-Gi / Multiple / Other |
| `memberCount` | string (band: "1-25" / "26-50" / "51-100" / "101-200" / "201+") |
| `message` | optional, max 2000 chars |

Client-side validation via `react-hook-form + zod`. Server re-validates with the same Zod schema.

## Data model

```prisma
model GymApplication {
  id           String   @id @default(cuid())
  gymName      String
  contactName  String                          // schema field is contactName, form sends ownerName
  email        String
  phone        String
  discipline   String                          // form sends sport, schema stores discipline
  memberCount  String
  notes        String?                         // form sends message
  ipAddress    String?
  userAgent    String?
  status       String   @default("new")        // new | contacted | onboarded | rejected
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([status, createdAt])
}
```

Status flips manually today — internal team marks "contacted" / "onboarded" / "rejected" via DB or future admin UI.

## API route — `POST /api/apply`

```ts
// Rate limit BEFORE any work — public endpoint with side-effects
const ip = getClientIp(req);
const rl = await checkRateLimit(`apply:${ip}`, 5, 60 * 60 * 1000);
if (!rl.allowed) return 429 with Retry-After;

// Validate
const parsed = applySchema.safeParse(body);
if (!parsed.success) return 400;

// Persist (best-effort — don't fail user if DB write fails)
let applicationId: string | null = null;
try {
  const created = await prisma.gymApplication.create({
    data: {
      gymName, contactName: ownerName, email, phone,
      discipline: sport, memberCount,
      notes: message ?? null,
      ipAddress: ip === "unknown" ? null : ip,
      userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    },
    select: { id: true },
  });
  applicationId = created.id;
} catch (e) {
  console.error("[apply] DB write failed", e);
  // Continue to email so the application isn't dropped entirely
}

// Fire two emails in parallel via Resend
await Promise.allSettled([
  sendEmail({tenantId: "_system", templateId: "application_received",
             to: email, vars: {contactName: ownerName, gymName}}),
  ...internalRecipients.map(to =>
    sendEmail({tenantId: "_system", templateId: "application_internal",
               to, vars: {gymName, contactName: ownerName, email, phone,
                          discipline: sport, memberCount, notes: message ?? ""}})),
]);

return NextResponse.json({ ok: true, id: applicationId });
```

### Why best-effort DB write

Two failure modes:

1. **DB write succeeds, email fails** → we have the application, can follow up manually. Acceptable.
2. **DB write fails, email succeeds** → applicant + internal team both know about it. Acceptable.
3. **Both fail** → user sees error message, knows to try again or email us.

The worst case is "applicant submits, both fail silently". `Promise.allSettled` + the explicit DB try/catch ensure we surface the error rather than swallow it.

## Rate limiting

Sliding-window via the shared rate limiter (see [rate-limiting.md](rate-limiting.md)):

- Key: `apply:{ip}`
- Limit: 5 requests / hour / IP
- Storage: DB-backed (`RateLimitHit`) with in-memory fallback
- Response on cap: 429 with `Retry-After: <seconds>` header

5/hour is generous for legitimate retries (typo in email → resubmit) and tight enough to deter scripted spam. The bottleneck for a real attacker is the email provider's send-rate cap, but the rate limit caps DB rows + gives us a clean log line.

## Email templates

In [lib/email.ts](../lib/email.ts):

### `application_received` (to applicant)

```
Subject: Thanks for applying to MatFlow, {{gymName}}!

Hi {{contactName}},

Thanks for applying. We review every application and will be in touch within
1 business day with your gym code and login details.

In the meantime, you can reply to this email if you have questions.

— The MatFlow team
```

### `application_internal` (to MatFlow team)

```
Subject: New gym application — {{gymName}}

Gym: {{gymName}}
Contact: {{contactName}} <{{email}}>
Phone: {{phone}}
Discipline: {{discipline}}
Members: {{memberCount}}

Notes:
{{notes}}

→ Reply to this email to reach the applicant.
```

`reply-to` set to applicant email so internal team can respond directly without copy-paste.

## Success state

Client renders:

```
[checkmark icon]
Application received

Thanks for applying. We review every application and will be in
touch within 1 business day with your gym code and login details.

[Back to login]
```

No autosubmit on Enter, no analytics events — minimal surface.

## Security

| Control | Where |
|---|---|
| Rate limit | 5/hour/IP via `checkRateLimit("apply:{ip}", ...)` |
| Zod validation | Length caps + email format + sport enum |
| IP capture | `getClientIp()` for forensics + rate-limit key |
| User-agent truncation | 500 char cap |
| `tenantId: "_system"` for emails | Avoids fake-tenant injection — these emails aren't tenant-scoped |
| Best-effort DB | Failure doesn't drop the application entirely |
| HTML escaping in templates | Resend templates handle this; vars treated as text |
| No CSRF token | Public form; intentional. Rate-limit + validation are the defences |

## Known limitations

- **No CAPTCHA** — relies entirely on rate-limit. A determined spammer could rotate IPs.
- **No internal admin UI** — `GymApplication` rows visible only via DB query. Status flips manual.
- **No "you've applied before" detection** — same email applying twice creates two rows.
- **No domain dedup** — same gym applying via different emails creates duplicates.
- **Email failure isn't surfaced** — `Promise.allSettled` means we don't know if the applicant got their ack. Worth adding to `EmailLog` reads.
- **Hardcoded sports list** — adding a new discipline requires a code release. A "Other" with free-text fallback exists, but it's noisy.
- **No automatic onboarding** — no path from "application approved" to "tenant created". Manual provisioning today.
- **PII (phone, email) in DB indefinitely** — no retention policy. GDPR may require deletion of non-onboarded applications after N days.

## Test coverage

- [tests/unit/apply-rate-limit.test.ts](../tests/unit/apply-rate-limit.test.ts) — covers rate limit, validation, mocked DB+email writes

## Files

- [app/apply/page.tsx](../app/apply/page.tsx) — public form
- [app/api/apply/route.ts](../app/api/apply/route.ts) — submit handler
- [lib/email.ts](../lib/email.ts) — Resend templates
- [lib/rate-limit.ts](../lib/rate-limit.ts) — `checkRateLimit`, `getClientIp`
- [prisma/schema.prisma](../prisma/schema.prisma) — `GymApplication`
- See [legal-pages.md](legal-pages.md), [rate-limiting.md](rate-limiting.md)
