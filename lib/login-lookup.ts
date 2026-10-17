export interface GymBranding {
  name: string;
  slug: string;
  logoUrl: string | null;
  /** The owner's logo-size choice (Settings → Branding). Absent on older payloads. */
  logoSize?: string | null;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  bgColor?: string;
  fontFamily?: string;
  demo?: boolean;
  /**
   * Whether this deployment sends email (lib/email-delivery.ts). "off" makes
   * the login screen withhold the sign-in-link and reset-code doors instead of
   * promising an email that will never come. A deployment-wide switch, so it
   * says nothing about any one account.
   */
  emailDelivery?: "on" | "off";
}

/**
 * The login door's logo height for each Settings → Branding size (T9b).
 * "md" is the 120px the page always used; an unknown or absent value is "md".
 */
export const LOGIN_LOGO_PX: Record<"sm" | "md" | "lg", number> = { sm: 88, md: 120, lg: 160 };

export function loginLogoPx(logoSize: string | null | undefined): number {
  return logoSize === "sm" || logoSize === "lg" ? LOGIN_LOGO_PX[logoSize] : LOGIN_LOGO_PX.md;
}

export interface LookupResult {
  aborted: boolean;
  branding: GymBranding | null;
  error: string | null;
}

export async function lookupTenantWithAbort(
  code: string,
  controller: AbortController,
): Promise<LookupResult> {
  try {
    const res = await fetch(`/api/tenant/${encodeURIComponent(code)}`, {
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return { aborted: true, branding: null, error: null };
    }

    if (!res.ok) {
      // A server-side failure is not a wrong club code. Telling a real member
      // of a real club to "check your code" during an outage sends them away
      // convinced they got their own club's name wrong (UI-RULES §7 — an HTTP
      // error is never an empty state). Only 4xx means the code is at fault.
      const error =
        res.status >= 500
          ? "Couldn't reach the server. Please try again shortly."
          : "Club not found. Check your code and try again.";
      return { aborted: false, branding: null, error };
    }

    const branding: GymBranding = await res.json();

    if (controller.signal.aborted) {
      return { aborted: true, branding: null, error: null };
    }

    return { aborted: false, branding, error: null };
  } catch (err: unknown) {
    if (
      controller.signal.aborted ||
      (err instanceof Error && err.name === "AbortError")
    ) {
      return { aborted: true, branding: null, error: null };
    }
    return { aborted: false, branding: null, error: "Something went wrong. Please try again." };
  }
}
