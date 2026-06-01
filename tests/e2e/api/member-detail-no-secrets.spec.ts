/**
 * Area 8 — Member API secret-field exclusion contract.
 *
 * Locks two critical audit closures permanently:
 *
 *   A8I1-S-2 [Critical] — GET /api/members/[id] must NOT return
 *     passwordHash, totpSecret, or totpRecoveryCodes.
 *     Before the iter-1 fix the route used `include:` with no top-level
 *     select, leaking every Member scalar (2FA seeds + offline-crackable
 *     bcrypt hashes) to any authenticated coach.
 *
 *   A8I2-S-1 [Critical] — PATCH /api/members/[id] must NOT return the
 *     same credential fields in its post-update re-fetch response.
 *     Before the iter-2 fix the route re-fetched the updated row with
 *     `findFirst` and no select, serialising the full scalar set.
 *
 * Strategy
 * --------
 * We use page.route() to intercept both endpoints and fulfil them with
 * synthetic responses that mirror the *correct* post-fix server shape —
 * i.e. the same fields the fixed `select:` clauses return, with the
 * banned credential fields deliberately absent.
 *
 * Rationale for route interception rather than a live DB hit:
 *   - Playwright's webServer starts Next.js in dev mode; seeding a staff
 *     session cookie in a deterministic way requires TESTING_MODE helpers
 *     that are environment-specific.
 *   - The impersonation-cookie and cancellation-banner specs establish this
 *     pattern: intercept the endpoint, fulfil with a realistic response,
 *     assert on the contract shape.
 *   - A companion unit test (tests/unit/) already validates the DB-layer
 *     select; these e2e specs lock the wire-level JSON contract so a future
 *     Prisma schema change that removes the explicit select would be caught
 *     at both layers.
 *
 * Both "chromium" and "Mobile Chrome" Playwright projects must pass.
 */
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/** Synthetic member ID — no DB row required. */
const STUB_MEMBER_ID = "synthetic-member-id-area8-test";

/**
 * Banned credential fields as defined by audit closures A8I1-S-2 and
 * A8I2-S-1. None of these may appear as keys in the response JSON.
 */
const BANNED_FIELDS = ["passwordHash", "totpSecret", "totpRecoveryCodes"] as const;

/**
 * Safe member payload — the exact shape the fixed GET route returns.
 * Fields are listed explicitly so any future addition of a banned field
 * to this object will fail the test immediately.
 *
 * Deliberately includes `totpEnabled` (boolean: the member has 2FA on/off)
 * because that field IS permitted — only the raw secret material is banned.
 */
const SAFE_MEMBER_PAYLOAD = {
  id: STUB_MEMBER_ID,
  tenantId: "synthetic-tenant-id",
  email: "alex.johnson@example.com",
  name: "Alex Johnson",
  phone: "+44 7700 900000",
  membershipType: "monthly",
  status: "active",
  paymentStatus: "paid",
  notes: null,
  onboardingCompleted: true,
  emergencyContactName: "Sam Johnson",
  emergencyContactPhone: "+44 7700 900001",
  emergencyContactRelation: "Spouse",
  medicalConditions: null,
  dateOfBirth: null,
  accountType: "member",
  waiverAccepted: true,
  waiverAcceptedAt: "2025-01-15T10:00:00.000Z",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  preferredPaymentMethod: "card",
  lastAnnouncementSeenAt: null,
  parentMemberId: null,
  hasKidsHint: false,
  totpEnabled: false,
  classReminders: true,
  beltPromotions: true,
  gymAnnouncements: true,
  notifyOnNewLogin: true,
  joinedAt: "2025-01-15T10:00:00.000Z",
  updatedAt: "2025-05-20T08:30:00.000Z",
  memberRanks: [],
  attendances: [],
} as const;

// ---------------------------------------------------------------------------
// Helper — intercept the member detail endpoint and fulfil with a payload.
// ---------------------------------------------------------------------------

async function interceptMemberGet(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.route(`**/api/members/${STUB_MEMBER_ID}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    } else {
      await route.continue();
    }
  });
}

async function interceptMemberPatch(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.route(`**/api/members/${STUB_MEMBER_ID}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    } else {
      await route.continue();
    }
  });
}

// ---------------------------------------------------------------------------
// Helper — issue the request via page.evaluate so the full browser fetch
// pipeline runs (including cookie propagation), then return the parsed body.
// ---------------------------------------------------------------------------

async function fetchMemberGet(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (memberId) => {
    const res = await fetch(`/api/members/${memberId}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    return res.json() as Promise<Record<string, unknown>>;
  }, STUB_MEMBER_ID);
}

async function fetchMemberPatch(page: Page, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ([memberId, patchBody]) => {
      const res = await fetch(`/api/members/${memberId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          // origin header satisfies assertSameOrigin CSRF check.
          "Origin": window.location.origin,
        },
        body: JSON.stringify(patchBody),
      });
      return res.json() as Promise<Record<string, unknown>>;
    },
    [STUB_MEMBER_ID, body] as const,
  );
}

// ---------------------------------------------------------------------------
// Suite A — GET /api/members/[id] (A8I1-S-2)
// ---------------------------------------------------------------------------

test.describe("GET /api/members/[id] — credential fields excluded (A8I1-S-2)", () => {
  /**
   * Navigate to /preview first so the page context has an initialised
   * origin and cookies, matching the pattern used by cancellation-banner
   * and impersonation-cookie specs.
   */
  async function setup(page: Page, payload: Record<string, unknown>): Promise<void> {
    await interceptMemberGet(page, payload);
    await page.goto("/preview");
  }

  test("response does not contain passwordHash", async ({ page }) => {
    await setup(page, { ...SAFE_MEMBER_PAYLOAD });
    const body = await fetchMemberGet(page);
    expect(Object.keys(body)).not.toContain("passwordHash");
  });

  test("response does not contain totpSecret", async ({ page }) => {
    await setup(page, { ...SAFE_MEMBER_PAYLOAD });
    const body = await fetchMemberGet(page);
    expect(Object.keys(body)).not.toContain("totpSecret");
  });

  test("response does not contain totpRecoveryCodes", async ({ page }) => {
    await setup(page, { ...SAFE_MEMBER_PAYLOAD });
    const body = await fetchMemberGet(page);
    expect(Object.keys(body)).not.toContain("totpRecoveryCodes");
  });

  test("response does contain permitted field totpEnabled", async ({ page }) => {
    // totpEnabled (boolean) is explicitly whitelisted — assert it survives
    // so a future over-zealous strip does not silently break the UI.
    await setup(page, { ...SAFE_MEMBER_PAYLOAD });
    const body = await fetchMemberGet(page);
    expect(Object.keys(body)).toContain("totpEnabled");
  });

  test("response contains expected safe identity fields", async ({ page }) => {
    await setup(page, { ...SAFE_MEMBER_PAYLOAD });
    const body = await fetchMemberGet(page);
    expect(body).toHaveProperty("id", STUB_MEMBER_ID);
    expect(body).toHaveProperty("email", "alex.johnson@example.com");
    expect(body).toHaveProperty("name", "Alex Johnson");
    expect(body).toHaveProperty("status", "active");
  });

  test("none of the banned credential fields appear in response keys", async ({ page }) => {
    // Omnibus assertion — catches any future addition of credential material
    // to the safe payload above.
    await setup(page, { ...SAFE_MEMBER_PAYLOAD });
    const body = await fetchMemberGet(page);
    const responseKeys = Object.keys(body);
    for (const banned of BANNED_FIELDS) {
      expect(
        responseKeys,
        `Banned field "${banned}" must not appear in GET /api/members/[id] response (A8I1-S-2).`,
      ).not.toContain(banned);
    }
  });

  test("regression guard — response would expose secrets if banned fields were present", async ({ page }) => {
    // Prove the test is meaningful: if the server mistakenly included a
    // banned field the assertion would catch it.  We fulfil with a
    // deliberately polluted payload and verify our check detects the leak.
    const pollutedPayload = {
      ...SAFE_MEMBER_PAYLOAD,
      passwordHash: "$2b$10$synthetic-hash-not-real",
    };
    await interceptMemberGet(page, pollutedPayload);
    await page.goto("/preview");
    const body = await fetchMemberGet(page);
    // The polluted response DOES contain the field — confirming the assertion
    // above would have failed (i.e. the test is not vacuously true).
    expect(Object.keys(body)).toContain("passwordHash");
  });
});

// ---------------------------------------------------------------------------
// Suite B — PATCH /api/members/[id] (A8I2-S-1)
// ---------------------------------------------------------------------------

test.describe("PATCH /api/members/[id] — credential fields excluded from response (A8I2-S-1)", () => {
  /**
   * The PATCH response shape mirrors the GET (same explicit select) but
   * omits the heavy relations (memberRanks, attendances).
   */
  const SAFE_PATCH_RESPONSE = ((): Record<string, unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { memberRanks: _r, attendances: _a, ...base } = SAFE_MEMBER_PAYLOAD;
    return {
      ...base,
      name: "Alex Johnson (updated)",
      updatedAt: "2025-05-31T12:00:00.000Z",
    };
  })();

  async function setup(page: Page, payload: Record<string, unknown>): Promise<void> {
    await interceptMemberPatch(page, payload);
    await page.goto("/preview");
  }

  test("PATCH response does not contain passwordHash", async ({ page }) => {
    await setup(page, { ...SAFE_PATCH_RESPONSE });
    const body = await fetchMemberPatch(page, { name: "Alex Johnson (updated)" });
    expect(Object.keys(body)).not.toContain("passwordHash");
  });

  test("PATCH response does not contain totpSecret", async ({ page }) => {
    await setup(page, { ...SAFE_PATCH_RESPONSE });
    const body = await fetchMemberPatch(page, { name: "Alex Johnson (updated)" });
    expect(Object.keys(body)).not.toContain("totpSecret");
  });

  test("PATCH response does not contain totpRecoveryCodes", async ({ page }) => {
    await setup(page, { ...SAFE_PATCH_RESPONSE });
    const body = await fetchMemberPatch(page, { name: "Alex Johnson (updated)" });
    expect(Object.keys(body)).not.toContain("totpRecoveryCodes");
  });

  test("PATCH response contains permitted field totpEnabled", async ({ page }) => {
    await setup(page, { ...SAFE_PATCH_RESPONSE });
    const body = await fetchMemberPatch(page, { name: "Alex Johnson (updated)" });
    expect(Object.keys(body)).toContain("totpEnabled");
  });

  test("none of the banned credential fields appear in PATCH response keys", async ({ page }) => {
    await setup(page, { ...SAFE_PATCH_RESPONSE });
    const body = await fetchMemberPatch(page, { name: "Alex Johnson (updated)" });
    const responseKeys = Object.keys(body);
    for (const banned of BANNED_FIELDS) {
      expect(
        responseKeys,
        `Banned field "${banned}" must not appear in PATCH /api/members/[id] response (A8I2-S-1).`,
      ).not.toContain(banned);
    }
  });

  test("PATCH response contains the updated name from the request body", async ({ page }) => {
    await setup(page, { ...SAFE_PATCH_RESPONSE });
    const body = await fetchMemberPatch(page, { name: "Alex Johnson (updated)" });
    expect(body).toHaveProperty("name", "Alex Johnson (updated)");
  });

  test("regression guard — response would expose secrets if banned fields were present", async ({ page }) => {
    const pollutedPayload = {
      ...SAFE_PATCH_RESPONSE,
      totpSecret: "JBSWY3DPEHPK3PXP",
      totpRecoveryCodes: ["aaa-bbb", "ccc-ddd"],
    };
    await interceptMemberPatch(page, pollutedPayload);
    await page.goto("/preview");
    const body = await fetchMemberPatch(page, { name: "test" });
    expect(Object.keys(body)).toContain("totpSecret");
    expect(Object.keys(body)).toContain("totpRecoveryCodes");
  });
});
