/**
 * Email-shape advice for account creation (1 Oct 2026).
 *
 * The decision behind it: an OWNER (or manager/admin) login must be a
 * person's own address, because owner alerts name members and payment states
 * and a password reset lands there. The club's shared inbox (`info@…`) is for
 * members to write to and goes in Settings → Contact email, never on a staff
 * login. A shared mailbox read by desk staff would hand them the owner's
 * alerts and the reset link.
 *
 * This is ADVICE, not a block: a one-person club may legitimately run on
 * `info@`. Callers show a warning and still allow the submit.
 */
const ROLE_MAILBOX_LOCALS = new Set([
  "info",
  "admin",
  "administrator",
  "contact",
  "hello",
  "hi",
  "office",
  "enquiries",
  "enquiry",
  "inquiries",
  "sales",
  "support",
  "team",
  "mail",
  "reception",
  "frontdesk",
  "desk",
  "bookings",
  "noreply",
  "no-reply",
]);

/** True when the local part reads as a shared/role mailbox rather than a person. */
export function looksLikeSharedMailbox(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).trim().toLowerCase();
  // "info+sean", "info.desk" — the prefix is what the inbox is.
  const head = local.split(/[+.]/)[0];
  return ROLE_MAILBOX_LOCALS.has(local) || ROLE_MAILBOX_LOCALS.has(head);
}

/** One sentence for the UI, so every surface says the same thing. */
export const SHARED_MAILBOX_WARNING =
  "This looks like a shared club inbox. Use a personal address for this login — alerts and password resets go here. Put the club's shared address in Settings → Contact email so members can reach you.";
