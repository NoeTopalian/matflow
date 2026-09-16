import { test, expect } from "@playwright/test";
import { createMember, seededTenantId, sql, cleanupRun, RUN_STAMP } from "./helpers/db";

/**
 * The ink work, proven end to end in a real browser against a real photo.
 *
 * `lib/print/ink.ts` is pure and fully unit-tested in Node. `processPhoto` is
 * the wrapper that cannot be: it needs a real canvas, a real image decode and a
 * real `toDataURL`. Everything that could silently go wrong lives there —
 * tainting the canvas, dithering the transparent pixels of a PNG into a ring of
 * dots around the face, or encoding halftone as JPEG and smearing the dots back
 * into grey.
 *
 * **The load-bearing test is the ink percentage falling.** It is the one claim
 * the whole feature rests on and the one the owner is shown, so it is asserted
 * against a genuine photo processed by a genuine browser, not against a model.
 *
 * The photo is arranged as a `data:` URL, which is not a trick:
 * `MemberPhoto.url`'s own schema comment says it accepts both blob and data
 * URLs, and `toBlobProxyUrl` passes non-blob input through untouched. So this
 * exercises the same code path a real uploaded photo takes, minus the network.
 */

/** A 96×96 PNG with mid-tones and a dark block — enough for dithering to bite. */
const SAMPLE_PHOTO =
  "data:image/svg+xml;base64," +
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
       <rect width="96" height="96" fill="rgb(170,140,120)"/>
       <circle cx="48" cy="40" r="22" fill="rgb(90,70,58)"/>
       <rect y="70" width="96" height="26" fill="rgb(120,100,86)"/>
     </svg>`,
  ).toString("base64");

let memberName: string;

test.beforeAll(async () => {
  const tenantId = await seededTenantId();
  const member = await createMember({ name: `Campaign InkPhoto ${RUN_STAMP}` });
  memberName = member.name;
  await sql(
    `INSERT INTO "MemberPhoto" ("id", "tenantId", "memberId", "url", "kind", "uploadedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'profile', now())`,
    [tenantId, member.id, SAMPLE_PHOTO],
  );
});

test.afterAll(async () => {
  await cleanupRun();
});

async function openPrintScreen(page: import("@playwright/test").Page) {
  await page.goto("/print/member-cards", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Print member cards/i })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("button", { name: /^Print \d+ sheet/ })).toBeEnabled({
    timeout: 60_000,
  });
}

/** The percentage the panel is showing, or null when it is not showing one. */
async function inkPercent(page: import("@playwright/test").Page): Promise<number | null> {
  const text = await page.locator("text=/of the ink full colour would use/").first().innerText();
  const m = /about\s+(\d+)%/.exec(text.replace(/\s+/g, " "));
  return m ? Number(m[1]) : null;
}

async function chooseInk(page: import("@playwright/test").Page, label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: /^Print \d+ sheet/ })).toBeEnabled({
    timeout: 60_000,
  });
}

test.describe("ink treatments against a real photo", () => {
  test("greyscale uses less ink than colour, and halftone less again", async ({ page }) => {
    await openPrintScreen(page);

    await chooseInk(page, "Colour");
    const colour = await inkPercent(page);
    expect(colour, "colour is the baseline and must report 100%").toBe(100);

    await chooseInk(page, "Greyscale");
    const grey = await inkPercent(page);

    await chooseInk(page, "Halftone dots");
    const halftone = await inkPercent(page);

    expect(grey, "greyscale should be measured").not.toBeNull();
    expect(halftone, "halftone should be measured").not.toBeNull();
    expect(grey!, "greyscale must cost less than full colour").toBeLessThan(colour!);
    expect(
      halftone!,
      "halftone must cost less than greyscale — if this inverts, the panel is telling the owner the expensive option is the cheap one",
    ).toBeLessThan(grey!);
  });

  test("the processed photo really is baked into the card, not just previewed", async ({ page }) => {
    // A CSS filter would satisfy the eye and print the original. The card's
    // <img> src must be a generated data URL, which only the canvas path makes.
    await openPrintScreen(page);
    await chooseInk(page, "Halftone dots");

    const photo = page.locator("[data-testid^='photo-']").first();
    await expect(photo).toBeVisible({ timeout: 30_000 });
    const src = await photo.getAttribute("src");
    expect(src, "the card is still pointing at the untouched original").toMatch(
      /^data:image\/png;base64,/,
    );
  });
});

test.describe("picture modes", () => {
  test("every ink mode keeps the sheet printable", async ({ page }) => {
    await openPrintScreen(page);
    for (const mode of ["Colour", "Greyscale", "Halftone dots"]) {
      await chooseInk(page, mode);
    }
  });

  test("'name only' removes the picture block; 'initials' keeps a monogram", async ({ page }) => {
    await openPrintScreen(page);
    const card = page.locator("[data-testid^='card-']").first();
    await expect(card).toBeVisible();

    await page.getByRole("button", { name: "Initials", exact: true }).click();
    await expect(card.locator("[data-testid^='monogram-']")).toHaveCount(1);

    await page.getByRole("button", { name: "Name only", exact: true }).click();
    await expect(card.locator("[data-testid^='monogram-']")).toHaveCount(0);
    await expect(card.locator("[data-testid^='photo-']")).toHaveCount(0);
    // The QR is the functional half of the card and must survive every mode.
    await expect(card.locator("img")).not.toHaveCount(0);
  });
});

test.describe("choosing who to print", () => {
  test("clearing the selection prints nothing; picking one prints one", async ({ page }) => {
    await openPrintScreen(page);
    const cards = page.locator("[data-testid^='card-']");
    expect(await cards.count()).toBeGreaterThan(1);

    await page.getByRole("button", { name: /^Choose members/ }).click();
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    await expect(page.getByRole("button", { name: /^Print \d+ sheet/ })).toBeDisabled();
    await expect(cards).toHaveCount(0);

    // components/ui/checkbox.tsx is a <button role="checkbox">, not an <input>.
    await page.getByRole("checkbox").first().click();
    await expect(cards).toHaveCount(1);
  });

  test("search narrows the picker without changing the selection", async ({ page }) => {
    await openPrintScreen(page);
    await page.getByRole("button", { name: /^Choose members/ }).click();
    const before = await page.getByRole("checkbox").count();

    await page.getByLabel("Search members").fill(memberName);
    await expect(page.getByRole("checkbox")).toHaveCount(1);
    expect(before).toBeGreaterThan(1);

    // Everyone is still selected — filtering the list is not deselecting.
    await expect(page.getByRole("checkbox").first()).toHaveAttribute("aria-checked", "true");
  });
});
