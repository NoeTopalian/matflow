import type { ReactNode } from "react";

const URL_REGEX = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
const TRAILING_PUNCT = /[.,;!?)\]"'>]+$/;

/**
 * Convert a plain-text string into an array of React nodes, with
 * URLs wrapped in <a> tags. NEVER uses dangerouslySetInnerHTML.
 * Only http: and https: schemes produce links; other protocols
 * (javascript:, data:, vbscript:, file:) render as plain text.
 *
 * Trailing punctuation (.,;!?)]"'>) is stripped from the link
 * and rendered as text after.
 */
export function linkify(input: string): ReactNode[] {
  if (!input) return [];
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let matchIdx = 0;
  for (const match of input.matchAll(URL_REGEX)) {
    const startIdx = match.index ?? 0;
    const raw = match[0];
    const trailing = raw.match(TRAILING_PUNCT)?.[0] ?? "";
    const url = trailing ? raw.slice(0, -trailing.length) : raw;

    // Plain segment before this match
    if (startIdx > lastIdx) {
      out.push(input.slice(lastIdx, startIdx));
    }

    // Build href: prepend https:// if it's a www. match
    const href = url.startsWith("www.") ? `https://${url}` : url;
    const safe = /^https?:\/\//i.test(href);

    if (safe) {
      out.push(
        <a
          key={`lnk-${matchIdx++}`}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {url}
        </a>,
      );
    } else {
      out.push(url);
    }

    if (trailing) out.push(trailing);
    lastIdx = startIdx + raw.length;
  }
  if (lastIdx < input.length) {
    out.push(input.slice(lastIdx));
  }
  return out;
}
