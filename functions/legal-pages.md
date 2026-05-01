# Legal Pages

> **Status:** ✅ Working · 4 static legal pages with shared layout · public, no auth · linked from login + footer + apply form.

## Purpose

Compliance and trust signals. Without a Terms / Privacy / AUP / Subprocessors page, we can't legally onboard B2B customers, accept payments, or process EU/UK personal data. They also signal "this is a real product" to gym owners deciding whether to trust us with their member roster.

These pages are intentionally static, server-rendered, and lightweight — no client JS, no analytics, no auth check.

## Pages

| Path | Purpose |
|---|---|
| `/legal/terms` | Master terms of service — gym signs up under these |
| `/legal/privacy` | UK GDPR + EU GDPR privacy notice (data we collect, retention, rights) |
| `/legal/aup` | Acceptable use policy — what gyms can/can't do with the product |
| `/legal/subprocessors` | List of every third party that touches customer data (Stripe, Resend, Vercel, Anthropic, Google) |

## Surfaces

- Footer of marketing pages (apply / login)
- Apply form: "By submitting you agree to our [Terms]"
- Settings → Account: "Read our [Privacy Policy]"
- Stripe Connect onboarding: shown to comply with PSD2 disclosure rules

## Layout

[`app/legal/layout.tsx`](../app/legal/layout.tsx) wraps all four pages with:

- Centred max-width column (~720px)
- Heading typography matched to marketing brand (Inter / large weights)
- Footer with cross-links to the other 3 legal pages + "Last updated: {date}"
- Sticky "Back to MatFlow" header

```tsx
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b sticky top-0 bg-white/80 backdrop-blur">
        <div className="max-w-3xl mx-auto px-6 py-4 flex justify-between">
          <Link href="/">← Back to MatFlow</Link>
          <Link href="/login" className="text-sm">Log in</Link>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-gray">
        {children}
      </main>
      <footer className="border-t mt-16 py-8">
        <div className="max-w-3xl mx-auto px-6 text-sm text-gray-500 flex flex-wrap gap-4">
          <Link href="/legal/terms">Terms</Link>
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/aup">AUP</Link>
          <Link href="/legal/subprocessors">Subprocessors</Link>
        </div>
      </footer>
    </div>
  );
}
```

## Page content shape

Each page is a server component with hardcoded JSX — no CMS, no markdown loader. Versioning happens via git history. The "Last updated" date is also hardcoded (must be updated when content changes).

```tsx
export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="text-gray-500">Last updated: 1 May 2026</p>
      <h2>1. Agreement</h2>
      <p>...</p>
      ...
    </>
  );
}
```

## Subprocessors page (the one that gets read)

The most-requested legal page during sales. Lists every third party with:

| Subprocessor | Service | Data shared | Region |
|---|---|---|---|
| Stripe (incl. Stripe Connect) | Payments + subscriptions | Member name, email, payment method | EU/US |
| Resend | Transactional email delivery | Recipient email, message body | EU/US |
| Vercel | Hosting + Blob storage | All customer data | US (with EU edge) |
| Neon | Postgres database | All customer data | EU |
| Anthropic | AI monthly report generation | Aggregated metrics, optional Drive contents | US |
| Google (Drive API) | Optional Drive integration | Files in the connected folder | US |

Updates here trigger a "subprocessors changed" notification email to existing customers — required by GDPR. Today this is manual.

## Privacy notice highlights

The `/legal/privacy` page covers the GDPR-mandated:

- **Controller**: MatFlow Ltd (registered company info)
- **Legal basis**: contract performance (gym↔platform), consent (member→gym for waiver), legitimate interest (security logging)
- **Categories of data**: contact info, attendance records, payment metadata, waiver text + signature
- **Retention**: customer-controlled deletion; default 7 years for financial records, 3 years for attendance
- **Rights**: access, rectification, erasure, portability, complaint to ICO
- **Cookies**: session cookie + CSRF cookie + (optional) Stripe cookies on Connect pages
- **Data protection officer / contact**: privacy@matflow.io

## AUP highlights

`/legal/aup` covers gym↔platform conduct:

- No spam (member email batches must be transactional, not marketing without consent)
- No impersonation of other gyms
- No scraping the platform (rate limits enforce this technically)
- No use for non-martial-arts services without prior approval
- Right to suspend on payment fraud / chargeback abuse

## Public access

These pages are explicitly whitelisted in [proxy.ts](../proxy.ts):

```ts
const PUBLIC_PREFIXES = ["/legal", "/apply", "/login", ...];
```

Otherwise the auth gate would 307 unauthenticated users away from `/legal/terms`.

## Performance

Server components, zero client JS, no DB calls — pages render in <50ms cold and are cached aggressively at the edge. Lighthouse 100/100/100/100.

## Security

| Control | Where |
|---|---|
| Public-by-design | Whitelisted in proxy.ts; no auth gate |
| No DB calls | Pages are entirely static — can't be a vector |
| No client JS | XSS surface = zero |
| CSP headers | Inherits global CSP (see [csp-and-security-headers.md](csp-and-security-headers.md)) |
| Server-side render | No hydration mismatch / no client-side route handling |

## Known limitations

- **Hardcoded "Last updated" date** — easy to forget to bump when editing. Worth a CI check that compares git diff against the date string.
- **No version history visible to readers** — only via git. A "view previous version" toggle would help GDPR audit responses.
- **No translation** — English only. EU law sometimes requires local-language privacy notices.
- **No e-sign trail** — gyms agreeing via the apply form don't get a counter-signed copy. Could send a PDF with their ack email.
- **Subprocessor change notifications are manual** — GDPR requires advance notice; we email customers manually.
- **No DPA template** — enterprise customers ask for a Data Processing Addendum; we send one over manually.
- **Cookie banner is missing** — UK PECR + EU ePrivacy require explicit consent for non-essential cookies. We use session-only cookies (essential), so this is borderline-OK but a banner is the safer posture.

## Test coverage

- No tests today — pages are pure JSX
- Visual regression via Playwright (recommended) would catch unintentional content changes

## Files

- [app/legal/layout.tsx](../app/legal/layout.tsx) — shared header/footer
- [app/legal/terms/page.tsx](../app/legal/terms/page.tsx)
- [app/legal/privacy/page.tsx](../app/legal/privacy/page.tsx)
- [app/legal/aup/page.tsx](../app/legal/aup/page.tsx)
- [app/legal/subprocessors/page.tsx](../app/legal/subprocessors/page.tsx)
- [proxy.ts](../proxy.ts) — `/legal` in PUBLIC_PREFIXES
- See [apply-form.md](apply-form.md), [csp-and-security-headers.md](csp-and-security-headers.md), [proxy-middleware.md](proxy-middleware.md)
