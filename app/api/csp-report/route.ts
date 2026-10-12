/**
 * POST /api/csp-report — Content-Security-Policy violation reports
 * (security campaign iteration 2, lane C2, 9 Oct 2026; policy in lib/csp.ts).
 *
 * Browsers post here for the report-only nonce policy, in either format:
 *   - `report-uri`: `application/csp-report`, body `{ "csp-report": {…} }`
 *   - `report-to` (Reporting API): `application/reports+json`, body `[{ type: "csp-violation", body: {…} }]`
 *
 * COUNTS ONLY. A report carries the page address and the blocked address, and
 * on MatFlow those are credentials as often as not (/kiosk/<token>,
 * /waiver/<token>, /leaderboard/<token>, signed blob URLs). Nothing from a
 * report is logged or stored except the violated directive, the disposition
 * and a coarse class of what was blocked (inline / eval / data / blob / self /
 * external). No database write: the route is anonymous by design (a browser
 * sends reports without credentials), so storing anything would hand the
 * internet a table to fill.
 *
 * Bounded: the body is refused over 16 KB by Content-Length before it is read
 * and by its actual length after; at most 50 reports are tallied per request;
 * per-instance counters are capped at 64 keys. Always answers 204 for a
 * well-formed post so a browser never retries, 413 for an oversize body and
 * 400 for a malformed one.
 *
 * Not a data-changing route in the CSRF sense (no session authority, no write);
 * listed as exempt in tests/unit/sec-c-csrf-sweep.test.ts.
 */
import { NextResponse } from "next/server";
import { CSP_REPORT_MAX_BYTES, extractReports, readCappedText, tallyReports } from "@/lib/csp-report";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) {
    return new NextResponse(null, { status: 413 });
  }
  // Streamed with a cap: a chunked body has no Content-Length to judge.
  const text = await readCappedText(req, CSP_REPORT_MAX_BYTES);
  if (text === "too-large") return new NextResponse(null, { status: 413 });
  if (text === null) return new NextResponse(null, { status: 400 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const reports = extractReports(parsed);
  if (reports.length === 0) return new NextResponse(null, { status: 400 });

  const counts = tallyReports(reports);
  // One line per request, keys only (directive|class|disposition) — see the header comment.
  console.info(`[csp-report] ${JSON.stringify(counts)}`);
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
