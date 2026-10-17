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
 *   EMAIL_DELIVERY=on   (or unset)  — on the Vercel production deployment
 *                                     (VERCEL_ENV=production, exposed at run
 *                                     time on this project): sends go to Resend
 *                                     for any recipient. ANYWHERE ELSE — local
 *                                     dev (even with the production .env),
 *                                     the test suite, a preview, a test
 *                                     deployment — `on` means `test`: only the
 *                                     listed addresses receive mail, and with
 *                                     no list nothing is sent.
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
 * What screens show. Test mode with at least one listed address counts as on
 * (mail can go out, to the list only); test mode with an empty list is off,
 * because nothing can be sent.
 */
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

/**
 * True only on the Vercel production deployment. The production database alone
 * does not count: a local `next dev` that loads the production .env, or a
 * preview pointed at production, must still mail the test list only.
 */
function isProductionRuntime(): boolean {
  return process.env.VERCEL_ENV === "production";
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
  const policy = emailSendingPolicy();
  if (policy.kind === "off") return "off";
  if (policy.kind === "allowlist" && policy.recipients.size === 0) return "off";
  return "on";
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
