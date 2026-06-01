/**
 * Shared sanitiser for free-text "notes" fields written by staff or members.
 *
 * Used by:
 *   - Member.notes               (max 2000, lib/schemas/member.ts)
 *   - RankHistory.notes          (max 500, app/api/members/[id]/rank/route.ts)
 *   - GymApplication.notes       (max 2000, app/api/apply/route.ts message field)
 *   - Task.body                  (max 1000, app/api/tasks/route.ts member_note kind)
 *
 * Goals (Phase 1 of feat/member-tickable-notes):
 *   1. Strip every control + zero-width + line-separator character that lets
 *      a hostile string break a renderer, log line, email subject, JSON
 *      response, or downstream NLP/search index. Keep printable text + the
 *      three whitespace characters humans actually type: TAB (U+0009), LF
 *      (U+000A), CR (U+000D).
 *   2. Trim surrounding whitespace.
 *   3. Coerce a now-empty string to null so the column stays explicit about
 *      "no content" instead of carrying an empty-string sentinel.
 *
 * Deliberately OUT OF SCOPE: HTML escaping. The notes value is rendered as a
 * React text node (or escaped via lib/email.ts escape() for emails) — the
 * renderer is the canonical XSS boundary. Sanitising HTML here would silently
 * swallow legitimate angle-bracket text like "<5kg loss this month".
 *
 * The transform is idempotent: sanitiseNoteText(sanitiseNoteText(s)) === sanitiseNoteText(s).
 */
import { z } from "zod";

// Codepoints stripped (allow-list keeps TAB U+0009, LF U+000A, CR U+000D):
//   U+0000..U+0008   NUL..BS                (C0 control)
//   U+000B           VT                     (C0 control)
//   U+000C           FF                     (C0 control)
//   U+000E..U+001F   SO..US                 (C0 control)
//   U+007F..U+009F   DEL + C1 controls      (C1 control)
//   U+200B..U+200F   ZWSP, ZWNJ, ZWJ, LRM, RLM
//   U+2028           LINE SEPARATOR
//   U+2029           PARAGRAPH SEPARATOR
//   U+202A..U+202E   BiDi overrides (anti-spoofing)
//   U+2060           WORD JOINER
//   U+2066..U+2069   BiDi isolates (anti-spoofing)
//   U+FEFF           BOM / ZWNBSP
//
// Pattern is built programmatically from numeric ranges so the source file
// stays pure printable ASCII. None of the listed codepoints are the regex
// character-class metacharacters (], \, ^, -), so no escaping is needed inside
// the [...] class.
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x000b],
  [0x000c, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x2028],
  [0x2029, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function buildStripPattern(): RegExp {
  let body = "[";
  for (const [lo, hi] of STRIP_RANGES) {
    if (lo === hi) {
      body += String.fromCharCode(lo);
    } else {
      body += String.fromCharCode(lo) + "-" + String.fromCharCode(hi);
    }
  }
  body += "]";
  return new RegExp(body, "g");
}

const STRIP_PATTERN = buildStripPattern();

/**
 * Apply the input-side notes hygiene transform.
 *
 * - Returns null for input that is null, undefined, or empty-after-strip.
 * - Returns a trimmed, control-stripped string otherwise.
 */
export function sanitiseNoteText(input: string | null | undefined): string | null {
  if (input == null) return null;
  const stripped = input.replace(STRIP_PATTERN, "").trim();
  return stripped.length === 0 ? null : stripped;
}

/**
 * Zod helper: a Zod schema that accepts string | null | undefined, enforces
 * maxLength BEFORE strip (so a hostile padded-with-controls payload cannot
 * smuggle 5x its rendered length past the limit), then runs sanitiseNoteText.
 *
 * Returns null for whitespace-only or all-stripped inputs.
 */
export function notesField(maxLength: number) {
  return z
    .string()
    .max(maxLength)
    .nullish()
    .transform((s) => sanitiseNoteText(s ?? null));
}
