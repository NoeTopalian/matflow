// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

/**
 * 2FA-optional spec (2026-05-07) — onboarding "Save for later" (defer) path.
 *
 * TotpEnrollmentStep is the single source of truth for the enrolment flow,
 * reused by both the standalone /login/totp/setup page and the owner wizard
 * (OwnerOnboardingWizard stage 8, which passes onSaveForLater={() => setStep(9)}).
 *
 * Invariants:
 *   1. When onSaveForLater is supplied (wizard), a subordinate "Save for later"
 *      control renders; clicking it advances WITHOUT enabling TOTP — no POST to
 *      /api/auth/totp/setup is made.
 *   2. When onSaveForLater is omitted (standalone recovery page), the defer
 *      control is absent — that surface is for deliberate enrolment only.
 */

vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) =>
    React.createElement("img", { alt: String(props.alt ?? ""), src: String(props.src ?? "") }),
}));

import TotpEnrollmentStep from "@/components/onboarding/TotpEnrollmentStep";

function mockSetupGet() {
  const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
    if (!init || init.method === "GET" || init.method === undefined) {
      return { ok: true, json: async () => ({ secret: "MOCK-SECRET", qrDataUrl: "data:image/png;base64,QR", alreadyEnabled: false }) };
    }
    // Any POST would mean enrolment was attempted — the defer path must not hit this.
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => vi.clearAllMocks());

describe("TotpEnrollmentStep — defer (Save for later)", () => {
  it("renders 'Save for later' when onSaveForLater is provided and defers without enabling TOTP", async () => {
    const fetchMock = mockSetupGet();
    const onComplete = vi.fn();
    const onSaveForLater = vi.fn();

    render(<TotpEnrollmentStep onComplete={onComplete} primaryColor="#3b82f6" onSaveForLater={onSaveForLater} />);

    const deferBtn = await screen.findByRole("button", { name: /save for later/i });
    fireEvent.click(deferBtn);

    expect(onSaveForLater).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    // The only network call was the initial GET to load the QR — never a POST.
    const postCalls = fetchMock.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === "POST");
    expect(postCalls).toHaveLength(0);
  });

  it("does NOT render 'Save for later' on the standalone surface (no onSaveForLater)", async () => {
    mockSetupGet();
    render(<TotpEnrollmentStep onComplete={vi.fn()} primaryColor="#3b82f6" />);

    // Wait for QR to load so the enrol phase is fully rendered.
    expect(await screen.findByRole("button", { name: /enable two-factor/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save for later/i })).toBeNull();
  });
});
