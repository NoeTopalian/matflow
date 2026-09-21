/**
 * CSV cells that are safe for BOTH an RFC-4180 parser and a spreadsheet app.
 *
 * Two independent hazards, two defences — you need both:
 *
 *  1. Delimiter / newline / quote injection → RFC-4180 quoting: when a value
 *     contains a quote, comma, CR or LF, wrap it in quotes and double the inner
 *     quotes. Without this a member named `Smith, John` splits the row.
 *
 *  2. FORMULA injection → a TEXT value whose first character is `= + - @`, tab
 *     or CR is evaluated as a formula by Excel / Google Sheets / LibreOffice
 *     when the file is opened: `=cmd|'/c calc'!A1`, `@SUM(...)`, `+...`, `-...`.
 *     A member can set their own name, so this is reachable from user input.
 *     Neutralise by prefixing a single apostrophe, which every spreadsheet
 *     treats as "this cell is literal text". Applied BEFORE quoting so the
 *     apostrophe sits inside the quoted field.
 *
 * Quoting alone does not stop formula execution (a quoted `="…"` is still
 * evaluated on open), and the prefix alone does not stop a comma splitting the
 * row — hence both, in this order.
 *
 * Numbers we render ourselves are never an injection vector (a negative amount
 * like -50 is data, not a formula), so they bypass the prefix guard — otherwise
 * every negative figure would be smeared with a leading apostrophe and stop
 * being a number in the sheet. Only STRING values, which can carry user input,
 * are guarded.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);

  let s = v;
  // (2) Formula-injection guard — leading =, +, -, @, tab or CR.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // (1) RFC-4180 quoting.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** One CSV line from a row of raw values, each passed through {@link csvCell}. */
export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}
