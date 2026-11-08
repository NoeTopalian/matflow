// /[slug] — a club's short URL, e.g. matflow.studio/totalbjj.
//
// T9c (Q9, Noe 17 Oct 2026): an OPT-IN public club page. Each club decides in
// Settings → Public page; it is OFF for every club by default.
//
//  - OFF (and every non-published state): exactly the 23 Sep 2026 behaviour —
//    the short URL is the club's login door and redirects to the branded
//    sign-in screen (/login?club=<slug>).
//  - ON: a public, indexable, dark tenant-branded page with the club's live
//    timetable, the prices the owner chose to show, and Join / Member login.
//
// ENUMERATION DISCIPLINE
// ----------------------
// Unknown, not opted in, suspended, cancelled and deleted clubs — and a failed
// lookup — all get the SAME response: the redirect above, with the same
// noindex metadata. Only a published, admitted club differs, and publishing is
// the owner's deliberate choice to be found. The by-slug read is one
// select-only lookup with fixed fields (lib/public-club-page-server.ts);
// tests/unit/public-club-page-response-matrix.test.ts pins the matrix.
//
// A reserved segment (app/dashboard, app/login, …) never reaches here — Next's
// router prefers the real folder, and isReservedSlug is a second pinned guard
// (tests/unit/public-club-slug-reserved.test.ts).
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/auth";
import { getPublishedClubPage, previewClubPageFor } from "@/lib/public-club-page-server";
import {
  NOT_PUBLISHED_METADATA,
  clubJsonLd,
  clubMetadata,
  isNonClubSlug,
  normaliseClubSlug,
  serialiseJsonLd,
  type PublicClubPage,
} from "@/lib/public-club-page";
import { FONT_IMPORTS, extractFontName, isSafeFontFamily } from "@/lib/fonts";
import { hex, readableOn, legibleInk, isHexColor, DEFAULT_TENANT_PRIMARY, DEFAULT_TENANT_BG } from "@/lib/color";
import PublicTimetable from "@/components/public-club/PublicTimetable";
import { getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

/** The visitor's IP, for the gate's per-IP cache-miss budget. */
async function visitorIp(): Promise<string> {
  return getClientIp({ headers: await headers() });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const normalised = normaliseClubSlug(slug);
  if (isNonClubSlug(normalised)) return NOT_PUBLISHED_METADATA;
  const page = await getPublishedClubPage(normalised, await visitorIp());
  if (!page) return NOT_PUBLISHED_METADATA;
  return clubMetadata(page);
}

export default async function ClubSlugPage({
  params,
  searchParams,
}: Params & { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  const normalised = normaliseClubSlug(slug);

  if (isNonClubSlug(normalised)) notFound();

  const page = await getPublishedClubPage(normalised, await visitorIp());
  if (page) return <PublicClubView page={page} />;

  // Owner preview (Settings → Public page → Preview): the signed-in owner of
  // THIS club may see the page before switching it on. Anyone else — and
  // every anonymous visitor, ?preview or not — falls through to the same
  // redirect as an unknown slug. The metadata above is already noindex for a
  // page that is not published.
  const sp = await searchParams;
  if (sp.preview === "1") {
    const session = await auth();
    // proxy.ts passes a bare slug through before its second-factor and
    // forced-password-change gates, so they are applied here: a half
    // signed-in owner session is not the authenticated owner.
    const user = session?.user;
    if (user?.id && user.role === "owner" && !user.totpPending && !user.mustChangePassword) {
      const preview = await previewClubPageFor(normalised, user.tenantId);
      if (preview) return <PublicClubView page={preview} preview />;
    }
  }

  // Not published (or not a club): the login door, as before T9c.
  redirect(`/login?club=${encodeURIComponent(normalised)}`);
}

const LOGO_HEIGHT: Record<string, string> = { sm: "h-12", md: "h-16", lg: "h-24" };

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

function PublicClubView({ page, preview = false }: { page: PublicClubPage; preview?: boolean }) {
  const primary = isHexColor(page.primaryColor) ? page.primaryColor : DEFAULT_TENANT_PRIMARY;
  const bg = isHexColor(page.bgColor) ? page.bgColor : DEFAULT_TENANT_BG;
  const fontFamily = isSafeFontFamily(page.fontFamily) ? page.fontFamily : "'Inter', sans-serif";
  const fontUrl = FONT_IMPORTS[extractFontName(fontFamily)];
  const ink = readableOn(bg);
  const accentInk = legibleInk(primary, bg);
  const onPrimary = readableOn(primary);
  const line = hex(ink, 0.12);
  const panel = hex(ink, 0.04);

  const loginHref = `/login?club=${encodeURIComponent(page.slug)}`;
  // There is no member self-sign-up path in MatFlow, so "Join / book a trial"
  // goes to whatever contact the club published — never an invented form. No
  // published contact, no button.
  const joinHref = page.email
    ? `mailto:${page.email}?subject=${encodeURIComponent(`Booking a trial at ${page.name}`)}`
    : page.phone
      ? telHref(page.phone)
      : page.websiteUrl;

  const hasContact = !!(page.email || page.phone || page.address || page.websiteUrl || page.socials.length);

  return (
    <main
      className="min-h-screen w-full antialiased"
      style={{
        background: bg,
        fontFamily,
        color: ink,
        // Staff-token bridge, as in app/member/layout.tsx: the shared
        // primitives (Select, Button) are written against the staff surface
        // tokens and would paint a white control on this dark tenant shell.
        ["--sf-1" as string]: bg,
        ["--sf-2" as string]: hex(ink, 0.06),
        ["--tx-1" as string]: ink,
        ["--tx-2" as string]: hex(ink, 0.75),
        ["--tx-3" as string]: hex(ink, 0.65),
        ["--bd-default" as string]: line,
        ["--bd-hover" as string]: hex(ink, 0.2),
        ["--bd-active" as string]: hex(ink, 0.3),
        ["--color-primary" as string]: primary,
        ["--tx-on-accent" as string]: onPrimary,
      }}
      data-testid="public-club-page"
    >
      {/* Runtime tenant colour — the sanctioned exception to UI-RULES §2's
          "no new hex literals" ban, as on the login and kiosk surfaces. The
          font is a live <link> because the face is chosen per club at request
          time. */}
      {fontUrl && <link rel="stylesheet" href={fontUrl} />}
      {/* Structured data, not a script: ld+json is never executed. `<` is
          escaped per Next's JSON-LD guide. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serialiseJsonLd(clubJsonLd(page)) }} />

      {preview && (
        <p
          role="status"
          className="w-full px-4 py-2.5 text-center text-xs font-semibold"
          style={{ background: hex(primary, 0.18), color: ink }}
          data-testid="public-club-preview-banner"
        >
          Preview — only you can see this. Switch the public page on in Settings to publish it.
        </p>
      )}
      <div className="mx-auto w-full max-w-[880px] px-4 pb-12 pt-10 sm:px-6">
        <header className="flex flex-col items-center text-center">
          {page.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              // A published page points at the cacheable logo route rather
              // than inlining the base64 (which would ship twice, in the HTML
              // and the RSC payload, on every anonymous view and crawl). The
              // route 404s for an unpublished club, so the owner's preview
              // keeps the inline value.
              src={preview ? page.logoDataUrl : `/api/tenant/${encodeURIComponent(page.slug)}/logo`}
              alt={`${page.name} logo`}
              className={`mb-6 w-auto object-contain ${LOGO_HEIGHT[page.logoSize] ?? LOGO_HEIGHT.md}`}
              style={{ maxWidth: "240px" }}
            />
          ) : (
            <div
              aria-hidden="true"
              className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl text-2xl font-black"
              style={{ background: hex(primary, 0.16), color: accentInk, border: `1.5px solid ${hex(primary, 0.28)}` }}
            >
              {page.name.charAt(0).toUpperCase()}
            </div>
          )}
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{page.name}</h1>
          {page.description && (
            <p className="mt-3 max-w-[60ch] whitespace-pre-line text-sm leading-relaxed" style={{ opacity: 0.75 }}>
              {page.description}
            </p>
          )}
          <div className="mt-7 flex w-full max-w-[420px] flex-col gap-3 sm:flex-row">
            {joinHref && (
              <a
                href={joinHref}
                className="inline-flex flex-1 items-center justify-center rounded-xl px-5 py-3.5 text-sm font-semibold transition-opacity hover:opacity-90"
                // The border keeps the main call to action visible when the
                // club's primary matches its background (UI-RULES §2a).
                style={{ background: primary, color: onPrimary, border: `1px solid ${hex(ink, 0.24)}` }}
                data-testid="public-club-join"
              >
                Join / book a trial
              </a>
            )}
            <a
              href={loginHref}
              className="inline-flex flex-1 items-center justify-center rounded-xl border px-5 py-3.5 text-sm font-semibold transition-opacity hover:opacity-90"
              style={{ borderColor: hex(ink, 0.24), color: ink }}
              data-testid="public-club-login"
            >
              Member login
            </a>
          </div>
        </header>

        {page.sessions.length > 0 && (
          <section className="mt-12" aria-labelledby="timetable-heading">
            <h2 id="timetable-heading" className="text-lg font-semibold">Weekly timetable</h2>
            <PublicTimetable sessions={page.sessions} ink={ink} accent={accentInk} line={line} panel={panel} />
          </section>
        )}

        {page.tiers.length > 0 && (
          <section className="mt-12" aria-labelledby="prices-heading">
            <h2 id="prices-heading" className="text-lg font-semibold">Membership</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2" data-testid="public-club-tiers">
              {page.tiers.map((t) => (
                <li key={t.key} className="rounded-2xl border p-4" style={{ borderColor: line, background: panel }}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-semibold">
                      {t.name}
                      {t.isKids && (
                        <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: accentInk }}>
                          Kids
                        </span>
                      )}
                    </p>
                    <p className="shrink-0 text-sm font-semibold tabular-nums">{t.price}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {hasContact && (
          <section className="mt-12" aria-labelledby="contact-heading">
            <h2 id="contact-heading" className="text-lg font-semibold">Find us</h2>
            <dl className="mt-4 grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
              {page.address && (
                <>
                  <dt style={{ opacity: 0.6 }}>Address</dt>
                  <dd className="whitespace-pre-line">{page.address}</dd>
                </>
              )}
              {page.email && (
                <>
                  <dt style={{ opacity: 0.6 }}>Email</dt>
                  <dd className="break-all"><a className="underline underline-offset-2" href={`mailto:${page.email}`}>{page.email}</a></dd>
                </>
              )}
              {page.phone && (
                <>
                  <dt style={{ opacity: 0.6 }}>Phone</dt>
                  <dd><a className="underline underline-offset-2" href={telHref(page.phone)}>{page.phone}</a></dd>
                </>
              )}
              {page.websiteUrl && (
                <>
                  <dt style={{ opacity: 0.6 }}>Website</dt>
                  <dd className="break-all">
                    <a className="underline underline-offset-2" href={page.websiteUrl} rel="noopener noreferrer" target="_blank">
                      {page.websiteUrl.replace(/^https:\/\//, "").replace(/\/$/, "")}
                    </a>
                  </dd>
                </>
              )}
              {page.socials.length > 0 && (
                <>
                  <dt style={{ opacity: 0.6 }}>Social</dt>
                  <dd className="flex flex-wrap gap-x-4 gap-y-1">
                    {page.socials.map((s) => (
                      <a key={s.label} className="underline underline-offset-2" href={s.href} rel="noopener noreferrer" target="_blank">
                        {s.label}
                      </a>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </section>
        )}

        <footer className="mt-16 text-center text-xs" style={{ opacity: 0.65 }}>
          Powered by MatFlow
        </footer>
      </div>
    </main>
  );
}
