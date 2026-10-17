/**
 * The mail-dark switch (7 Oct 2026, handover story US-003) and the test
 * recipient allowlist (17 Oct 2026).
 *
 * `EMAIL_DELIVERY` decides whether MatFlow sends ANY email:
 *
 *   EMAIL_DELIVERY=off              — nothing is sent. `sendEmail` makes no
 *                                     Resend call, writes one EmailLog row at
 *                                     status "suppressed", and returns
 *                                     `{ ok: false, suppressed: "delivery_off" }`.
 *   EMAIL_DELIVERY=test             — mail goes ONLY to the addresses listed in
 *                                     EMAIL_TEST_RECIPIENTS (comma-separated,
 *                                     exact, case-insensitive). An empty or
 *                                     missing list sends nothing (fail closed).
 *   EMAIL_DELIVERY=on   (or unset)  — in production: sends go to Resend for
 *                                     any recipient. ANYWHERE ELSE (local, the
 *                                     test suite, preview, a test deployment —
 *                                     anything that is neither VERCEL_ENV=
 *                                     production nor the production database)
 *                                     `on` means `test`: only the listed
 *                                     addresses receive mail, and with no list
 *                                     nothing is sent.
 *
 * Any other value (a typo, "false", "0") is treated as OFF: when someone has
 * tried to configure the switch and got it wrong, the safe reading is "do not
 * send". The allowlist is enforced in `sendEmail` (lib/email.ts), the only
 * place that calls Resend, before any lookup or provider call.
 *
 * Its own module, not part of lib/email.ts, so that routes can ask "is mail
 * on?" without importing the Resend client — and so the many route tests that
 * replace lib/email.ts with a `sendEmail`-only mock keep working.
 */
/**
 * The production Neon endpoint — the same constant lib/testing-mode.ts,
 * tests/setup-test-db.ts and scripts/maybe-migrate.mjs use. Inlined rather than
 * imported so the many route tests that mock lib/testing-mode keep working.
 */
const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";

/** What screens show: `test` counts as on (mail can go out, to the test list only). */
export type EmailDeliveryMode = "on" | "off";

/** Why a send was deliberately not attempted (as opposed to failing). */
export type EmailSuppression = "delivery_off" | "provisional_recipient" | "recipient_not_allowlisted";

export type SendEmailResult = {
  ok: boolean;
  logId: string;
  /**
   * Set only when nothing was sent ON PURPOSE. Callers use it to tell the
   * person "email is turned off" rather than "the send failed, try again".
   */
  suppressed?: EmailSuppression;
};

/** Who may receive mail right now. */
export type EmailSendingPolicy =
  | { kind: "off" }
  | { kind: "open" }
  | { kind: "allowlist"; recipients: ReadonlySet<string> };

const ADDRESS = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function rawMode(): string | undefined {
  return process.env.EMAIL_DELIVERY?.trim().toLowerCase();
}

/** True for the real production runtime: Vercel production or the production database. */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production" || (process.env.DATABASE_URL ?? "").includes(PROD_NEON_ENDPOINT);
}

/** The EMAIL_TEST_RECIPIENTS list, normalised; entries that are not an address are dropped. */
export function testRecipients(): ReadonlySet<string> {
  return new Set(
    (process.env.EMAIL_TEST_RECIPIENTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => ADDRESS.test(s)),
  );
}

export function emailSendingPolicy(): EmailSendingPolicy {
  const raw = rawMode();
  if (raw === "test") return { kind: "allowlist", recipients: testRecipients() };
  if (raw === undefined || raw === "" || raw === "on") {
    return isProductionRuntime() ? { kind: "open" } : { kind: "allowlist", recipients: testRecipients() };
  }
  return { kind: "off" };
}

/** Whether `to` may receive mail under `policy`. Exact address match, case-insensitive. */
export function isRecipientAllowed(policy: EmailSendingPolicy, to: string): boolean {
  if (policy.kind === "open") return true;
  if (policy.kind === "off") return false;
  return policy.recipients.has(to.trim().toLowerCase());
}

export function emailDeliveryMode(): EmailDeliveryMode {
  return emailSendingPolicy().kind === "off" ? "off" : "on";
}

export function isEmailDeliveryOn(): boolean {
  return emailDeliveryMode() === "on";
}

/** True when EMAIL_DELIVERY holds something other than on/off/test/unset. */
export function emailDeliveryMisconfigured(): boolean {
  const raw = rawMode();
  return raw !== undefined && raw !== "" && raw !== "on" && raw !== "off" && raw !== "test";
}

/** The one sentence staff see when an action would have sent an email. */
export const EMAIL_OFF_MESSAGE = "Email is turned off for this club, so nothing was sent.";

/** For a recipient whose address is a provisional (unverified) login email. */
export const EMAIL_PROVISIONAL_MESSAGE =
  "That address is a provisional login email that has not been verified, so nothing was sent to it.";

/** For a recipient outside the test list while email is in test mode. */
export const EMAIL_NOT_ALLOWLISTED_MESSAGE =
  "Email is in test mode and that address is not on the test list, so nothing was sent.";

/** Staff-facing sentence for a suppressed result; null when it was not suppressed. */
export function suppressedMessage(result: { suppressed?: EmailSuppression } | null | undefined): string | null {
  if (!result?.suppressed) return null;
  if (result.suppressed === "delivery_off") return EMAIL_OFF_MESSAGE;
  if (result.suppressed === "recipient_not_allowlisted") return EMAIL_NOT_ALLOWLISTED_MESSAGE;
  return EMAIL_PROVISIONAL_MESSAGE;
}
