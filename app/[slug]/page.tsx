// /[slug] — public club page for ANY tenant, e.g. matflow.studio/totalbjj.
//
// Anonymous, no session required. This is the front door a prospective
// member reaches from a poster, a Google search or a shared link, before
// they have any reason to know MatFlow exists.
//
// THE 404 DISCIPLINE IS COPIED FROM app/api/tenant/[slug]/route.ts:48-92,
// DELIBERATELY, NOT IMPORTED.
// -----------------------------------------------------------------------
// That route already gets this right: normalise the slug, look the tenant up
// with `withRlsBypass` (there is no session yet, so no RLS context exists),
// and treat "does not exist", "soft-deleted", "cancelled" and "suspended"
// as the SAME notFound() — different responses for each would let someone
// enumerate which clubs are real, which have closed their account and which
// have stopped paying, none of which is this page's business to disclose.
// The logic is duplicated rather than fetched over HTTP from this server
// component, because that would mean building an absolute URL for a
// same-process request and paying a second network hop for data one Prisma
// call already has.
//
// PROXY.TS ROUTING RISK (flagged for the lead, not fixed here — proxy.ts is
// a shared/coordination file this track does not touch):
// `/[slug]` is NOT in `PUBLIC_PREFIXES` in proxy.ts, and it is not the root
// `/`. An unauthenticated visitor hitting `/totalbjj` today is 307-redirected
// to `/login` by the proxy BEFORE this page ever renders — the middleware
// runs ahead of Next's own router and has no idea `app/[slug]/page.tsx`
// exists. This page is inert for anonymous traffic until proxy.ts adds a
// public allowance for it. See the report for the exact change needed.
//
// RESERVED-SLUG GUARD
// --------------------
// Next's router already prefers a literal folder (`app/dashboard`,
// `app/login`, …) over this dynamic segment, so a request to `/dashboard`
// never reaches this file in the first place — that is normal Next.js
// routing precedence, not something this file arranges. RESERVED_SLUGS below
// is a second, independent guard: it stops a tenant's OWN slug from ever
// being treated as a public page for a name that could never be a real club
// (including `leaderboard`, which has no route today but is named in the
// build brief as one to keep clear), and it means this page's DB lookup never
// even runs for one of these names. Covered by
// tests/unit/public-club-slug-reserved.test.ts.
import { notFound } from "next/navigation";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { FONT_IMPORTS, extractFontName, isSafeFontFamily } from "@/lib/fonts";
import { hex, readableOn, isHexColor, DEFAULT_TENANT_PRIMARY, DEFAULT_TENANT_BG } from "@/lib/color";

export const dynamic = "force-dynamic";

// The reserved list lives in an edge-safe module so proxy.ts can share it
// without importing this page (which would drag Prisma into the edge runtime).
// Re-exported here so existing importers keep working.
export { RESERVED_SLUGS, isReservedSlug } from "@/lib/reserved-slugs";
import { isReservedSlug } from "@/lib/reserved-slugs";

export default async function PublicClubPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const normalised = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");

  if (!normalised || isReservedSlug(normalised)) notFound();

  // Public lookup: caller has no session, so RLS context isn't available.
  // Bypass is intentional — the slug is a deliberate identifier the visitor
  // already has (from a link, a poster, a search result), and the response
  // below carries only public branding.
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { slug: normalised },
      select: {
        name: true,
        logoUrl: true,
        primaryColor: true,
        secondaryColor: true,
        textColor: true,
        bgColor: true,
        fontFamily: true,
        subscriptionStatus: true,
        deletedAt: true,
      },
    }),
  );

  // Soft-deleted, cancelled or suspended must look identical to "no such
  // club" — same notFound(), no distinguishing signal. See the file header.
  if (
    !tenant ||
    tenant.deletedAt !== null ||
    tenant.subscriptionStatus === "cancelled" ||
    tenant.subscriptionStatus === "suspended"
  ) {
    notFound();
  }

  const primary = isHexColor(tenant.primaryColor) ? tenant.primaryColor : DEFAULT_TENANT_PRIMARY;
  const bg = isHexColor(tenant.bgColor) ? tenant.bgColor : DEFAULT_TENANT_BG;
  const fontFamily = isSafeFontFamily(tenant.fontFamily) ? tenant.fontFamily : "'Inter', sans-serif";
  const fontName = extractFontName(fontFamily);
  const fontUrl = FONT_IMPORTS[fontName];
  const onPrimary = readableOn(primary);

  return (
    <main
      className="min-h-screen w-full antialiased"
      style={{ background: bg, fontFamily, color: readableOn(bg) }}
    >
      {/* Runtime tenant colour — the sanctioned exception to UI-RULES §2's
          "no new hex literals" ban, same as the kiosk and login public
          surfaces. The font import is a live <link>, not next/font, because
          the face is chosen per-tenant at request time. */}
      {fontUrl && <link rel="stylesheet" href={fontUrl} />}

      <div className="mx-auto flex min-h-screen w-full max-w-[520px] flex-col px-4 py-10">
        <header className="flex flex-col items-center text-center">
          {tenant.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={tenant.logoUrl}
              alt={tenant.name}
              className="mb-6 h-16 w-auto object-contain"
              style={{ maxWidth: "220px" }}
            />
          ) : (
            <div
              className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-black"
              style={{
                background: hex(primary, 0.16),
                color: primary,
                border: `1.5px solid ${hex(primary, 0.28)}`,
              }}
            >
              {tenant.name.charAt(0).toUpperCase()}
            </div>
          )}
        </header>

        <section className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{tenant.name}</h1>
          <p className="mt-3 text-sm opacity-70">
            Train with {tenant.name}. Get in touch to book a trial class or ask about membership.
          </p>

          <a
            href={`mailto:hello@matflow.studio?subject=${encodeURIComponent(
              `Enquiry about joining ${tenant.name}`,
            )}`}
            className="mt-8 inline-flex w-full max-w-[280px] items-center justify-center rounded-xl px-6 py-4 text-sm font-semibold transition-opacity hover:opacity-90"
            style={{ background: primary, color: onPrimary }}
          >
            Join / enquire
          </a>
        </section>

        {/* Honest placeholder: this club may not have published a timetable
            in MatFlow yet, and UI-RULES §7 forbids inventing one to fill the
            space. No class names, no times, no days — just the true state. */}
        <section
          className="mb-6 rounded-2xl border p-5 text-center text-sm"
          // readableOn(bg) is already the correctly-contrasted text colour for
          // this background (white on dark, dark slate on light) — tinting the
          // border with that SAME colour is simpler than re-deriving a second
          // ON_LIGHT/ON_DARK pair, and adds no new literal (UI-RULES §11).
          style={{ borderColor: hex(readableOn(bg), 0.12) }}
        >
          <p className="font-semibold" style={{ opacity: 0.85 }}>
            Timetable
          </p>
          <p className="mt-1" style={{ opacity: 0.6 }}>
            This club hasn&rsquo;t published a class timetable here yet — enquire above for
            current session times.
          </p>
        </section>

        <footer className="mt-auto pt-6 text-center text-xs" style={{ opacity: 0.35 }}>
          Powered by MatFlow
        </footer>
      </div>
    </main>
  );
}
