// /[slug] — a club's short URL, e.g. matflow.studio/totalbjj.
//
// DIRECTIVE (Noe, 2026-09-23): the club's short URL IS its login door — not a
// public marketing page. Hitting /totalbjj drops the visitor straight onto that
// club's BRANDED email/password screen, skipping the "enter your club code"
// step. This replaces the earlier public club page; the login page reads the
// `?club=` parameter and swaps step 1 for the branded login (app/login/page.tsx).
//
// ENUMERATION DISCIPLINE
// ----------------------
// We do NOT look the club up here anymore, and that is deliberately SAFER than
// the old public page: every non-reserved single segment now redirects to
// /login?club=<slug> regardless of whether the club exists, is paused, or is
// closed. So there is no longer any difference in this route's response between
// a real active club and an unknown/suspended one — the old page rendered a
// branded page only for a real active club, which was itself a weak oracle.
// The branded-vs-unbranded decision, and the honest "your club is paused"
// message, are made downstream by the login page + /api/tenant/[slug] (which
// still 404s every non-public state identically). A reserved segment
// (app/dashboard, app/login, …) never reaches here — Next's router prefers the
// real folder, and isReservedSlug is a second pinned guard
// (tests/unit/public-club-slug-reserved.test.ts).
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

import { isReservedSlug } from "@/lib/reserved-slugs";

export default async function ClubSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Same one-line normalise the tenant lookup + reserved guard already use.
  const normalised = slug.toLowerCase().replace(/[^a-z0-9-]/g, "");

  if (!normalised || isReservedSlug(normalised)) notFound();

  // The club URL is the login door: hand off to the branded sign-in screen.
  redirect(`/login?club=${encodeURIComponent(normalised)}`);
}
