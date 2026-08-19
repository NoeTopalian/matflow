import type { BrowserContext, Page } from "@playwright/test";

/**
 * Suppress the member first-run wizard for an audit/screenshot run.
 *
 * The wizard correctly blocks everything behind it, so any run that
 * photographs the member portal has to keep it off the glass. This used to be
 * done with `localStorage.setItem("bjj_onboarded", "true")` — which stopped
 * working the moment the wizard's gate became the SERVER flag
 * (`Member.onboardingCompleted`) rather than the presence of a browser key.
 * With the old suppression left in place the wizard would have covered every
 * member-portal shot in the suite.
 *
 * So suppress it the only way that is now true: make the payload the page
 * gates on say the member has onboarded. Interception rather than a seeded
 * database flag, so a spec cannot silently depend on how the test tenant
 * happens to have been seeded.
 *
 * Not a spec file — `tests/e2e/*.ts` without `.spec.`/`.test.` is outside
 * every project's testMatch (and outside `**\/member\/**`), so Playwright will
 * not try to collect it.
 */
export async function suppressOnboardingWizard(target: Page | BrowserContext) {
  await target.route("**/api/member/home**", async (route) => {
    const response = await route.fetch();

    let payload: { me?: { onboardingCompleted?: boolean } | null } | null;
    try {
      payload = await response.json();
    } catch {
      // Not JSON — an error page, most likely. Pass it through untouched so
      // the run still records the real failure instead of hiding it.
      await route.fulfill({ response });
      return;
    }

    if (payload?.me) payload.me.onboardingCompleted = true;

    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}
