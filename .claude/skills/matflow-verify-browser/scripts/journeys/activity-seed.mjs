// Shared set-up for the Activity journeys (synthetic data only, the run's own mfv- club).
// Makes one class through the real form, then writes a small, known history straight into the audit log — the
// timeline READS that log, so the journeys assert against rows whose exact wording is known in advance.
//
// The seeded "today" rows are stamped 4 to 24 minutes ago. A run started in the first 25 minutes after the club's
// midnight would put some of them under Yesterday; the journeys are not run then.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { q } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");

export const id = () => randomUUID().replace(/-/g, "");
export const SLOW = { timeout: 30_000 };
export const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The club's own date for an instant, "YYYY-MM-DD". */
export const clubDay = (date, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
/** "19:05" on the club's clock. */
export const clubTime = (date, timeZone) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
/** "Tue 3 Nov" for a session's day marker. */
export const dayLabel = (date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(date).replace(",", "");

export const isFeed = (r) => new URL(r.url()).pathname === "/api/activity";

/**
 * The timeline has loaded the rows for the filters in the address. The status line is empty while it loads or
 * reloads, so this is the one thing to wait for after opening the page — the skeleton rows and the server-rendered
 * controls are on screen long before the page can be used.
 */
export async function ready(page) {
  await expect(page.getByTestId("activity-status")).not.toHaveText("", SLOW);
}

/** Do something that changes the filters, and wait for the rows that answer it. */
export async function changed(page, action) {
  const answered = page.waitForResponse(isFeed, { timeout: 30_000 });
  await action();
  await answered;
  await ready(page);
}

export async function seedActivity(main, club, className = "Activity Gi") {
  const tenantId = club.tenantId;
  const timeZone = (await q(`select timezone from "Tenant" where id = $1`, [tenantId]))[0].timezone;
  const members = await q(`select id, name, email from "Member" where "tenantId" = $1 order by name`, [tenantId]);
  if (members.length < 2) throw new Error("fixture has fewer than two members");
  const [mel, other] = members;

  // A class through the real form (the row every "class" link points at), with one session on it. This also writes
  // a real "created a class" row, by the owner, a moment before the seeded history below.
  await main.goto("/dashboard/timetable");
  await main.getByRole("button", { name: "Add class", exact: true }).first().click();
  await main.getByLabel("Class Name", { exact: true }).fill(className);
  await main.getByRole("button", { name: "Add day", exact: true }).click();
  await main.getByLabel("Day of the week").first().selectOption("1");
  const created = main.waitForResponse((r) => new URL(r.url()).pathname === "/api/classes" && r.request().method() === "POST" && !r.url().includes("dryRun"));
  await main.getByRole("button", { name: "Create class", exact: true }).click();
  const cls = await (await created).json();
  await expect(main.getByRole("dialog")).toHaveCount(0);

  const now = Date.now();
  // The session's day marker is 00:00 UTC of yesterday's club date; its start time is the club's wall clock.
  const sessionDay = new Date(`${clubDay(new Date(now - DAY), timeZone)}T00:00:00.000Z`);
  const session = id();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '19:00', '20:00')`, [session, cls.id, sessionDay]);
  const sessionLabel = `${className} · ${dayLabel(sessionDay)}, 19:00`;

  const tierOld = id();
  const tierNew = id();
  await q(`insert into "MembershipTier" (id, "tenantId", name, "updatedAt") values ($1, $3, 'Twice a week (OLD)', now()), ($2, $3, 'Adult Unlimited', now())`, [tierOld, tierNew, tenantId]);

  const payment = id();
  const invoice = `in_${id()}`;
  await q(`insert into "Payment" (id, "tenantId", "memberId", "amountPence", currency, status, "stripeInvoiceId", "paidAt") values ($1, $2, $3, 4500, 'GBP', 'succeeded', $4, $5)`, [payment, tenantId, mel.id, invoice, new Date(now - 20 * MIN)]);

  const owner = club.owner.id;
  // The phone edit below is real enough to undo: the member holds the value the row says it was changed to.
  await q(`update "Member" set phone = '07700 900222' where id = $1`, [mel.id]);

  const rows = {};
  const pending = [];
  const log = (key, action, over = {}) => {
    const row = { id: id(), action, entityType: "Member", entityId: mel.id, userId: null, metadata: null, at: new Date(now - 5 * MIN), ...over };
    rows[key] = row;
    pending.push(row);
    return row;
  };
  const checkin = (who) => ({ entityType: "AttendanceRecord", entityId: id(), metadata: { classInstanceId: session, memberId: who.id, method: "self", actorId: who.id } });

  // Today, newest first.
  log("checkin", "attendance.self_checkin", { ...checkin(mel), at: new Date(now - 4 * MIN) });
  log("edit", "member.update", { userId: owner, metadata: { fields: ["phone"], changes: { phone: { from: "07700 900111", to: "07700 900222" } } }, at: new Date(now - 6 * MIN) });
  log("plan", "member.update", { userId: owner, metadata: { changes: { membershipTierId: { from: tierOld, to: tierNew } } }, at: new Date(now - 8 * MIN) });
  log("cancel", "member.update", { userId: owner, entityId: other.id, metadata: { changes: { status: { from: "active", to: "cancelled" } } }, at: new Date(now - 10 * MIN) });
  log("paid", "member.payment.succeeded", { metadata: { stripeInvoiceId: invoice, amountPence: 4500, currency: "gbp" }, at: new Date(now - 20 * MIN) });
  log("failed", "member.payment.failed", { entityId: other.id, metadata: { stripeInvoiceId: `in_${id()}`, amountPence: 3000, currency: "gbp", reason: "card_declined" }, at: new Date(now - 22 * MIN) });
  log("settings", "tenant.settings.update", { entityType: "Tenant", entityId: tenantId, userId: owner, metadata: { fields: ["name"] }, at: new Date(now - 24 * MIN) });
  // Yesterday, at a known time on the club's clock.
  const yesterdayAt = new Date(now - DAY);
  log("yesterday", "attendance.self_checkin", { ...checkin(other), at: yesterdayAt });
  // Three days back: enough rows to need "Show older".
  const olderAt = new Date(now - 3 * DAY);
  for (let i = 0; i < 55; i++) log(`older${i}`, "attendance.self_checkin", { ...checkin(i % 2 ? other : mel), at: new Date(olderAt.getTime() - i * 1000) });

  // One statement for the lot: a connection per row made the set-up take longer than the journey.
  const values = pending.map((_, i) => `($${i * 7 + 1}, $${pending.length * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}::jsonb, $${i * 7 + 7})`).join(", ");
  await q(`insert into "AuditLog" (id, "tenantId", "userId", action, "entityType", "entityId", metadata, "createdAt") values ${values}`, [
    ...pending.flatMap((r) => [r.id, r.userId, r.action, r.entityType, r.entityId, r.metadata ? JSON.stringify(r.metadata) : null, r.at]),
    tenantId,
  ]);

  return { tenantId, timeZone, mel, other, cls, className, session, sessionLabel, tierOld, tierNew, payment, rows, owner, now, yesterdayAt, olderAt };
}
