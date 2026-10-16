import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

/**
 * Onboarding batch 1 (16 Oct 2026): /onboarding reads the club's saved name,
 * time zone and logo size so the wizard never re-saves a value the owner did
 * not change. If that read fails, the page must fail closed — the wizard is
 * told the club is already set up, so step 1 never sends the device's time
 * zone onto a live club on a guess.
 */

const h = vi.hoisted(() => ({ read: (async () => null) as () => Promise<unknown> }));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { role: "owner", tenantId: "t1", tenantName: "Session Name", name: "Owner", primaryColor: "#123456" } }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => {
    const row: unknown = await h.read();
    return fn({ tenant: { findUnique: async () => row } });
  },
}));
vi.mock("@/components/onboarding/OwnerOnboardingWizard", () => ({ default: () => null }));

import OnboardingPage from "@/app/onboarding/page";

type WizardProps = {
  storedName: string | null;
  storedTimezone: string | null;
  storedLogoSize: string | null;
  alreadyOnboarded: boolean;
  storedAnswers: unknown;
};

async function render(resume?: string) {
  const el = (await OnboardingPage({ searchParams: Promise.resolve(resume ? { resume } : {}) })) as ReactElement<WizardProps>;
  return el.props;
}

beforeEach(() => { h.read = async () => null; });

describe("/onboarding page", () => {
  it("passes the club's saved values to the wizard", async () => {
    h.read = async () => ({ onboardingCompleted: false, name: "Saved Name", timezone: "America/New_York", logoSize: "lg" });
    const p = await render();
    expect(p).toMatchObject({ storedName: "Saved Name", storedTimezone: "America/New_York", storedLogoSize: "lg", alreadyOnboarded: false });
  });

  it("an unknown stored logo size is passed as null, not guessed", async () => {
    h.read = async () => ({ onboardingCompleted: true, name: "N", timezone: "Europe/London", logoSize: "xl" });
    expect((await render("1")).storedLogoSize).toBeNull();
  });

  it("fails closed when the club cannot be read: treated as set up, nothing stored to compare", async () => {
    h.read = async () => { throw new Error("connection terminated"); };
    const p = await render();
    expect(p.alreadyOnboarded).toBe(true);
    expect(p.storedTimezone).toBeNull();
    expect(p.storedName).toBeNull();
  });

  it("passes saved questionnaire answers only when they have the shape step 6 writes", async () => {
    h.read = async () => ({ onboardingCompleted: true, name: "N", timezone: "Europe/London", logoSize: "md",
      onboardingAnswers: { size: "21–50", goals: ["Grow"], referral: "friend", referralOther: null } });
    expect((await render("1")).storedAnswers).toEqual({ size: "21–50", goals: ["Grow"], referral: "friend", referralOther: null });
    for (const bad of [null, "x", { size: 3 }, { size: "1–20", goals: [1], referral: "" }, { size: "1–20", goals: [] }]) {
      h.read = async () => ({ onboardingCompleted: true, name: "N", timezone: "Europe/London", logoSize: "md", onboardingAnswers: bad });
      expect((await render("1")).storedAnswers).toBeNull();
    }
  });

  it("a completed club without ?resume=1 goes to the dashboard", async () => {
    h.read = async () => ({ onboardingCompleted: true, name: "N", timezone: "Europe/London", logoSize: "md" });
    await expect(render()).rejects.toThrow("redirect:/dashboard");
  });
});
