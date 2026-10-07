/**
 * The mail-dark switch (7 Oct 2026, handover story US-003).
 *
 * `EMAIL_DELIVERY` decides whether MatFlow sends ANY email:
 *
 *   EMAIL_DELIVERY=on   (or unset)  — current behaviour: sends go to Resend.
 *   EMAIL_DELIVERY=off              — nothing is sent. `sendEmail` makes no
 *                                     Resend call, writes one EmailLog row at
 *                                     status "suppressed", and returns
 *                                     `{ ok: false, suppressed: "delivery_off" }`.
 *
 * Default `on` when unset: every existing environment (local dev, the test
 * suite, preview deploys) keeps the behaviour it has today, and turning mail
 * off is one explicit, reviewable variable rather than a side effect of a code
 * deploy. Any value other than `on`/`off` (a typo, "false", "0") is treated as
 * OFF: when someone has tried to configure the switch and got it wrong, the
 * safe reading is "do not send".
 *
 * Its own module, not part of lib/email.ts, so that routes can ask "is mail
 * on?" without importing the Resend client — and so the many route tests that
 * replace lib/email.ts with a `sendEmail`-only mock keep working.
 */

export type EmailDeliveryMode = "on" | "off";

/** Why a send was deliberately not attempted (as opposed to failing). */
export type EmailSuppression = "delivery_off" | "provisional_recipient";

export type SendEmailResult = {
  ok: boolean;
  logId: string;
  /**
   * Set only when nothing was sent ON PURPOSE. Callers use it to tell the
   * person "email is turned off" rather than "the send failed, try again".
   */
  suppressed?: EmailSuppression;
};

export function emailDeliveryMode(): EmailDeliveryMode {
  const raw = process.env.EMAIL_DELIVERY?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "on") return "on";
  return "off";
}

export function isEmailDeliveryOn(): boolean {
  return emailDeliveryMode() === "on";
}

/** True when EMAIL_DELIVERY holds something other than on/off/unset. */
export function emailDeliveryMisconfigured(): boolean {
  const raw = process.env.EMAIL_DELIVERY?.trim().toLowerCase();
  return raw !== undefined && raw !== "" && raw !== "on" && raw !== "off";
}

/** The one sentence staff see when an action would have sent an email. */
export const EMAIL_OFF_MESSAGE = "Email is turned off for this club, so nothing was sent.";

/** For a recipient whose address is a provisional (unverified) login email. */
export const EMAIL_PROVISIONAL_MESSAGE =
  "That address is a provisional login email that has not been verified, so nothing was sent to it.";

/** Staff-facing sentence for a suppressed result; null when it was not suppressed. */
export function suppressedMessage(result: { suppressed?: EmailSuppression } | null | undefined): string | null {
  if (!result?.suppressed) return null;
  return result.suppressed === "delivery_off" ? EMAIL_OFF_MESSAGE : EMAIL_PROVISIONAL_MESSAGE;
}
