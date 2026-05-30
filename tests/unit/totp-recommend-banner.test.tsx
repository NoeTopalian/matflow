// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

/**
 * 2FA-optional spec (2026-05-07) — recommendation banners.
 *
 * - Recommend2FABanner (staff, server component): renders unconditionally with
 *   a non-dismissible "Set up now" link; the parent layout owns the
 *   totpEnabled===false visibility gate.
 * - Recommend2FABannerMember (client component): self-gates, showing ONLY when
 *   the member has a password AND TOTP is disabled. Magic-link-only members
 *   never see it.
 */

import Recommend2FABanner from "@/components/layout/Recommend2FABanner";
import Recommend2FABannerMember from "@/components/layout/Recommend2FABannerMember";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Recommend2FABanner (staff)", () => {
  it("renders the recommendation with a 'Set up now' link to the setup flow", () => {
    render(<Recommend2FABanner scope="your gym" />);
    expect(screen.getByText(/two-factor authentication is recommended/i)).toBeTruthy();
    expect(screen.getByText(/protect your gym/i)).toBeTruthy();
    const link = screen.getByRole("link", { name: /set up now/i });
    expect(link.getAttribute("href")).toBe("/login/totp/setup");
  });

  it("is non-dismissible — exposes no dismiss/close control", () => {
    render(<Recommend2FABanner />);
    // The only interactive element is the setup link; there is no button.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("honours a custom setupHref", () => {
    render(<Recommend2FABanner setupHref="/custom/setup" />);
    expect(screen.getByRole("link", { name: /set up now/i }).getAttribute("href")).toBe("/custom/setup");
  });
});

describe("Recommend2FABannerMember (member, self-gating)", () => {
  function mockMe(payload: { hasPassword: boolean; totpEnabled: boolean }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch,
    );
  }

  beforeEach(() => vi.clearAllMocks());

  it("shows for a password-bearing member with TOTP disabled", async () => {
    mockMe({ hasPassword: true, totpEnabled: false });
    render(<Recommend2FABannerMember />);
    expect(await screen.findByText(/two-factor authentication is recommended/i)).toBeTruthy();
    expect(screen.getByText(/magic-link login does not require 2fa/i)).toBeTruthy();
  });

  it("stays hidden for a magic-link-only member (no password)", async () => {
    mockMe({ hasPassword: false, totpEnabled: false });
    render(<Recommend2FABannerMember />);
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    expect(screen.queryByText(/two-factor authentication is recommended/i)).toBeNull();
  });

  it("stays hidden once the member has enrolled (totpEnabled true)", async () => {
    mockMe({ hasPassword: true, totpEnabled: true });
    render(<Recommend2FABannerMember />);
    await waitFor(() => expect((global.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    expect(screen.queryByText(/two-factor authentication is recommended/i)).toBeNull();
  });
});
