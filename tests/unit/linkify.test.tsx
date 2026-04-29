// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { linkify } from "@/lib/linkify";

function Rendered({ text }: { text: string }) {
  return <span>{linkify(text)}</span>;
}

describe("linkify", () => {
  it("wraps a single https URL in an <a> tag", () => {
    render(<Rendered text="Visit https://example.com today" />);
    const link = screen.getByRole("link");
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.textContent).toBe("https://example.com");
  });

  it("wraps two URLs in two <a> tags", () => {
    render(<Rendered text="Two: https://a.com and https://b.com" />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("https://a.com");
    expect(links[1].getAttribute("href")).toBe("https://b.com");
  });

  it("strips trailing dot from URL and renders it as text after", () => {
    const { container } = render(<Rendered text="Trailing dot https://example.com." />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.textContent).toBe("https://example.com");
    // The dot is rendered as plain text after the link
    expect(container.textContent).toContain(".");
    expect(container.textContent).toMatch(/https:\/\/example\.com\./);
  });

  it("linkifies a URL on its own line in multi-line text", () => {
    render(<Rendered text={"Multi-line\nhttps://example.com\nstays"} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com");
  });

  it("does not inject raw HTML — surrounding angle-bracket text is plain text", () => {
    const { container } = render(<Rendered text={"Click <a href='https://x'>here</a>"} />);
    // The surrounding `<a href='` prefix and `'>here</a>` suffix must appear as
    // literal text content, not as real DOM elements injected via innerHTML.
    // dangerouslySetInnerHTML is never used, so angle-bracket text is always safe.
    expect(container.textContent).toContain("<a href=");
    expect(container.textContent).toContain(">here</a>");
    // No "here" text node should be inside an <a> (that would indicate real HTML injection)
    const links = Array.from(container.querySelectorAll("a"));
    const injectedAnchors = links.filter((el) => el.textContent === "here");
    expect(injectedAnchors).toHaveLength(0);
  });

  it("does not create a link for javascript: protocol", () => {
    render(<Rendered text="javascript:alert(1)" />);
    const links = screen.queryAllByRole("link");
    expect(links).toHaveLength(0);
  });
});
