// @vitest-environment jsdom
//
// The sub-processor list was its own page (/legal/subprocessors) until
// 24 Nov 2026. The page is gone; the list lives in the privacy policy, and
// nothing may point at the old address except the redirect that keeps it
// working for anyone holding an old link.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import PrivacyPage from "@/app/legal/privacy/page";
import TermsPage from "@/app/legal/terms/page";
import sitemap from "@/app/sitemap";
import { LandingFooter } from "@/components/landing/LandingFooter";

const ROOT = resolve(__dirname, "../..");
const OLD = "/legal/subprocessors";

afterEach(cleanup);

describe("sub-processor list", () => {
  it("is in the privacy policy, with every provider the old page listed", () => {
    const { container } = render(<PrivacyPage />);
    const section = container.querySelector("section#sub-processors") as HTMLElement;
    expect(within(section).getByRole("heading", { name: "5. Sub-processors" })).toBeTruthy();
    expect(section.textContent).toContain("The current list is below.");
    const providers = within(section).getAllByRole("row").slice(1).map((r) => r.querySelector("td")?.textContent);
    expect(providers).toEqual([
      "Vercel",
      "Neon",
      "Stripe",
      "Resend",
      "Vercel Blob",
      "Anthropic (Claude)",
      "Google Cloud (Drive API)",
    ]);
    // Purpose, data and region for each.
    for (const row of within(section).getAllByRole("row").slice(1)) {
      const cells = Array.from(row.querySelectorAll("td")).map((td) => td.textContent ?? "");
      expect(cells.length).toBe(4);
      for (const cell of cells) expect(cell.length).toBeGreaterThan(2);
    }
  });

  it("is where the terms send the reader", () => {
    render(<TermsPage />);
    expect(screen.getByRole("link", { name: "sub-processor list" }).getAttribute("href")).toBe("/legal/privacy#sub-processors");
  });

  it("has no page of its own, and no link, menu entry or sitemap entry points at one", () => {
    expect(existsSync(resolve(ROOT, "app/legal/subprocessors"))).toBe(false);
    for (const file of ["app/legal/layout.tsx", "app/legal/terms/page.tsx", "components/landing/LandingFooter.tsx", "app/sitemap.ts"]) {
      expect(readFileSync(resolve(ROOT, file), "utf8"), file).not.toContain(OLD);
    }
    expect(sitemap().map((entry) => entry.url).filter((url) => url.includes("subprocessors"))).toEqual([]);
    render(<LandingFooter />);
    expect(screen.queryByRole("link", { name: /sub-?processors/i })).toBeNull();
  });

  it("the old address redirects to the list for good", () => {
    const config = readFileSync(resolve(ROOT, "next.config.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(config).toContain(
      'source: "/legal/subprocessors",\n        destination: "/legal/privacy#sub-processors",\n        permanent: true,',
    );
  });
});
