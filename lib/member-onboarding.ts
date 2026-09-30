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

/**
 * Names of the children already linked to this member, from
 * GET /api/member/me/children. The welcome question "Any children training
 * here?" used to ignore them, so a parent whose children the desk had already
 * linked was invited to add them again (end-user round 3, 30 Sep 2026).
 */
export function linkedChildNames(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const names: string[] = [];
  for (const entry of payload) {
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : null;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}

/** "Already linked: Kai, Mia" — null when there is no one to name. */
export function alreadyLinkedLine(names: string[]): string | null {
  return names.length > 0 ? `Already linked: ${names.join(", ")}` : null;
}

/**
 * The typed names that match a child already linked (case and spacing
 * ignored). The step refuses to continue while any remain, so a parent cannot
 * create a second profile for a child the desk already linked.
 */
export function duplicateOfLinked(typed: string[], linked: string[]): string[] {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const have = new Set(linked.map(norm));
  return typed.filter((t) => t.trim() && have.has(norm(t)));
}
