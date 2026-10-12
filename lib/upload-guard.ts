/**
 * Upload controls shared by every multipart route (security campaign
 * iteration 2, lane C2, 9 Oct 2026 — SF-40 / SEC-051 / SEC-073).
 *
 * Inventory of multipart / blob-writing routes (evidence/C2/04-upload-controls.md):
 *   /api/upload                          images (owner, or staff/member-self for profile pictures)
 *   /api/initiatives/[id]/attachments    images + PDF (owner/manager)
 *   /api/onboarding/csv-handoff          CSV, emails the MatFlow team (owner)
 *   /api/admin/import/upload             CSV import (owner)
 *   /api/admin/import/uploads/**         chunked CSV import — already limited per tenant (lib/import-upload)
 *
 * RATE LIMITS — what backs them, stated plainly. lib/rate-limit.ts counts hits
 * in the RateLimitHit table, so while the database answers the limit is SHARED
 * by every Vercel instance. If the database call fails it falls back to an
 * in-memory Map that is PER INSTANCE: with N warm instances the effective
 * ceiling during that fault is N × the limit. The limits below are sized so
 * that even N = 20 instances × limit stays cheap (an image decode is bounded at
 * 50 MP by sharp's limitInputPixels; ~1 s CPU worst case). While the database
 * answers, the shared limit is exact under concurrency (lane C3, 9 Oct 2026:
 * per-bucket advisory lock + conditional insert; a burst of 20 against max 5
 * lets exactly 5 through under both roles). The per-instance fallback is still
 * N × the limit, so no distributed exact limit is claimed during a fault.
 *
 * WHAT "BEFORE THE BODY" MEANS. Inside the handler, a refused caller's body is
 * never parsed, decoded or stored. It is still RECEIVED: behind proxy.ts,
 * Next 16 drains the whole request body (buffering up to
 * experimental.proxyClientMaxBodySize, 10 MB by default) before the handler
 * runs, so a 413/401/429 reaches the client only after the upload completes.
 * And a body with no Content-Length (chunked) passes the declared-size check,
 * so its caller's rate-limit budget is spent before the parsed size refuses it.
 *
 * Two buckets per request: per user (one account cannot burn the club's
 * allowance alone) and per tenant (many accounts in one club cannot exceed the
 * club's share). The user bucket is checked first so a refused user does not
 * spend the tenant's budget.
 */
import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

type Window = { max: number; windowMs: number };
export type UploadKind = "image" | "attachment" | "csvHandoff" | "importUpload";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const UPLOAD_LIMITS: Record<UploadKind, { perUser: Window; perTenant: Window }> = {
  // Profile pictures, member photos, logos, announcement images: one at a time from the UI.
  image: { perUser: { max: 30, windowMs: 10 * MIN }, perTenant: { max: 300, windowMs: HOUR } },
  attachment: { perUser: { max: 30, windowMs: 10 * MIN }, perTenant: { max: 200, windowMs: HOUR } },
  // Each accepted hand-off emails the MatFlow team: a mail budget as much as a CPU one.
  csvHandoff: { perUser: { max: 10, windowMs: HOUR }, perTenant: { max: 20, windowMs: 24 * HOUR } },
  importUpload: { perUser: { max: 30, windowMs: HOUR }, perTenant: { max: 60, windowMs: HOUR } },
};

/** A 429 in the API's refusal shape, or null when both buckets allow the request. */
export async function checkUploadRateLimit(
  kind: UploadKind,
  tenantId: string,
  userId: string,
): Promise<NextResponse | null> {
  const lim = UPLOAD_LIMITS[kind];
  const user = await checkRateLimit(`upload:${kind}:user:${userId}`, lim.perUser.max, lim.perUser.windowMs);
  const verdict = user.allowed
    ? await checkRateLimit(`upload:${kind}:tenant:${tenantId}`, lim.perTenant.max, lim.perTenant.windowMs)
    : user;
  if (verdict.allowed) return null;
  return NextResponse.json(
    { ok: false, error: "Too many uploads just now. Please wait a few minutes and try again." },
    { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
  );
}

/**
 * The declared body length, judged before the handler parses the body (it has
 * already been received — see the header comment). Returns a 413 when
 * Content-Length exceeds `maxBytes` plus a small multipart-overhead allowance,
 * else null. The declared length is only ever used to refuse: the parsed
 * file's own size stays the authority on what is accepted, so a lying header
 * buys nothing. A missing header is not refused here (the platform caps the
 * body at ~4.5 MB on Vercel; locally the per-file checks still apply).
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export function refuseOversizeBody(req: Request, maxBytes: number, message: string): NextResponse | null {
  const raw = req.headers.get("content-length");
  if (raw === null) return null;
  const declared = Number(raw);
  if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD_BYTES) {
    return NextResponse.json({ ok: false, error: message }, { status: 413 });
  }
  return null;
}

/**
 * Multipart fields as a plain object for a zod schema, refusing a field sent
 * twice (two `file` parts, or two `targetMemberId`s, would otherwise be decided
 * by which one `formData.get` happens to return).
 */
export function formFields(fd: FormData): { ok: true; fields: Record<string, FormDataEntryValue> } | { ok: false; duplicate: string } {
  const fields: Record<string, FormDataEntryValue> = Object.create(null);
  for (const [k, v] of fd.entries()) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) return { ok: false, duplicate: k };
    fields[k] = v;
  }
  return { ok: true, fields: { ...fields } };
}

// C0/C1 controls and DEL; bidi embeddings, overrides and isolates (RLO "gnp.exe" spoofing);
// zero-width characters and the BOM.
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩؜﻿]/g;

/**
 * The client's filename, made safe to store and show: Unicode NFC, the last
 * path segment only (a name like `..\\..\\x.csv` or `/etc/passwd` keeps just its
 * basename), control / bidi / zero-width characters removed, whitespace
 * collapsed, leading dots and spaces and trailing dots and spaces trimmed,
 * at most 200 code points. Never used as a storage key — every route builds
 * its blob path from server ids — only stored for display.
 */
export function normaliseUploadFilename(name: unknown, fallback = "upload"): string {
  if (typeof name !== "string") return fallback;
  let n = name.normalize("NFC").replace(UNSAFE_FILENAME_CHARS, "");
  const parts = n.split(/[/\\]/);
  n = parts[parts.length - 1] ?? "";
  n = n.replace(/\s+/g, " ").replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  n = Array.from(n).slice(0, 200).join("");
  return n.length > 0 ? n : fallback;
}
