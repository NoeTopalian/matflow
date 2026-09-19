// Campaign lane L-B, J12 / J16: PATCH /api/settings used to STRIP a key it did
// not recognise and answer 200, so a caller was told a save succeeded that the
// database never took. That is how `Tenant.timezone` went unnoticed for so
// long: `PATCH { timezone }` answered 200 for ever and wrote nothing.
//
// Making the schema strict is only safe because every key every client sends is
// already in it. Enumerated before the change, from the only two callers:
//
//   components/dashboard/SettingsPage.tsx  — paymentRail · acceptsBacs ·
//     memberSelfBilling · billingContactEmail · billingContactUrl · name ·
//     primaryColor · secondaryColor · textColor · bgColor · fontFamily ·
//     logoUrl · logoSize · checkinWindowBeforeMin · checkinWindowAfterMin ·
//     waiverTitle · waiverContent · kidsWaiverTitle · kidsWaiverContent ·
//     privacyContactEmail · privacyPolicyUrl · instagramUrl · facebookUrl ·
//     tiktokUrl · youtubeUrl · twitterUrl · websiteUrl · groupChatUrl
//   components/onboarding/OwnerOnboardingWizard.tsx — name · primaryColor ·
//     secondaryColor · textColor · bgColor · fontFamily · logoSize · logoUrl ·
//     onboardingAnswers · onboardingCompleted · paymentRail · acceptsBacs
//
// All 30 are in `updateSchema`. No client sends a key the schema lacks.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { update } = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { update } } }));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u-1", tenantId: "t-A", role: "owner" } }),
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({
    ok: true,
    session: { user: { id: "u-1", tenantId: "t-A", role: "owner" } },
    tenantId: "t-A",
    userId: "u-1",
    role: "owner",
  }),
}));

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

import { PATCH } from "@/app/api/settings/route";

function patchWith(body: unknown) {
  return PATCH(
    new Request("http://localhost:3847/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3847" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ id: "t-A", name: "Total BJJ" });
});

describe("PATCH /api/settings refuses what it cannot save", () => {
  it("answers 400 and names the key it does not know", async () => {
    const res = await patchWith({ notAField: "x" });
    const body = (await res.json()) as { error?: string; details?: unknown };

    expect(res.status).toBe(400);
    // Naming the key is the point: "Invalid data" alone leaves the caller
    // guessing which of thirty fields was the problem.
    expect(JSON.stringify(body)).toContain("notAField");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses the whole request rather than silently saving the valid half", async () => {
    const res = await patchWith({ name: "Total BJJ", notAField: "x" });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("still accepts every key the two real clients send", async () => {
    const everyKey = {
      name: "Total BJJ",
      primaryColor: "#3b82f6",
      secondaryColor: "#2563eb",
      textColor: "#ffffff",
      bgColor: "#111111",
      fontFamily: "'Inter', sans-serif",
      logoSize: "md",
      logoUrl: null,
      onboardingCompleted: true,
      onboardingAnswers: { size: "10-50" },
      waiverTitle: "Adult waiver",
      waiverContent: "Body",
      kidsWaiverTitle: "Parent waiver",
      kidsWaiverContent: "Body",
      paymentRail: "pay_at_desk",
      acceptsBacs: false,
      memberSelfBilling: false,
      billingContactEmail: "billing@totalbjj.com",
      billingContactUrl: "https://totalbjj.com/billing",
      privacyContactEmail: "privacy@totalbjj.com",
      privacyPolicyUrl: "https://totalbjj.com/privacy",
      instagramUrl: "https://instagram.com/totalbjj",
      facebookUrl: "https://facebook.com/totalbjj",
      tiktokUrl: "https://tiktok.com/@totalbjj",
      youtubeUrl: "https://youtube.com/@totalbjj",
      twitterUrl: "https://x.com/totalbjj",
      websiteUrl: "https://totalbjj.com",
      groupChatUrl: "https://chat.whatsapp.com/abc",
      checkinWindowBeforeMin: 30,
      checkinWindowAfterMin: 30,
    };
    const res = await patchWith(everyKey);
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
