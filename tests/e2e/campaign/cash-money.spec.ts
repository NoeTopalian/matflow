import { test, expect, type Locator, type Page } from "@playwright/test";

import {
  RUN_STAMP,
  cleanupRun,
  createMember,
  getMember,
  paymentsFor,
  seededTenantId,
  sql,
} from "./helpers/db";

/**
 * THE CASH MONEY PATH.
 *
 * A gym owner takes £40 at the desk and marks the member paid. That single
 * sentence is what MatFlow is sold on, and until this file it had zero
 * end-to-end coverage — which is precisely how the member-profile drawer
 * managed to POST `method: "manual"` (a value the route has never accepted)
 * and return 400 on every attempt for its entire life, unnoticed, because the
 * payments-hub modal worked and nobody compared the two.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT ASSERTS IT TWICE
 * --------------------------------------------------
 * Every test drives a real browser against the real screen, then reads the
 * database back. A UI assertion alone cannot tell an optimistic row from a
 * saved one — the profile drawer paints the payment into its table BEFORE the
 * POST resolves, so "the row appeared" is true even when the server refused
 * it. A database assertion alone cannot tell a working screen from a working
 * API. Both, or neither is evidence.
 *
 * Arrangement (members, due dates, tiers) is done through `helpers/db.ts`
 * because no screen can create a member whose payment fell due forty days ago.
 * Everything after the arrangement happens in the browser.
 *
 * SURFACES COVERED
 *   1. Member profile → Payments tab → "Record" drawer   (the 400-for-life one)
 *   2. Payments hub → "Record payment" modal + typeahead
 *   3. £0 rules: comp/exempt may be free, cash may not
 *   4. "Other" must say what it was
 *   5. Recording advances the member's next due date
 *   6. Recording removes the member from the outstanding list
 *
 * Known gaps and hazards are written up in NOTES-L1.md beside this file.
 */

// A cold `next dev` compiles /dashboard/members/[id] and /dashboard/payments on
// first hit; the suite's own auth.setup measures ~20s for one such compile.
test.describe.configure({ timeout: 120_000 });

// ── Run-scoped fixtures ──────────────────────────────────────────────────────

/** The club's own currency — the manual route denominates in it, not in GBP. */
let clubCurrency = "GBP";
/** A monthly tier, needed because the route only advances a due date if one exists. */
let monthlyTierId: string | null = null;
/** Set only when THIS run had to create the tier, so cleanup removes only ours. */
let tierCreatedByThisRun: string | null = null;

let nameSeq = 0;
/** Unique, searchable, and stamped so a human can see where the row came from. */
function memberName(tag: string): string {
  nameSeq += 1;
  return `${RUN_STAMP} ${tag} ${nameSeq}`;
}

/** How the MEMBER PROFILE table prints money (components/dashboard/MemberProfile.tsx). */
function profileAmount(pence: number): string {
  const prefix = clubCurrency === "GBP" ? "£" : clubCurrency;
  return `${prefix}${(pence / 100).toFixed(2)}`;
}

/** How the PAYMENTS HUB table prints money (components/dashboard/payments-columns.tsx). */
function hubAmount(pence: number): string {
  const symbol =
    clubCurrency === "USD" ? "$" : clubCurrency === "EUR" ? "€" : "£";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

/**
 * A monthly membership tier for the seeded club.
 *
 * `POST /api/payments/manual` only advances `nextDueAt` when the member has a
 * tier — the cycle lives on `MembershipTier.billingCycle`, and a member without
 * one has no recurring obligation to date. `prisma/seed.ts` creates no tiers, so
 * the due-date and outstanding-list tests would silently assert nothing without
 * this. Reuses an existing active monthly tier when the branch has one so the
 * suite does not accrete tiers on a shared database.
 */
async function ensureMonthlyTier(): Promise<string> {
  if (monthlyTierId) return monthlyTierId;
  const tenantId = await seededTenantId();

  const existing = await sql<{ id: string }>(
    `SELECT id FROM "MembershipTier"
     WHERE "tenantId" = $1 AND "billingCycle" = 'monthly' AND "isActive" = true
     ORDER BY "createdAt" ASC LIMIT 1`,
    [tenantId],
  );
  if (existing.length > 0) {
    monthlyTierId = existing[0].id;
    return monthlyTierId;
  }

  const created = await sql<{ id: string }>(
    `INSERT INTO "MembershipTier"
       ("id", "tenantId", "name", "pricePence", "currency", "billingCycle", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 4000, $3, 'monthly', true, now(), now())
     RETURNING id`,
    [tenantId, `${RUN_STAMP} monthly`, clubCurrency],
  );
  monthlyTierId = created[0].id;
  tierCreatedByThisRun = created[0].id;
  return monthlyTierId;
}

/** Put a member on the monthly tier. No screen sets this without Stripe wiring. */
async function putOnMonthlyTier(memberId: string): Promise<void> {
  const tierId = await ensureMonthlyTier();
  await sql('UPDATE "Member" SET "membershipTierId" = $1 WHERE id = $2', [tierId, memberId]);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

// ── Page objects, named for what the owner sees ──────────────────────────────

/**
 * The member profile's "Record payment" drawer.
 *
 * Selector provenance (components/dashboard/MemberProfile.tsx):
 *   trigger        — <Button onClick={setPaymentDrawer(true)}> "Record"   (line ~1609)
 *   drawer         — <Sheet title="Record payment">, role="dialog" via OverlayShell
 *   method select  — id="profile-payment-method", <label htmlFor> "Method"
 *   notes input    — aria-label="Description / Notes"
 *   amount input   — aria-label="Amount (£)"
 *   submit         — <Button> "Record payment" in the Sheet footer
 */
function profileDrawer(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Record payment" });
  return {
    dialog,
    async open() {
      await page.getByRole("button", { name: "Record", exact: true }).click();
      await expect(dialog).toBeVisible();
    },
    method: dialog.locator("#profile-payment-method"),
    notes: dialog.getByLabel("Description / Notes", { exact: true }),
    amount: dialog.getByLabel("Amount (£)", { exact: true }),
    submit: dialog.getByRole("button", { name: "Record payment", exact: true }),
  };
}

/**
 * The payments hub's "Record a payment" modal.
 *
 * Selector provenance (components/dashboard/RecordPaymentModal.tsx):
 *   trigger      — PaymentsPageClient <Button> "Record payment" (page header)
 *   modal        — <Dialog title="Record a payment">, role="dialog"
 *   search       — aria-label="Search for a member by name"
 *   amount       — id="record-payment-amount"   (its LABEL text changes with the
 *                  method, so the id is the only stable handle)
 *   method       — id="record-payment-method"
 *   notes        — id="record-payment-notes"    (label text changes likewise)
 *   submit       — <Button> "Record payment" in the Dialog footer
 *   success      — "Payment recorded" panel, shown for 700ms before auto-close
 */
function hubModal(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Record a payment" });
  return {
    dialog,
    async openFromHeader() {
      await page.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(dialog).toBeVisible();
    },
    async pickMember(name: string) {
      await dialog.getByLabel("Search for a member by name").fill(name);
      const result = dialog.getByRole("button", { name, exact: true });
      await expect(result).toBeVisible({ timeout: 20_000 });
      await result.click();
      // The picker collapses to the chosen member + a "Change" button.
      await expect(dialog.getByRole("button", { name: "Change", exact: true })).toBeVisible();
    },
    amount: dialog.locator("#record-payment-amount"),
    method: dialog.locator("#record-payment-method"),
    notes: dialog.locator("#record-payment-notes"),
    amountLabel: dialog.locator('label[for="record-payment-amount"]'),
    submit: dialog.getByRole("button", { name: "Record payment", exact: true }),
    recorded: dialog.getByText("Payment recorded", { exact: true }),
  };
}

/** The member profile's payments table — DataTable label="Payments for this member". */
function profilePaymentsTable(page: Page): Locator {
  return page.getByRole("table", { name: "Payments for this member" });
}

/** The hub's history table — DataTable label="Payment history". */
function hubHistoryTable(page: Page): Locator {
  return page.getByRole("table", { name: "Payment history" });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

test.beforeAll(async () => {
  const rows = await sql<{ currency: string | null }>(
    'SELECT currency FROM "Tenant" WHERE slug = $1',
    ["totalbjj"],
  );
  clubCurrency = (rows[0]?.currency ?? "GBP").toUpperCase();
});

test.afterAll(async () => {
  await cleanupRun();
  if (tierCreatedByThisRun) {
    // Member.membershipTierId is ON DELETE SET NULL, so this is safe whatever
    // order it lands in relative to the member deletes above.
    await sql('DELETE FROM "MembershipTier" WHERE id = $1', [tierCreatedByThisRun]);
  }
});

// ── 1. The surface that 400'd for its entire life ────────────────────────────

test("member profile drawer records a cash payment, and it is really saved", async ({ page }) => {
  const name = memberName("profile-cash");
  // paymentStatus "overdue" so the flip to "paid" is an observable side effect
  // rather than a no-op on a member who was already marked paid.
  const member = await createMember({ name, paymentStatus: "overdue" });

  await page.goto(`/dashboard/members/${member.id}?tab=payments`);
  await expect(page.getByText("Payment History", { exact: true })).toBeVisible({ timeout: 60_000 });

  const drawer = profileDrawer(page);
  await drawer.open();

  await drawer.method.selectOption("cash");
  await drawer.notes.fill("Monthly membership, cash");
  await drawer.amount.fill("40.00");
  await expect(drawer.submit).toBeEnabled();
  await drawer.submit.click();

  // Visible state: the success toast (role="alert", components/ui/Toast.tsx),
  // the drawer closing, and the row landing in the table.
  await expect(page.getByRole("alert").filter({ hasText: "Payment recorded" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(drawer.dialog).toBeHidden();

  // The route builds the description as `${METHOD_LABEL[method]} — ${notes}`
  // (app/api/payments/manual/route.ts), so the row that survives the optimistic
  // swap reads "Cash — …". Asserting that exact string is what distinguishes a
  // SAVED row from the drawer's own optimistic one, which carries the bare note.
  const savedRow = profilePaymentsTable(page)
    .getByRole("row")
    .filter({ hasText: "Cash — Monthly membership, cash" });
  await expect(savedRow).toBeVisible({ timeout: 30_000 });
  await expect(savedRow).toContainText(profileAmount(4000));

  // Side effects in the database.
  const payments = await paymentsFor(member.id);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountPence).toBe(4000);
  expect(payments[0].status).toBe("succeeded");
  expect(payments[0].description).toBe("Cash — Monthly membership, cash");
  expect(payments[0].currency).toBe(clubCurrency);
  expect(payments[0].requestId).toBeTruthy();

  const after = await getMember(member.id);
  expect(after?.paymentStatus).toBe("paid");

  // And it survives a reload — the payment is persisted, not React state. On a
  // fresh load the Method column is derived server-side from the absent Stripe
  // ids (app/api/members/[id]/payments/route.ts) and reads "Manual".
  await page.reload();
  const reloadedRow = profilePaymentsTable(page)
    .getByRole("row")
    .filter({ hasText: "Cash — Monthly membership, cash" });
  await expect(reloadedRow).toBeVisible({ timeout: 60_000 });
  await expect(reloadedRow).toContainText("Manual");
  await expect(reloadedRow).toContainText(profileAmount(4000));
});

// ── 2. The payments hub modal, including the member typeahead ────────────────

test("payments hub modal records a payment against a searched-for member", async ({ page }) => {
  const name = memberName("hub-cash");
  const member = await createMember({ name, paymentStatus: "overdue" });

  await page.goto("/dashboard/payments");
  // The hub opens on "Outstanding"; the history table only refetches after a
  // recorded payment when it is the visible view (PaymentsPageClient.onRecorded).
  await page.getByRole("button", { name: "All payments", exact: true }).click();
  await expect(hubHistoryTable(page)).toBeVisible({ timeout: 60_000 });

  const modal = hubModal(page);
  await modal.openFromHeader();
  await modal.pickMember(name);

  await modal.amount.fill("25.00");
  await modal.method.selectOption("external");
  await modal.notes.fill("Standing order, March");
  await expect(modal.submit).toBeEnabled();
  await modal.submit.click();

  // The success panel lives for 700ms before the modal auto-closes
  // (RecordPaymentModal: setDone(true) -> setTimeout(onClose, 700)), so racing
  // that flash is flaky by construction. Assert the DURABLE consequence — the
  // dialog goes away of its own accord, which only happens on success; the
  // error path keeps it open with a message.
  await expect(modal.dialog).toBeHidden({ timeout: 30_000 });

  // METHOD_LABEL.external is "External" — deliberately not the picker's
  // "Bank transfer / external", which is dropdown wording, not receipt wording.
  const row = hubHistoryTable(page).getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("External — Standing order, March");
  await expect(row).toContainText(hubAmount(2500));
  await expect(row).toContainText("Paid");

  const payments = await paymentsFor(member.id);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountPence).toBe(2500);
  expect(payments[0].description).toBe("External — Standing order, March");
  expect(payments[0].status).toBe("succeeded");

  const after = await getMember(member.id);
  expect(after?.paymentStatus).toBe("paid");
});

// ── 3. The £0 rules ──────────────────────────────────────────────────────────

test("hub modal: cash at £0 is refused, comp at £0 is accepted", async ({ page }) => {
  const name = memberName("hub-comp");
  const member = await createMember({ name });

  await page.goto("/dashboard/payments");
  await page.getByRole("button", { name: "All payments", exact: true }).click();
  await expect(hubHistoryTable(page)).toBeVisible({ timeout: 60_000 });

  const modal = hubModal(page);
  await modal.openFromHeader();
  await modal.pickMember(name);

  // Cash at zero: the submit must not be offered at all. A £0 cash row is a
  // zero-value entry in the ledger that reads as takings.
  await modal.amount.fill("0");
  await expect(modal.method).toHaveValue("cash");
  await expect(modal.submit).toBeDisabled();

  // Comp says "this member owes nothing", so £0 is the correct amount and the
  // label says so out loud.
  await modal.method.selectOption("comp");
  await expect(modal.amountLabel).toHaveText("Amount (£) — optional for comp/exempt");
  await expect(modal.submit).toBeEnabled();
  await modal.submit.click();

  // The success panel lives for 700ms before the modal auto-closes
  // (RecordPaymentModal: setDone(true) -> setTimeout(onClose, 700)), so racing
  // that flash is flaky by construction. Assert the DURABLE consequence — the
  // dialog goes away of its own accord, which only happens on success; the
  // error path keeps it open with a message.
  await expect(modal.dialog).toBeHidden({ timeout: 30_000 });

  const row = hubHistoryTable(page).getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Comp");
  await expect(row).toContainText(hubAmount(0));

  const payments = await paymentsFor(member.id);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountPence).toBe(0);
  expect(payments[0].description).toBe("Comp");
  expect(payments[0].status).toBe("succeeded");
});

test("profile drawer: cash at £0 is refused, exempt at £0 is accepted", async ({ page }) => {
  const name = memberName("profile-exempt");
  const member = await createMember({ name });

  await page.goto(`/dashboard/members/${member.id}?tab=payments`);
  await expect(page.getByText("Payment History", { exact: true })).toBeVisible({ timeout: 60_000 });

  const drawer = profileDrawer(page);
  await drawer.open();

  await drawer.method.selectOption("cash");
  await drawer.amount.fill("0");
  await expect(drawer.submit).toBeDisabled();

  // NOTE: "0" is typed explicitly rather than left blank. A BLANK amount on a
  // comp/exempt payment is accepted by the drawer's own validity check and then
  // posts amountPence: NaN → JSON null → 400. See NOTES-L1.md "Known broken".
  await drawer.method.selectOption("exempt");
  await expect(drawer.submit).toBeEnabled();
  await drawer.submit.click();

  await expect(page.getByRole("alert").filter({ hasText: "Payment recorded" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(drawer.dialog).toBeHidden();

  const savedRow = profilePaymentsTable(page).getByRole("row").filter({ hasText: "Exempt" });
  await expect(savedRow).toBeVisible({ timeout: 30_000 });
  await expect(savedRow).toContainText(profileAmount(0));

  const payments = await paymentsFor(member.id);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountPence).toBe(0);
  expect(payments[0].description).toBe("Exempt");
});

// ── 4. "Other" has to say what it was ────────────────────────────────────────

test('profile drawer: "Other" is refused without notes and accepted with them', async ({ page }) => {
  const name = memberName("profile-other");
  const member = await createMember({ name });

  await page.goto(`/dashboard/members/${member.id}?tab=payments`);
  await expect(page.getByText("Payment History", { exact: true })).toBeVisible({ timeout: 60_000 });

  const drawer = profileDrawer(page);
  await drawer.open();

  await drawer.amount.fill("12.50");
  await drawer.method.selectOption("other");

  // Visible state: the label tells the owner why the button is dead.
  await expect(drawer.dialog.getByText("Description / Notes (required)")).toBeVisible();
  await expect(drawer.submit).toBeDisabled();

  await drawer.notes.fill("Door float top-up");
  await expect(drawer.submit).toBeEnabled();
  await drawer.submit.click();

  await expect(page.getByRole("alert").filter({ hasText: "Payment recorded" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(drawer.dialog).toBeHidden();

  // METHOD_LABEL.other is "Manual" on the receipt line, not "Other".
  const savedRow = profilePaymentsTable(page)
    .getByRole("row")
    .filter({ hasText: "Manual — Door float top-up" });
  await expect(savedRow).toBeVisible({ timeout: 30_000 });
  await expect(savedRow).toContainText(profileAmount(1250));

  const payments = await paymentsFor(member.id);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountPence).toBe(1250);
  expect(payments[0].description).toBe("Manual — Door float top-up");

  // And nothing was written on the refused attempt: exactly one row exists.
  expect(payments.filter((p) => p.description === "Manual")).toHaveLength(0);
});

// ── 5. Recording moves the due date forward ──────────────────────────────────

test("recording a payment advances the member's next due date", async ({ page }) => {
  const name = memberName("due-date");
  const dueFortyDaysAgo = daysAgo(40);
  const member = await createMember({ name, nextDueAt: dueFortyDaysAgo });
  await putOnMonthlyTier(member.id);

  const before = await getMember(member.id);
  expect(before?.nextDueAt).not.toBeNull();
  expect(new Date(before!.nextDueAt!).getTime()).toBeLessThan(Date.now());

  await page.goto(`/dashboard/members/${member.id}?tab=payments`);
  await expect(page.getByText("Payment History", { exact: true })).toBeVisible({ timeout: 60_000 });

  const drawer = profileDrawer(page);
  await drawer.open();
  await drawer.method.selectOption("cash");
  await drawer.notes.fill("Caught up at the desk");
  await drawer.amount.fill("40.00");
  await drawer.submit.click();

  await expect(page.getByRole("alert").filter({ hasText: "Payment recorded" })).toBeVisible({
    timeout: 30_000,
  });

  const savedRow = profilePaymentsTable(page)
    .getByRole("row")
    .filter({ hasText: "Cash — Caught up at the desk" });
  await expect(savedRow).toBeVisible({ timeout: 30_000 });

  const after = await getMember(member.id);
  expect(after?.nextDueAt).not.toBeNull();
  const movedTo = new Date(after!.nextDueAt!).getTime();

  // Forward, and genuinely into the future — `advanceDueDate` steps whole
  // months from the OLD due date until the result is ahead of now, so a member
  // forty days behind lands ~20 days out, not a month from today.
  expect(movedTo).toBeGreaterThan(new Date(before!.nextDueAt!).getTime());
  expect(movedTo).toBeGreaterThan(Date.now());

  // Stepped from the OLD due date, not re-based on today. Two monthly steps
  // from forty days ago land 19–22 days out whatever the month lengths; a
  // re-basing implementation would land ~30 days out. The 26-day ceiling is the
  // assertion that tells those two apart without depending on a calendar.
  expect(movedTo).toBeLessThan(Date.now() + 26 * 86_400_000);

  expect(await paymentsFor(member.id)).toHaveLength(1);
});

// ── 6. On the outstanding list before, gone after ────────────────────────────

test("an overdue member is on the outstanding list, and drops off once paid", async ({ page }) => {
  const name = memberName("outstanding");
  const member = await createMember({ name, nextDueAt: daysAgo(12) });
  await putOnMonthlyTier(member.id);

  await page.goto("/dashboard/payments");

  // The hub opens on "Outstanding" — the "who owes me" list. The member's name
  // is a Link to their payments tab (components/dashboard/OutstandingPanel.tsx).
  const nameLink = page.getByRole("link", { name, exact: true });
  await expect(nameLink).toBeVisible({ timeout: 60_000 });

  // The row has no semantic container, so walk up from the name Link:
  //   Link → div.min-w-0 → the row div that also holds the Record button.
  const row = nameLink.locator("xpath=../..");
  await expect(row).toContainText("Overdue");
  await row.getByRole("button", { name: "Record", exact: true }).click();

  // Opened from a row, the modal arrives with the member already picked — there
  // is no search box and no "Change" button.
  const modal = hubModal(page);
  await expect(modal.dialog).toBeVisible();
  await expect(modal.dialog).toContainText(name);
  await expect(modal.dialog.getByLabel("Search for a member by name")).toHaveCount(0);

  await modal.amount.fill("45.00");
  await modal.method.selectOption("cash");
  await modal.notes.fill("Cleared at the desk");
  await modal.submit.click();

  // The success panel lives for 700ms before the modal auto-closes
  // (RecordPaymentModal: setDone(true) -> setTimeout(onClose, 700)), so racing
  // that flash is flaky by construction. Assert the DURABLE consequence — the
  // dialog goes away of its own accord, which only happens on success; the
  // error path keeps it open with a message.
  await expect(modal.dialog).toBeHidden({ timeout: 30_000 });

  // Immediately: the panel drops the row it just settled.
  await expect(nameLink).toHaveCount(0);

  // And on a fresh load, because the derivation (lib/overdue.ts) now reads a
  // due date in the future rather than a flag somebody cleared by hand.
  await page.reload();
  // Wait for the panel to actually RESOLVE before asserting an absence —
  // "the name is not on the page" is trivially true while it is still loading,
  // which would make this a false pass. Either the summary line or the empty
  // state means the fetch came back (components/dashboard/OutstandingPanel.tsx).
  await expect(
    page.getByText(/outstanding across \d+ member|Nobody owes you right now/),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);

  const payments = await paymentsFor(member.id);
  expect(payments).toHaveLength(1);
  expect(payments[0].amountPence).toBe(4500);
  expect(payments[0].description).toBe("Cash — Cleared at the desk");

  const after = await getMember(member.id);
  expect(after?.paymentStatus).toBe("paid");
  expect(new Date(after!.nextDueAt!).getTime()).toBeGreaterThan(Date.now());
});
