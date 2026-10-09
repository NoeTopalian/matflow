/**
 * Helpers for app/api/csp-report/route.ts (lane C2, 9 Oct 2026). Kept out of
 * the route file because a Next route module may export only handlers and
 * route config. COUNTS ONLY — see the route's header comment.
 */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
export const MAX_REPORTS_PER_REQUEST = 50;
export const MAX_KEYS = 64;

const DIRECTIVE_RE = /^[a-z-]{1,40}$/;

/** Per-instance running totals since boot (no persistence by design). */
const totals = new Map<string, number>();

export function cspReportTotals(): Record<string, number> {
  return Object.fromEntries(totals);
}
export function resetCspReportTotals(): void {
  totals.clear();
}

/** A coarse class for the blocked resource — never the address itself. */
export function blockedClass(blocked: unknown, documentUri?: unknown): string {
  if (typeof blocked !== "string" || blocked === "") return "unknown";
  const b = blocked.toLowerCase();
  if (b === "inline" || b === "eval" || b === "wasm-eval" || b === "trusted-types-policy" || b === "trusted-types-sink") return b;
  if (b.startsWith("data")) return "data";
  if (b.startsWith("blob")) return "blob";
  try {
    const u = new URL(blocked);
    if (typeof documentUri === "string") {
      try {
        if (new URL(documentUri).origin === u.origin) return "self";
      } catch {
        /* fall through */
      }
    }
    return u.protocol === "https:" || u.protocol === "http:" ? "external" : "other";
  } catch {
    return "other";
  }
}

export function directiveOf(r: Record<string, unknown>): string {
  const d = r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"] ?? r.violatedDirective;
  if (typeof d !== "string") return "unknown";
  const first = d.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return DIRECTIVE_RE.test(first) ? first : "unknown";
}

export function dispositionOf(r: Record<string, unknown>): string {
  const d = r.disposition;
  return d === "enforce" || d === "report" ? d : "unknown";
}

/** Pull the violation bodies out of either wire format. Exported for the unit test. */
export function extractReports(parsed: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v) && out.length < MAX_REPORTS_PER_REQUEST) {
      out.push(v as Record<string, unknown>);
    }
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (out.length >= MAX_REPORTS_PER_REQUEST) break;
      if (item && typeof item === "object" && (item as { type?: unknown }).type === "csp-violation") {
        push((item as { body?: unknown }).body);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    push((parsed as Record<string, unknown>)["csp-report"]);
  }
  return out;
}

/** Tally one request's reports into per-key counts and the per-instance totals. */
export function tallyReports(reports: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of reports) {
    const key = `${directiveOf(r)}|${blockedClass(r["blocked-uri"] ?? r.blockedURL ?? r.blockedUri, r["document-uri"] ?? r.documentURL)}|${dispositionOf(r)}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (totals.has(key) || totals.size < MAX_KEYS) totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Read a request body as UTF-8, refusing past `max` bytes without buffering
 * the rest. Returns "too-large", null for an unreadable body, or the text.
 */
export async function readCappedText(req: Request, max: number): Promise<string | null | "too-large"> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}
