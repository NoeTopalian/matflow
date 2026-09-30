/**
 * The member welcome sheet's device-side memory, and the class list its
 * "Which classes do you attend?" question offers.
 *
 * Two different keys, per member id, in this device's localStorage:
 *
 * - `bjj_onboarded:{id}` — the same-session SUPPRESSOR. Written only after the
 *   server has accepted `onboardingCompleted: true`, so the sheet cannot flash
 *   back in the gap before the next payload reflects it. Not the gate:
 *   `Member.onboardingCompleted` from the server is (RULES §2).
 * - `bjj_onboarding_skipped:{id}` — "Skip for now". End-user round 2 (3.2):
 *   the sheet came back on every Home visit after Skip. Skip now sticks for
 *   that member on that device; the server flag is unchanged, so the member
 *   has not been recorded as onboarded when they were not.
 *
 * Namespaced by member id so a second member on a shared device does not
 * inherit the first member's answer. Storage that throws (private mode,
 * blocked site data) reads as "not set" — the sheet shows, which is the safe
 * direction.
 */
const SUPPRESS_PREFIX = "bjj_onboarded:";
const SKIP_PREFIX = "bjj_onboarding_skipped:";

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function write(key: string): void {
  try {
    localStorage.setItem(key, "true");
  } catch {
    /* storage unavailable — the server flag still gates the sheet */
  }
}

export function onboardingSuppressed(memberId: string | null | undefined): boolean {
  return !!memberId && read(`${SUPPRESS_PREFIX}${memberId}`);
}

export function suppressOnboarding(memberId: string | null | undefined): void {
  if (memberId) write(`${SUPPRESS_PREFIX}${memberId}`);
}

export function onboardingSkipped(memberId: string | null | undefined): boolean {
  return !!memberId && read(`${SKIP_PREFIX}${memberId}`);
}

export function skipOnboarding(memberId: string | null | undefined): void {
  if (memberId) write(`${SKIP_PREFIX}${memberId}`);
}

/** Whether Home opens the welcome sheet for this member on this device. */
export function shouldShowOnboarding(me: { id?: string | null; onboardingCompleted?: boolean } | null | undefined): boolean {
  return me?.onboardingCompleted === false && !onboardingSuppressed(me?.id) && !onboardingSkipped(me?.id);
}

/**
 * The club's own class names, once each, in timetable order of first
 * appearance — from `/api/member/schedule`, which lists every active class of
 * this club. The sheet used to offer a fixed list ("Beginner BJJ, No-Gi, Open
 * Mat, Kids BJJ, Intermediate, Wrestling") whatever the club ran, so a club
 * running "Adult BJJ" had no option for it (end-user round 2, 3.2).
 */
export function clubClassNames(schedule: unknown): string[] {
  if (!Array.isArray(schedule)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of schedule) {
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : null;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    names.push(trimmed);
  }
  return names;
}
