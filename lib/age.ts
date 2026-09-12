/**
 * Age in whole years from a date of birth.
 *
 * WHY THIS IS SERVER-SIDE
 * -----------------------
 * The kiosk shows a child's age beside their name so a parent can tell two
 * children apart at the door. It used to do that by receiving the child's full
 * DATE OF BIRTH from `/api/kiosk/[token]/members` and computing the age in the
 * browser — on an endpoint that is unauthenticated by design, excluded from
 * middleware, and searchable on a two-character prefix. Anyone with the kiosk
 * URL, which lives in a tablet's address bar at the front desk, could walk the
 * roster and harvest minors' birth dates. That route's own header comment even
 * claimed the response "intentionally omits PII (email, phone, DOB…)".
 *
 * An age is what the interface actually needs, and an integer year is far less
 * identifying than an exact date. So the derivation happens here, on the
 * server, and the date never leaves it.
 *
 * Returns null for a missing, unparseable or implausible date rather than
 * guessing — the caller renders nothing, which is the honest outcome.
 */
export function ageFromDateOfBirth(dateOfBirth: Date | string | null | undefined): number | null {
  if (!dateOfBirth) return null;
  const dob = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();

  // Not yet had this year's birthday — compare month, then day. Done with
  // getMonth/getDate rather than by constructing a date, because constructing
  // "this year's birthday" for someone born on 29 February silently rolls to
  // 1 March and ages them a day early every non-leap year.
  const beforeBirthday =
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthday) age -= 1;

  // A future date of birth or a typo'd century is bad data, not an age.
  return age >= 0 && age < 150 ? age : null;
}
