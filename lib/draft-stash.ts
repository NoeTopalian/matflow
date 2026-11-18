// Round 11 (baseline 1.1 / 3.2): a save refused because someone else changed the record
// said "Reload … then make your change again", and the reload threw away everything typed.
// Before that reload the form now keeps ONLY the fields this person changed, in this tab's
// sessionStorage; after the reload they are put back on top of the other person's version.
// Fields this person never touched therefore come from the fresh record, so restoring the
// draft cannot undo the other person's edit to them.
//
// sessionStorage is per tab and can be unavailable (private mode, blocked storage): then
// nothing is kept and the reload behaves as before, which is the old behaviour, not a new loss.

const PREFIX = "matflow:draft:";

/** The keys whose value differs between the form as opened and the form now. */
export function changedKeys<T extends Record<string, unknown>>(opened: T, now: T): (keyof T)[] {
  return (Object.keys(now) as (keyof T)[]).filter((k) => JSON.stringify(opened[k]) !== JSON.stringify(now[k]));
}

/** Keep `data` for the next page load in this tab. Returns false when storage is unavailable. */
export function stashDraft(key: string, data: unknown): boolean {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Read a kept draft once: it is removed as it is read, so it is offered a single time. */
export function takeDraft<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    window.sessionStorage.removeItem(PREFIX + key);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
