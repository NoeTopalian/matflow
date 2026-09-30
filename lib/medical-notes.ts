/**
 * `Member.medicalConditions` is a nullable string that has been written three
 * ways over time: free text from the desk, a JSON array from the member
 * welcome wizard, and — the one the register printed as a red "⚠ []" on
 * 26 Sep 2026 (customer simulation F-7) — the JSON of an EMPTY array when the
 * member ticked nothing.
 *
 * One reader for all three. Returns the text to show, or null when there is
 * nothing to show, so a caller can never flag "Medical" on an empty value.
 * Pure; safe on the client and at the API boundary.
 */
export function medicalNotesText(raw: unknown): string | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return joinNotes(raw);
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s === "null" || s === "[]" || s === "{}") return null;
  if (s.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return joinNotes(parsed);
    } catch {
      /* not JSON after all: fall through and show the text as typed */
    }
  }
  return s;
}

/**
 * The welcome wizard offers "None of the above"; ticking it is an answer, not
 * a condition. It (and a bare "none" / "n/a") must never raise a Medical flag
 * (Wave 1 re-drive, 30 Sep 2026: the register showed "Medical — None of the
 * above" in red).
 */
const NO_CONDITION = /^(none( of the above)?|n\/?a|no)$/i;

function joinNotes(items: unknown[]): string | null {
  const parts = items
    .map((x) => (typeof x === "string" ? x.trim() : x == null ? "" : String(x).trim()))
    .filter((x) => x && !NO_CONDITION.test(x));
  return parts.length ? parts.join("; ") : null;
}

/**
 * What to WRITE for a list the member ticked: null when the list is empty, so
 * the column never holds "[]" again.
 */
export function medicalNotesFromList(items: unknown[]): string | null {
  const text = joinNotes(items);
  return text === null ? null : JSON.stringify(items.map((x) => String(x).trim()).filter(Boolean));
}
