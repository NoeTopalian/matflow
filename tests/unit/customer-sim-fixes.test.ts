/**
 * Pins for the customer-simulation fixes of 26 Sep 2026 (F-2, F-7, F-10, F-11).
 */
import { describe, it, expect } from "vitest";
import { medicalNotesText, medicalNotesFromList } from "@/lib/medical-notes";
import { normaliseClubCode, clubCodeInputFilter } from "@/lib/club-code";
import { describeSaveFailure } from "@/lib/save-failure";

describe("medicalNotesText (F-7: the register printed a red ⚠ [])", () => {
  it("shows nothing for null, blank, an empty JSON array or an empty list", () => {
    for (const v of [null, undefined, "", "   ", "[]", "null", [], ["", " "], '[""]']) {
      expect(medicalNotesText(v), JSON.stringify(v)).toBeNull();
    }
  });
  it("joins a list, parses a JSON list, keeps free text", () => {
    expect(medicalNotesText(["Asthma", "Knee surgery 2024"])).toBe("Asthma; Knee surgery 2024");
    expect(medicalNotesText('["Asthma"]')).toBe("Asthma");
    expect(medicalNotesText("  Epilepsy — carries medication ")).toBe("Epilepsy — carries medication");
    expect(medicalNotesText("[not json")).toBe("[not json");
  });
  it("writes null for an empty list so the column never holds []", () => {
    expect(medicalNotesFromList([])).toBeNull();
    expect(medicalNotesFromList(["", " "])).toBeNull();
    expect(medicalNotesFromList(["Asthma"])).toBe('["Asthma"]');
  });
});

describe("normaliseClubCode (F-2: the hyphenated club code was refused)", () => {
  it("keeps the hyphen the approval flow mints", () => {
    expect(normaliseClubCode("riverbank-grappling")).toBe("riverbank-grappling");
    expect(normaliseClubCode("  Riverbank-Grappling ")).toBe("riverbank-grappling");
    expect(normaliseClubCode("RIVERBANK-GRAPPLING")).toBe("riverbank-grappling");
  });
  it("accepts a pasted login link or club URL", () => {
    expect(normaliseClubCode("https://matflow.studio/login?club=riverbank-grappling")).toBe("riverbank-grappling");
    expect(normaliseClubCode("http://localhost:3847/login?club=riverbank-grappling&x=1")).toBe("riverbank-grappling");
    expect(normaliseClubCode("matflow.studio/riverbank-grappling")).toBe("riverbank-grappling");
    expect(normaliseClubCode("https://matflow.studio/totalbjj/")).toBe("totalbjj");
  });
  it("drops what the server would refuse and never returns a bare hyphen", () => {
    expect(normaliseClubCode("river bank!")).toBe("riverbank");
    expect(normaliseClubCode("--")).toBe("");
    expect(normaliseClubCode("https://matflow.studio/login")).toBe("");
  });
  it("the input filter keeps letters, digits and hyphens while typing", () => {
    expect(clubCodeInputFilter("river-bank 1!")).toBe("RIVER-BANK1");
  });
});

describe("describeSaveFailure (F-10 expired session, F-11 dropped request)", () => {
  it("an expired session says so and keeps the input", () => {
    const f = describeSaveFailure(401, { error: "Unauthorized" }, "Add Member");
    expect(f.kind).toBe("signed_out");
    expect(f.message).toMatch(/session has expired/i);
    expect(f.message).toMatch(/Add Member/);
    expect(f.message).toMatch(/kept/i);
  });
  it("a dropped request never claims nothing was recorded when the retry is deduplicated", () => {
    const f = describeSaveFailure(0, null, "Record payment", { idempotent: true });
    expect(f.kind).toBe("unreachable");
    expect(f.message).toMatch(/don't know whether it went through/i);
    expect(f.message).toMatch(/never recorded twice/i);
    expect(f.message).not.toMatch(/nothing was recorded/i);
  });
  it("a dropped non-idempotent request says nothing was saved", () => {
    expect(describeSaveFailure(0, null, "Add Member").message).toMatch(/Nothing was saved/);
  });
  it("a validation error names the field (F-17)", () => {
    const f = describeSaveFailure(400, { error: "Invalid data", details: { fieldErrors: { name: ["Name must be 100 characters or fewer"] } } }, "Add Member");
    expect(f.kind).toBe("invalid");
    expect(f.message).toContain("name: Name must be 100 characters or fewer");
  });
});
