// @vitest-environment jsdom
// The support banner's end time renders in the VIEWER's timezone, never the
// server's (owner screenshot 12 Oct 2026: "ends 17:42" at 18:12 UK on Vercel).
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import React from "react";
import LocalTime from "@/components/layout/LocalTime";
import { formatTime } from "@/lib/date";

const EPOCH = Date.UTC(2026, 9, 12, 17, 42, 24); // 17:42:24 UTC = 18:42 in London (BST)

describe("LocalTime", () => {
  it("renders no server-zone time into the HTML (the server snapshot is empty)", () => {
    const html = renderToString(<LocalTime epochMs={EPOCH} />);
    // Machine-readable instant in the attribute, no human time in the text.
    expect(html).toMatch(/<time[^>]*>\s*<\/time>/);
  });

  it("renders the time in the browser's own timezone on the client", () => {
    const { container } = render(<LocalTime epochMs={EPOCH} />);
    expect(container.querySelector("time")?.textContent).toBe(formatTime(EPOCH));
  });

  it("formats 17:42 UTC as 18:42 for a London viewer (the reported case)", () => {
    const london = new Date(EPOCH).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
    expect(london).toBe("18:42");
  });
});
