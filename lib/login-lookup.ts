export interface GymBranding {
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  demo?: boolean;
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
      return { aborted: false, branding: null, error: "Club not found. Check your code and try again." };
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
