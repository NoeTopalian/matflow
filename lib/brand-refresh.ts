// LB-004 (audit H10): JWT brand refresh threshold.
//
// Tenant branding (name, primaryColor, secondaryColor, textColor) is stamped
// onto the JWT at sign-in time, but the JWT lasts 30 days — so without a
// periodic refetch a settings change wouldn't propagate until the user logged
// out. We re-query the tenant table at most once every 5 minutes per session.

export const BRAND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function shouldRefreshBrand(brandFetchedAt: number | undefined, now: number = Date.now()): boolean {
  if (!brandFetchedAt) return true;
  return now - brandFetchedAt > BRAND_REFRESH_INTERVAL_MS;
}
