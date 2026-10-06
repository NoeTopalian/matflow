/**
 * The owner-activation link is a live sign-in credential (6 Oct 2026, lane I
 * review). When mail is not configured, the approve route used to write it to
 * the server log in every environment, production included. In production the
 * log line must name the problem without the link.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../app/api/admin/applications/[id]/approve/route.ts"),
  "utf8",
);

describe("approve route — activation link never reaches production logs", () => {
  it("has a production-only branch for the unconfigured-mail case", () => {
    expect(SRC).toMatch(/else if \(process\.env\.NODE_ENV === "production"\)/);
  });

  it("the production branch logs without interpolating the link", () => {
    const start = SRC.indexOf('else if (process.env.NODE_ENV === "production")');
    const end = SRC.indexOf("} else {", start);
    const branch = SRC.slice(start, end);
    expect(branch).toContain("console.error");
    expect(branch).not.toContain("${link}");
  });

  it("the JSON response still withholds the link in production", () => {
    expect(SRC).toContain('activationLink: process.env.NODE_ENV === "production" ? undefined : link');
  });
});
