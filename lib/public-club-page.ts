/**
 * T9c — the opt-in public club page at /[slug] (Q9, Noe 17 Oct 2026).
 *
 * Pure half: no Prisma, no request APIs, so the client timetable filter and
 * the unit tests can import it. The database reads live in
 * lib/public-club-page-server.ts and use the field lists pinned here.
 *
 * WHAT IS PUBLIC — the approved field lists below are the whole disclosure.
 * Each `select` is pinned by tests/unit/public-club-page-read-model.test.ts,
 * so adding a field to the anonymous page is a reviewed change, not a drive-by.
 *
 *   Club:    name, logo (inline raster only), colours, font, the description
 *            and contact details the owner typed into Settings → Public page,
 *            and the club's own website and social links.
 *   Classes: live classes only — active, not removed, not created by an
 *            import, not roster-only (a private group), with an active weekly
 *            schedule. Name, kids flag, duration, venue label, coach name
 *            (owner decision: the timetable is filterable by coach), day and
 *            start/end.
 *   Tiers:   only tiers the owner ticked "show on public page", active, with a
 *            known price. None at all while the club is review-locked.
 *
 * NEVER PUBLIC: members, rosters, capacity, attendance, staff other than the
 * coach name on a class, the private contactEmail/address/billing fields,
 * group-chat invite links, Stripe anything.
 */
import type { Metadata } from "next";
import { tenantAdmitsSignIn } from "@/lib/tenant-admission";
import { isReservedSlug } from "@/lib/reserved-slugs";
import { LOGO_DATA_URL_RE } from "@/lib/logo-url";
import { formatTierPrice, PRICE_NOT_SET } from "@/lib/membership-tier-format";
import { resolveCoachName } from "@/lib/class-coach";

/** The canonical public origin, matching app/sitemap.ts and app/robots.ts. */
export const PUBLIC_SITE_URL = "https://matflow.studio";

/** Bounds on the owner-entered public fields (the settings route enforces them). */
export const PUBLIC_DESCRIPTION_MAX = 600;
export const PUBLIC_EMAIL_MAX = 120;
export const PUBLIC_PHONE_MAX = 40;
export const PUBLIC_ADDRESS_MAX = 300;

/** The same one-line normalise the tenant lookup and the reserved guard use. */
export function normaliseClubSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** A slug that can never be a club page (empty after normalising, or a route). */
export function isNonClubSlug(normalised: string): boolean {
  return !normalised || isReservedSlug(normalised);
}

// ─── Read model (pinned) ─────────────────────────────────────────────────────

/** The by-slug gate read: fixed fields, nothing else, under the RLS bypass. */
export const PUBLIC_GATE_SELECT = {
  id: true,
  subscriptionStatus: true,
  deletedAt: true,
  publicPageEnabled: true,
} as const;

export type PublicGateRow = {
  id: string;
  subscriptionStatus: string | null;
  deletedAt: Date | string | null;
  publicPageEnabled: boolean | null;
};

/**
 * Published = the club admits sign-in (not suspended, cancelled or deleted —
 * the one shared rule in lib/tenant-admission.ts) AND the owner switched the
 * page on. Anything else is answered exactly like an unknown slug.
 */
export function isPublishedGate(row: PublicGateRow | null | undefined): row is PublicGateRow {
  if (!row) return false;
  if (row.publicPageEnabled !== true) return false;
  return tenantAdmitsSignIn(row);
}

export const PUBLIC_TENANT_SELECT = {
  name: true,
  slug: true,
  logoUrl: true,
  logoSize: true,
  primaryColor: true,
  secondaryColor: true,
  textColor: true,
  bgColor: true,
  fontFamily: true,
  publicPageDescription: true,
  publicPageEmail: true,
  publicPagePhone: true,
  publicPageAddress: true,
  websiteUrl: true,
  instagramUrl: true,
  facebookUrl: true,
  tiktokUrl: true,
  youtubeUrl: true,
  twitterUrl: true,
  // Read to decide whether prices may show; never rendered.
  reviewLockedAt: true,
} as const;

export const PUBLIC_CLASS_SELECT = {
  id: true,
  name: true,
  isKids: true,
  duration: true,
  location: true,
  locationRef: { select: { name: true } },
  coachName: true,
  coachUser: { select: { name: true } },
} as const;

export const PUBLIC_SCHEDULE_SELECT = {
  dayOfWeek: true,
  startTime: true,
  endTime: true,
} as const;

export const PUBLIC_TIER_SELECT = {
  id: true,
  name: true,
  description: true,
  pricePence: true,
  currency: true,
  billingCycle: true,
  isKids: true,
} as const;

/**
 * The live-class predicate. `sourceImportJobId: null` keeps attendance-history
 * classes out even if one were reactivated; `rosterMembers: { none: {} }`
 * keeps roster-only (private group) classes out — the member timetable hides
 * those from non-roster members, so the anonymous page must too.
 */
export function publicClassWhere(tenantId: string) {
  return {
    tenantId,
    isActive: true,
    deletedAt: null,
    sourceImportJobId: null,
    rosterMembers: { none: {} },
  } as const;
}

/** An active weekly schedule that has not ended. */
export function publicScheduleWhere(now: Date) {
  return {
    isActive: true,
    OR: [{ endDate: null }, { endDate: { gte: now } }],
  };
}

export function publicTierWhere(tenantId: string) {
  return { tenantId, isActive: true, showOnPublicPage: true } as const;
}

// ─── View model ──────────────────────────────────────────────────────────────

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Monday first: how a UK club's week reads. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export type PublicSession = {
  key: string;
  className: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  durationMin: number | null;
  isKids: boolean;
  venue: string | null;
  coach: string | null;
};

export type PublicTier = {
  id: string;
  name: string;
  description: string | null;
  price: string;
  isKids: boolean;
};

export type PublicSocialLink = { label: string; href: string };

export type PublicClubPage = {
  slug: string;
  name: string;
  /** An inline raster data: URL, or null (blob and external logos are not anonymous-safe). */
  logoDataUrl: string | null;
  logoSize: string;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  bgColor: string;
  fontFamily: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  websiteUrl: string | null;
  socials: PublicSocialLink[];
  sessions: PublicSession[];
  tiers: PublicTier[];
};

type ClassRow = {
  id: string;
  name: string;
  isKids: boolean;
  duration: number | null;
  location: string | null;
  locationRef: { name: string } | null;
  coachName: string | null;
  coachUser: { name: string } | null;
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
};

type TierRow = {
  id: string;
  name: string;
  description: string | null;
  pricePence: number;
  currency: string;
  billingCycle: string;
  isKids: boolean;
};

type TenantRow = {
  name: string;
  slug: string;
  logoUrl: string | null;
  logoSize: string;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  bgColor: string;
  fontFamily: string;
  publicPageDescription: string | null;
  publicPageEmail: string | null;
  publicPagePhone: string | null;
  publicPageAddress: string | null;
  websiteUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  twitterUrl: string | null;
  reviewLockedAt: Date | string | null;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutesBetween(start: string, end: string): number | null {
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const d = eh * 60 + em - (sh * 60 + sm);
  return d > 0 ? d : null;
}

/** One row per weekly slot, Monday first, then by start time. */
export function buildPublicSessions(classes: ClassRow[]): PublicSession[] {
  const rows: PublicSession[] = [];
  for (const c of classes) {
    const venue = c.locationRef?.name?.trim() || c.location?.trim() || null;
    // The coach's user id is never selected for the anonymous page; the name
    // resolution only needs the name.
    const coach = resolveCoachName({ coachName: c.coachName, coachUser: c.coachUser ? { id: "", name: c.coachUser.name } : null });
    for (const s of c.schedules) {
      if (s.dayOfWeek < 0 || s.dayOfWeek > 6) continue;
      if (!TIME_RE.test(s.startTime)) continue;
      rows.push({
        key: `${c.id}-${s.dayOfWeek}-${s.startTime}`,
        className: c.name,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        durationMin: minutesBetween(s.startTime, s.endTime) ?? c.duration ?? null,
        isKids: c.isKids,
        venue,
        coach,
      });
    }
  }
  rows.sort(
    (a, b) =>
      DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek) ||
      a.startTime.localeCompare(b.startTime) ||
      a.className.localeCompare(b.className),
  );
  return rows;
}

/** Tiers with a known price only; "Price not set" is not something to publish. */
export function buildPublicTiers(tiers: TierRow[]): PublicTier[] {
  return tiers
    .map((t) => ({ t, price: formatTierPrice(t) }))
    .filter(({ price }) => price !== PRICE_NOT_SET)
    .sort((a, b) => a.t.pricePence - b.t.pricePence || a.t.name.localeCompare(b.t.name))
    .map(({ t, price }) => ({
      id: t.id,
      name: t.name,
      description: t.description?.trim() || null,
      price,
      isKids: t.isKids,
    }));
}

function httpsOrNull(u: string | null | undefined): string | null {
  const v = u?.trim();
  return v && v.startsWith("https://") ? v : null;
}

export function inlineLogo(logoUrl: string | null | undefined): string | null {
  return logoUrl && LOGO_DATA_URL_RE.test(logoUrl) ? logoUrl : null;
}

export function buildPublicClubPage(tenant: TenantRow, classes: ClassRow[], tiers: TierRow[]): PublicClubPage {
  const socials: PublicSocialLink[] = [];
  const pairs: [string, string | null][] = [
    ["Instagram", tenant.instagramUrl],
    ["Facebook", tenant.facebookUrl],
    ["TikTok", tenant.tiktokUrl],
    ["YouTube", tenant.youtubeUrl],
    ["X", tenant.twitterUrl],
  ];
  for (const [label, url] of pairs) {
    const href = httpsOrNull(url);
    if (href) socials.push({ label, href });
  }
  return {
    slug: tenant.slug,
    name: tenant.name,
    logoDataUrl: inlineLogo(tenant.logoUrl),
    logoSize: tenant.logoSize,
    primaryColor: tenant.primaryColor,
    secondaryColor: tenant.secondaryColor,
    textColor: tenant.textColor,
    bgColor: tenant.bgColor,
    fontFamily: tenant.fontFamily,
    description: tenant.publicPageDescription?.trim() || null,
    email: tenant.publicPageEmail?.trim() || null,
    phone: tenant.publicPagePhone?.trim() || null,
    address: tenant.publicPageAddress?.trim() || null,
    websiteUrl: httpsOrNull(tenant.websiteUrl),
    socials,
    sessions: buildPublicSessions(classes),
    // Q9 E-10 proposed default: a review-locked club may publish, without prices.
    tiers: tenant.reviewLockedAt ? [] : buildPublicTiers(tiers),
  };
}

// ─── Client-side filter ──────────────────────────────────────────────────────

export type SessionFilter = {
  query: string;
  day: number | null;
  coach: string | null;
  category: "kids" | "adults" | null;
};

export const EMPTY_FILTER: SessionFilter = { query: "", day: null, coach: null, category: null };

export function filterSessions(sessions: PublicSession[], f: SessionFilter): PublicSession[] {
  const q = f.query.trim().toLowerCase();
  return sessions.filter((s) => {
    if (q) {
      const hay = [s.className, s.coach ?? "", s.venue ?? ""].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.day !== null && s.dayOfWeek !== f.day) return false;
    if (f.coach !== null && s.coach !== f.coach) return false;
    if (f.category === "kids" && !s.isKids) return false;
    if (f.category === "adults" && s.isKids) return false;
    return true;
  });
}

/** The filter options that exist in the data — never a fixed list. */
export function filterOptions(sessions: PublicSession[]) {
  const days = DAY_ORDER.filter((d) => sessions.some((s) => s.dayOfWeek === d));
  const coaches = [...new Set(sessions.map((s) => s.coach).filter((c): c is string => !!c))].sort((a, b) =>
    a.localeCompare(b),
  );
  const hasKids = sessions.some((s) => s.isKids);
  const hasAdults = sessions.some((s) => !s.isKids);
  return { days, coaches, showCategory: hasKids && hasAdults };
}

// ─── Search engines ──────────────────────────────────────────────────────────

export function clubPageUrl(slug: string): string {
  return `${PUBLIC_SITE_URL}/${slug}`;
}

/** The anonymous logo URL for Open Graph / JSON-LD, only when one can be served. */
export function clubLogoUrl(page: Pick<PublicClubPage, "slug" | "logoDataUrl">): string | null {
  return page.logoDataUrl ? `${PUBLIC_SITE_URL}/api/tenant/${page.slug}/logo` : null;
}

export function clubDescription(page: PublicClubPage): string {
  if (page.description) return page.description.slice(0, 300);
  return page.sessions.length > 0
    ? `${page.name}: weekly class timetable and how to join.`
    : `${page.name}: how to get in touch and join.`;
}

const SCHEMA_DAYS = DAY_NAMES.map((d) => `https://schema.org/${d}`);

/**
 * Opening hours, derived from the live timetable only: per day, the first
 * class start to the last class end. Omitted when there is no timetable or a
 * day has an unreadable end time — never guessed.
 */
export function derivedOpeningHours(sessions: PublicSession[]) {
  const out: { "@type": "OpeningHoursSpecification"; dayOfWeek: string; opens: string; closes: string }[] = [];
  for (const d of DAY_ORDER) {
    const day = sessions.filter((s) => s.dayOfWeek === d);
    if (day.length === 0) continue;
    if (day.some((s) => !TIME_RE.test(s.endTime) || minutesBetween(s.startTime, s.endTime) === null)) return [];
    const opens = day.map((s) => s.startTime).sort()[0];
    const closes = day.map((s) => s.endTime).sort().at(-1)!;
    out.push({ "@type": "OpeningHoursSpecification", dayOfWeek: SCHEMA_DAYS[d], opens, closes });
  }
  return out;
}

export function clubJsonLd(page: PublicClubPage): Record<string, unknown> {
  const url = clubPageUrl(page.slug);
  const logo = clubLogoUrl(page);
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    // ExerciseGym is a SportsActivityLocation in schema.org's hierarchy.
    "@type": "ExerciseGym",
    name: page.name,
    url,
    description: clubDescription(page),
  };
  if (logo) {
    ld.logo = logo;
    ld.image = logo;
  }
  if (page.address) ld.address = { "@type": "PostalAddress", streetAddress: page.address };
  if (page.email) ld.email = page.email;
  if (page.phone) ld.telephone = page.phone;
  const sameAs = [page.websiteUrl, ...page.socials.map((s) => s.href)].filter((u): u is string => !!u);
  if (sameAs.length) ld.sameAs = sameAs;
  const hours = derivedOpeningHours(page.sessions);
  if (hours.length) ld.openingHoursSpecification = hours;
  return ld;
}

/** Every non-published answer carries this, so it is identical across states. */
export const NOT_PUBLISHED_METADATA: Metadata = { robots: { index: false, follow: false } };

/** Indexable metadata for a published club: title, description, canonical, Open Graph. */
export function clubMetadata(page: PublicClubPage): Metadata {
  const url = clubPageUrl(page.slug);
  const description = clubDescription(page);
  const logo = clubLogoUrl(page);
  return {
    title: page.name,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      url,
      title: page.name,
      description,
      siteName: page.name,
      locale: "en_GB",
      ...(logo ? { images: [{ url: logo, alt: `${page.name} logo` }] } : {}),
    },
    twitter: {
      card: "summary",
      title: page.name,
      description,
      ...(logo ? { images: [logo] } : {}),
    },
  };
}

/** JSON for a <script type="application/ld+json">, with `<` escaped (Next's JSON-LD guide). */
export function serialiseJsonLd(ld: Record<string, unknown>): string {
  return JSON.stringify(ld).replace(/</g, "\\u003c");
}

/** Decode an inline raster logo for the anonymous logo route. */
export function decodeInlineLogo(dataUrl: string | null | undefined): { contentType: string; bytes: Uint8Array } | null {
  if (!dataUrl) return null;
  const m = LOGO_DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  const kind = m[1] === "jpg" ? "jpeg" : m[1];
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { contentType: `image/${kind}`, bytes: new Uint8Array(Buffer.from(b64, "base64")) };
}
