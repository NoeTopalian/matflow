// RULES §2: a 400 must say which field, not "Invalid data". Zod's
// flatten() arrives as { fieldErrors: { coachName: ["…"] } } and the
// timetable's handleSave threw away everything but `error`.
import { describe, it, expect } from "vitest";
import { describeApiError } from "@/lib/api-field-errors";

describe("describeApiError", () => {
  it("names each failing field after the server's sentence", () => {
    const body = {
      error: "Invalid data",
      details: {
        fieldErrors: { coachName: ["expected string, received null"], location: ["too long"] },
        formErrors: [],
      },
    };
    expect(describeApiError(body)).toBe(
      "Invalid data — coachName: expected string, received null; location: too long",
    );
  });

  it("falls back to the bare error, then to a generic sentence", () => {
    expect(describeApiError({ error: "Forbidden" })).toBe("Forbidden");
    expect(describeApiError(null)).toBe("Something went wrong");
    expect(describeApiError("<!DOCTYPE html>")).toBe("Something went wrong");
  });

  it("shows a route's own sentences alone, without the field's code name", () => {
    const body = { error: "Invalid data", details: { fieldErrors: { paidAt: ["Date paid can't be in the future"] }, formErrors: [] } };
    expect(describeApiError(body)).toBe("Date paid can't be in the future.");
  });

  // Verifier lane 7 (30 Sep 2026): these reached four screens as raw text.
  it("turns the validator's own defaults into sentences that name the field", () => {
    const fe = (fieldErrors: Record<string, string[]>) => ({ error: "Invalid data", details: { fieldErrors, formErrors: [] } });
    expect(describeApiError(fe({ name: ["Too big: expected string to have <=120 characters"] }))).toBe("Name must be 120 characters or fewer.");
    expect(describeApiError(fe({ name: ["Too small: expected string to have >=1 characters"] }))).toBe("Name is required.");
    expect(describeApiError(fe({ amountPence: ["Too big: expected number to be <=1000000"] }))).toBe("Amount must be £10,000 or less.");
    expect(describeApiError(fe({ maxClassesPerWeek: ["Too big: expected number to be <=30"] }))).toBe("Classes per week must be 30 or less.");
    expect(describeApiError(fe({ email: ["Invalid email address"] }))).toBe("Enter a valid email address.");
    expect(describeApiError(fe({ emergencyContactPhone: ["Too big: expected string to have <=40 characters"] }))).toBe(
      "Emergency contact phone must be 40 characters or fewer.",
    );
  });

  it("keeps the field name for a default it does not recognise", () => {
    const body = { error: "Invalid data", details: { fieldErrors: { status: ["Invalid option: expected one of \"active\"|\"cancelled\""] }, formErrors: [] } };
    expect(describeApiError(body)).toBe('Invalid data — status: Invalid option: expected one of "active"|"cancelled"');
  });
});
