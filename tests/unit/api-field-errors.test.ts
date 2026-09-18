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
});
