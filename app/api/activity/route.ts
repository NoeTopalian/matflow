import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { TenantTransactionBudgetError, withTenantContext } from "@/lib/prisma-tenant";
import { usableTimezone } from "@/lib/class-time";
import { clubDayKey, clubDayWindow, parseDayKey, shiftDayKey } from "@/lib/club-month";
import { formatDate } from "@/lib/date";
import { parseIdParam } from "@/lib/id-param";
import { ERASED_EMAIL } from "@/lib/login-email";
import { formatMoney } from "@/lib/payment-totals";
import { decideUndo } from "@/lib/undo-registry";
import { parseTypesParam, type ActivityResponse, type ActivityRole, type FeedEntry } from "@/lib/activity-types";
import {
  FEED_ROW_SELECT,
  UNDO_PREFIX,
  classWhere,
  loadLookups,
  memberWhere,
  paymentWhere,
  plainFallbackEntry,
  tierWhere,
  toFeedEntries,
  visibleWhere,
  whereForTypes,
  type ActivityLookups,
  type EntryExtras,
  type FeedRow,
} from "@/lib/activity-feed";

/**
 * GET /api/activity — the Activity timeline's one read (5 Nov 2026).
 *
 * Owner and managers. A manager is only ever sent club-life rows: the
 * restriction is ANDed into the query here, whatever the request asks for.
 *
 * Parameters (a bad value is ignored or clamped — it never fails the page):
 *   types      a view key ("club", "money", …) or a comma list of type keys
 *   memberId   activity about one member        classId    about one class
 *   paymentId  one payment's trail              tierId     naming one plan
 *   userId     done by one staff member
 *   day        "YYYY-MM-DD", a club day: rows up to the END of that day
 *   cursor     the last entry's id              take       1–50 (default 50)
 *   embed=1    a timeline inside another page: no undo lookup, no `undo`
 *
 * The response is a closed shape (ActivityResponse, lib/activity-types.ts). No AuditLog row, no
 * metadata, address, operator id or request id is ever serialised.
 *
 * Two transactions, so that a failed NAME lookup cannot fail the page: the
 * first reads the rows; the second resolves the people and things they name.
 * If the second fails the page is served as plain sentences (`enriched:
 * false`). Never a try/catch inside a tenant transaction — one failed
 * statement aborts all of it.
 */

const MAX_TAKE = 50;
/** Requests per person per minute. A page load is one; paging and filtering are one each. */
const RATE_MAX = 120;
const RATE_WINDOW_MS = 60_000;
/** The log is kept for a year (lib/audit-log.ts AUDIT_LOG_RETENTION_MS). */
const RETENTION_DAYS = 365;
/** A member's payments read to find rows on those payments (a refund carries no member id). */
const MEMBER_PAYMENTS_CAP = 500;
const LOOKUP_BUDGET_MS = 5_000;
const SLOW_MS = 1_000;

const TOO_MUCH = "That's too much to load at once. Jump to a date or narrow the filters.";
const NO_STORE = { "Cache-Control": "private, no-store" };

function takeOf(raw: string | null): number {
  const n = raw == null ? MAX_TAKE : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TAKE) : MAX_TAKE;
}

/** A statement the database cancelled for running too long, or a transaction past its budget. */
function isTimeout(e: unknown): boolean {
  if (e instanceof TenantTransactionBudgetError) return true;
  const err = e as { code?: unknown; message?: unknown; meta?: { code?: unknown }; cause?: { originalCode?: unknown } } | null;
  if (!err || typeof err !== "object") return false;
  if (err.code === "P2028" || err.code === "57014" || err.meta?.code === "57014" || err.cause?.originalCode === "57014") return true;
  return /\b57014\b|statement timeout/i.test(typeof err.message === "string" ? err.message : "");
}

type Where = Prisma.AuditLogWhereInput;

export async function GET(req: Request) {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const role = gate.role as ActivityRole;

  const limit = await checkRateLimit(`activity:${tenantId}:${userId}`, RATE_MAX, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, code: "rate_limited", error: "Too many requests. Try again in a moment." }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfterSeconds) } });
  }

  const params = new URL(req.url).searchParams;
  const types = parseTypesParam(params.get("types"), role);
  const asked = {
    member: parseIdParam(params.get("memberId")),
    class: parseIdParam(params.get("classId")),
    payment: parseIdParam(params.get("paymentId")),
    tier: parseIdParam(params.get("tierId")),
    staff: parseIdParam(params.get("userId")),
  };
  const dayAsked = parseDayKey(params.get("day"));
  const cursor = parseIdParam(params.get("cursor"));
  const take = takeOf(params.get("take"));
  const embed = params.get("embed") === "1";
  const withUndo = role === "owner" && !embed;

  let first: {
    timeZone: string;
    clock: ActivityResponse["clock"];
    filters: Omit<ActivityResponse["filters"], "types">;
    rows: FeedRow[];
    hasMore: boolean;
    undone: Set<string>;
  };
  const startedRows = Date.now();
  try {
    first = await withTenantContext(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      const timeZone = usableTimezone(tenant?.timezone);
      const todayKey = clubDayKey(new Date(), timeZone);
      const minDayKey = shiftDayKey(todayKey, -RETENTION_DAYS);
      let dayKey = dayAsked;
      let clamped = false;
      if (dayKey && dayKey > todayKey) dayKey = todayKey;
      if (dayKey && dayKey < minDayKey) {
        dayKey = minDayKey;
        clamped = true;
      }

      const filters: Omit<ActivityResponse["filters"], "types"> = { member: null, class: null, payment: null, tier: null, staff: null, dayKey };
      const and: Where[] = [{ tenantId }, visibleWhere(role), whereForTypes(types.keys, role)];
      // An id that is not a record of this club selects nothing — and the audit query is not run for it.
      let unknown = false;

      if (asked.member) {
        const member = await tx.member.findFirst({ where: { id: asked.member, tenantId }, select: { id: true, name: true, email: true } });
        filters.member = { id: asked.member, name: member ? (ERASED_EMAIL.test(member.email) ? "Deleted member" : member.name) : null };
        if (member) {
          const payments = await tx.payment.findMany({ where: { tenantId, memberId: member.id }, select: { id: true }, orderBy: { createdAt: "desc" }, take: MEMBER_PAYMENTS_CAP });
          and.push(memberWhere(member.id, payments.map((p) => p.id)));
        } else unknown = true;
      }
      if (asked.class) {
        const cls = await tx.class.findFirst({ where: { id: asked.class, tenantId }, select: { id: true, name: true } });
        filters.class = { id: asked.class, name: cls?.name ?? null };
        if (cls) and.push(classWhere(cls.id));
        else unknown = true;
      }
      if (asked.payment) {
        const payment = await tx.payment.findFirst({ where: { id: asked.payment, tenantId }, select: { id: true, amountPence: true, currency: true, stripeInvoiceId: true, paidAt: true, createdAt: true } });
        filters.payment = { id: asked.payment, label: payment ? `${formatMoney(payment.amountPence, payment.currency)} · ${formatDate(payment.paidAt ?? payment.createdAt, timeZone)}` : null };
        if (payment) and.push(paymentWhere(payment.id, payment.stripeInvoiceId));
        else unknown = true;
      }
      if (asked.tier) {
        const tier = await tx.membershipTier.findFirst({ where: { id: asked.tier, tenantId }, select: { id: true, name: true } });
        filters.tier = { id: asked.tier, name: tier?.name ?? null };
        if (tier) and.push(tierWhere(tier.id));
        else unknown = true;
      }
      if (asked.staff) {
        const staff = await tx.user.findFirst({ where: { id: asked.staff, tenantId }, select: { id: true, name: true } });
        filters.staff = { id: asked.staff, name: staff?.name ?? null };
        if (staff) and.push({ userId: staff.id });
        else unknown = true;
      }
      if (dayKey) and.push({ createdAt: { lt: clubDayWindow(dayKey, timeZone).nextStart } });

      const clock = { timeZone, todayKey, minDayKey, clamped };
      if (unknown) return { timeZone, clock, filters, rows: [], hasMore: false, undone: new Set<string>() };

      // `id` breaks ties: rows written in the same instant still page without repeats or gaps.
      const found: FeedRow[] = await tx.auditLog.findMany({
        where: { AND: and },
        select: FEED_ROW_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const rows = found.slice(0, take);

      // Which of these have already been undone? Only the owner undoes, and
      // only worth asking when something on the page could be undone at all.
      const undone = new Set<string>();
      if (withUndo && rows.some((row) => decideUndo({ ...row, tenantId }, false).ok)) {
        const undoRows = await tx.auditLog.findMany({ where: { tenantId, action: { startsWith: UNDO_PREFIX }, createdAt: { gte: rows[rows.length - 1].createdAt } }, select: { metadata: true } });
        for (const undo of undoRows) {
          const id = (undo.metadata as { undoneAuditId?: unknown } | null)?.undoneAuditId;
          if (typeof id === "string") undone.add(id);
        }
      }
      return { timeZone, clock, filters, rows, hasMore: found.length > take, undone };
    });
  } catch (e) {
    if (isTimeout(e)) return NextResponse.json({ ok: false, code: "timeout", error: TOO_MUCH }, { status: 504, headers: NO_STORE });
    return apiError("Couldn't load activity.", 500, e, "[activity]", { tenantId, userId, req });
  }
  slow(1, Date.now() - startedRows, asked, types.keys.length, first.rows.length);

  // Names, in a transaction of their own.
  let lookups: ActivityLookups | null = null;
  if (first.rows.length > 0) {
    const startedNames = Date.now();
    try {
      lookups = await withTenantContext(tenantId, (tx) => loadLookups(tx, tenantId, first.rows), { timeout: LOOKUP_BUDGET_MS });
    } catch (e) {
      // The rows are still true without their names: serve them plain, and say why in the log.
      console.error("[activity-feed] names could not be loaded", JSON.stringify({ tenantId, error: e instanceof Error ? e.name : typeof e, rows: first.rows.length }));
    }
    slow(2, Date.now() - startedNames, asked, types.keys.length, first.rows.length);
  }

  const extrasFor = (row: FeedRow): EntryExtras => {
    if (!withUndo) return {};
    const undone = first.undone.has(row.id);
    return { undone, undo: decideUndo({ ...row, tenantId }, undone) };
  };
  const enriched = lookups !== null || first.rows.length === 0;
  const entries = lookups
    ? toFeedEntries(first.rows, { lookups, role, timeZone: first.timeZone, focusMemberId: first.filters.member?.name != null ? first.filters.member.id : null }, extrasFor)
    : first.rows.map((row) => plainFallbackEntry(row, { timeZone: first.timeZone }, extrasFor(row)));

  const body: ActivityResponse = {
    entries,
    nextCursor: first.hasMore ? first.rows[first.rows.length - 1].id : null,
    enriched,
    clock: first.clock,
    filters: { types: { view: types.view, keys: types.keys }, ...first.filters },
    ignoredTypes: types.ignored,
    droppedTypes: types.dropped,
  };
  return NextResponse.json(body, { headers: NO_STORE });
}

/** One line when a transaction is slow — counts and flags only, never a value. */
function slow(tx: 1 | 2, ms: number, asked: { member: string | null; class: string | null; tier: string | null }, typesCount: number, rows: number) {
  if (ms <= SLOW_MS) return;
  console.warn("[activity-feed] slow", JSON.stringify({ tx, ms, hasMember: !!asked.member, hasClass: !!asked.class, hasTier: !!asked.tier, typesCount, rows }));
}
