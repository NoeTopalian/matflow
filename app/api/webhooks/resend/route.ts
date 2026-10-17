/**
 * Resend webhook — receives delivery / bounce / complaint events and moves the
 * matching EmailLog row forward.
 *
 * Set up: docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md (test) and
 * docs/EMAIL-SETUP-RUNBOOK.md Step 11 (production). Resend signs every request
 * with Svix; a webhook is account-wide (it receives events for every email the
 * Resend account sends), so this route only ever updates an EmailLog row that
 * THIS database wrote, and only when the event names the same recipient.
 *
 * Contract (17 Oct 2026):
 * - RESEND_WEBHOOK_SECRET is required in every environment: without it, or
 *   with a value that is not a Svix secret, the route answers 503 and
 *   processes nothing (no unsigned fallback).
 * - The signature is verified on the raw request body before anything is
 *   parsed. Missing, invalid or stale (Svix's 5-minute timestamp tolerance)
 *   signatures → 401.
 * - Duplicates are safe: Resend retries keep the same svix-id and the status
 *   only moves forward, so a repeated event changes nothing ("duplicate").
 * - Out of order is safe: each status has a rank and an event never lowers it;
 *   the write is conditional on the status that was read, so two concurrent
 *   events cannot let a lower one land last.
 * - A database failure answers 500 so Resend retries (safe because of the two
 *   rules above). An unknown email id less than 15 minutes old answers 409
 *   (sendEmail may not have recorded it yet) so Resend retries; an older one,
 *   and other event types, answer 200 and change nothing.
 * - Logs carry the svix-id, Resend email id, event type and outcome only —
 *   never the secret, the body, a recipient address or a provider message.
 *   The ids and type come from the request, so they are cut to a safe
 *   character set before they are logged.
 * - email.suppressed is recorded as bounced: Resend refused the address, so
 *   sendEmail's bounce short-circuit stops later sends to it too.
 */
import { Webhook } from "svix";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ResendEvent = {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
};

// Status precedence. A webhook event whose rank is below the current status is
// ignored, and an event at the same status is a duplicate. delivery_delayed is
// transient: it can move a sent email on, but never a delivered or terminal one.
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivery_delayed: 1.5,
  delivered: 2,
  failed: 3,
  bounced: 4,          // terminal
  complained: 5,       // strongest — never overwritten by anything
};

const EMAIL_ADDRESS = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g;

// sendEmail records the Resend id only after Resend's API call returns, so a
// fast event (email.sent especially) can arrive first. A recent unknown id is
// answered 409 and Resend retries (5 s, then 5 min); after this window an
// unknown id is not ours — another tool on the same Resend account — and is
// acknowledged so it stops retrying.
const RECENT_UNKNOWN_MS = 15 * 60 * 1000;

const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/]{32,}={0,2}$/;
const MAX_BODY_BYTES = 256 * 1024;

function isRecent(createdAt: string | undefined): boolean {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && Math.abs(Date.now() - t) <= RECENT_UNKNOWN_MS;
}

/** Map an event to the EmailLog status it means, and a reason for the operator (no addresses). */
function mapEvent(event: ResendEvent): { status: string; reason: string | null } | null {
  switch (event.type) {
    case "email.sent":
      return { status: "sent", reason: null };
    case "email.delivered":
      return { status: "delivered", reason: null };
    case "email.delivery_delayed":
      return { status: "delivery_delayed", reason: "Resend reported delivery delayed" };
    case "email.failed":
      return { status: "failed", reason: "Resend reported failed" };
    case "email.suppressed":
      return { status: "bounced", reason: "Resend suppressed the send (recipient on Resend's suppression list)" };
    case "email.bounced": {
      const b = event.data?.bounce;
      const parts = [b?.type, b?.subType, b?.message].filter(Boolean).join(" — ").replace(EMAIL_ADDRESS, "[address]");
      return { status: "bounced", reason: parts.slice(0, 500) || "bounced" };
    }
    case "email.complained":
      return { status: "complained", reason: "Recipient marked as spam" };
    default:
      // opened / clicked / received / scheduled / domain.* / contact.*: nothing to record.
      return null;
  }
}

/** A request-supplied id or type, reduced to characters that cannot forge a log line. */
function safe(v: unknown, max = 64): string {
  return String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, max) || "-";
}

function recipients(event: ResendEvent): string[] {
  const to = event.data?.to;
  return (Array.isArray(to) ? to : to ? [to] : []).map((a) => String(a).trim().toLowerCase());
}

export async function POST(req: Request) {
  const svixId = req.headers.get("svix-id") ?? "";
  const outcome = (o: string, extra = "", status = 200, body: Record<string, unknown> = {}) => {
    console.info(`[resend-webhook] svix=${safe(svixId)} ${extra}outcome=${o}`);
    return NextResponse.json({ ok: status < 400, outcome: o, ...body }, { status });
  };

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return outcome("not_configured", "", 503, { error: "Webhook secret not configured" });

  // Not a full Svix secret (the whsec_… value Resend shows; at least 24 key
  // bytes): a set-up fault, not a bad request — 503 so it is not mistaken for
  // forged traffic. svix itself accepts "whsec_" or a short value, and a key
  // that weak would let anyone sign events.
  let webhook: Webhook;
  try {
    if (!WEBHOOK_SECRET.test(secret.trim())) throw new Error("weak secret");
    webhook = new Webhook(secret.trim());
  } catch {
    return outcome("misconfigured_secret", "", 503, { error: "Webhook secret is not valid" });
  }

  // Resend events are a few KB; refuse a large unauthenticated body before reading it.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return outcome("body_too_large", "", 413, { error: "Payload too large" });
  }
  const rawBody = await req.text();
  try {
    webhook.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    });
  } catch {
    return outcome("rejected_signature", "", 401, { error: "Invalid signature" });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return outcome("bad_json", "", 400, { error: "Invalid JSON" });
  }

  const resendId = typeof event.data?.email_id === "string" ? event.data.email_id : "";
  const tag = `email=${safe(resendId)} type=${safe(event.type, 40)} `;
  const mapped = mapEvent(event);
  if (!mapped) return outcome("ignored_type", tag);
  if (!resendId) return outcome("ignored_no_email_id", tag);

  try {
    // Cross-tenant by nature: Resend does not know which club an email
    // belongs to; the unique resendId (written by sendEmail) does.
    // Every lost conditional update means a strictly higher status was written,
    // so one attempt per rank always reaches a decision.
    for (let attempt = 0; attempt < Object.keys(STATUS_RANK).length; attempt++) {
      const existing = await withRlsBypass((tx) =>
        tx.emailLog.findUnique({ where: { resendId }, select: { id: true, status: true, recipient: true } }),
      );
      if (!existing) {
        return isRecent(event.created_at)
          ? outcome("retry_unknown_recent", tag, 409, { error: "Email not recorded yet; retry" })
          : outcome("ignored_unknown_email", tag);
      }
      if (!recipients(event).includes(existing.recipient.trim().toLowerCase())) return outcome("ignored_recipient_mismatch", tag);

      const currentRank = STATUS_RANK[existing.status] ?? 0;
      const nextRank = STATUS_RANK[mapped.status] ?? 0;
      if (mapped.status === existing.status) return outcome("duplicate", tag);
      if (nextRank < currentRank) return outcome("ignored_would_downgrade", tag);

      // Conditional on the status just read: if another delivery moved the row
      // in between, re-read and decide again.
      const res = await withRlsBypass((tx) =>
        tx.emailLog.updateMany({
          where: { id: existing.id, status: existing.status },
          // The reason belongs to the new status: delivered clears a delay note.
          data: { status: mapped.status, errorMessage: mapped.reason },
        }),
      );
      if (res.count === 1) return outcome("applied", `${tag}from=${existing.status} to=${mapped.status} `);
    }
    return outcome("conflict_retry", tag, 500, { error: "Concurrent update; retry" });
  } catch (err) {
    console.error(`[resend-webhook] svix=${safe(svixId)} ${tag}database error ${err instanceof Error ? err.name : "unknown"}`);
    return outcome("db_error", tag, 500, { error: "Database error; Resend will retry" });
  }
}
