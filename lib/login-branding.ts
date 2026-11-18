import type { GymBranding } from "@/lib/login-lookup";
import { isSafeFontFamily } from "@/lib/fonts";

function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s);
}

/**
 * The login page's branding: the club's saved branding from the server, with
 * this browser's `gym-settings` cache used only to fill a field the server
 * did not send, and only for the same club.
 */
export function mergeLocalBranding(branding: GymBranding) {
  if (typeof window === "undefined") return branding;
  try {
    const raw = localStorage.getItem("gym-settings");
    if (!raw) return branding;
    const local = JSON.parse(raw) as {
      slug?: unknown;
      logoUrl?: unknown;
      primaryColor?: unknown;
      secondaryColor?: unknown;
      textColor?: unknown;
      bgColor?: unknown;
      fontFamily?: unknown;
    };
    if (typeof local.slug !== "string" || local.slug.toLowerCase() !== branding.slug.toLowerCase()) {
      return branding;
    }

    // Round 2 close-out (10 Nov 2026): the club's saved branding (the server)
    // wins. This browser's cache only fills a field the server did not send;
    // it used to override them, so a stale or unsaved value reached the login
    // page. A logo the server says is absent (null) stays absent.
    return {
      ...branding,
      logoUrl: branding.logoUrl !== undefined ? branding.logoUrl : (typeof local.logoUrl === "string" && local.logoUrl.length > 0 ? local.logoUrl : branding.logoUrl),
      primaryColor: isHexColor(branding.primaryColor) ? branding.primaryColor : (isHexColor(local.primaryColor) ? local.primaryColor : branding.primaryColor),
      secondaryColor: isHexColor(branding.secondaryColor) ? branding.secondaryColor : (isHexColor(local.secondaryColor) ? local.secondaryColor : branding.secondaryColor),
      textColor: isHexColor(branding.textColor) ? branding.textColor : (isHexColor(local.textColor) ? local.textColor : branding.textColor),
      bgColor: isHexColor(branding.bgColor) ? branding.bgColor : (isHexColor(local.bgColor) ? local.bgColor : branding.bgColor),
      fontFamily: isSafeFontFamily(branding.fontFamily) ? branding.fontFamily : (isSafeFontFamily(local.fontFamily) ? local.fontFamily : branding.fontFamily),
    };
  } catch {
    return branding;
  }
}
