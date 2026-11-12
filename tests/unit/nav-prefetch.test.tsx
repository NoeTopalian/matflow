// @vitest-environment jsdom
//
// Speed quick win 2f (6 Nov 2026): Next's <Link> prefetches every route it can
// see once the page is idle — on a desktop dashboard that was every sidebar
// entry, each a full server render with its own session check and queries.
// Only the four main destinations (the phone's bottom tabs) keep the default;
// every other staff link has prefetch={false}.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({ links: [] as { href: string; prefetch: unknown }[] }));

vi.mock("next/link", () => ({
  default: ({ href, prefetch, children }: { href: string; prefetch?: unknown; children?: React.ReactNode }) => {
    h.links.push({ href, prefetch });
    return <a href={href}>{children}</a>;
  },
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));

import Sidebar from "@/components/layout/Sidebar";
import MobileNav from "@/components/layout/MobileNav";
import { STAFF_NAV, navPrefetch } from "@/components/layout/routes";

const MAIN = ["/dashboard", "/dashboard/timetable", "/dashboard/checkin", "/dashboard/members"];

afterEach(() => {
  cleanup();
  h.links = [];
});

describe("navPrefetch", () => {
  it("keeps the default for exactly the four main destinations", () => {
    const kept = STAFF_NAV.filter((i) => navPrefetch(i) === undefined).map((i) => i.href);
    expect(kept.sort()).toEqual([...MAIN].sort());
  });
  it("turns it off for every other staff link", () => {
    for (const item of STAFF_NAV.filter((i) => !MAIN.includes(i.href))) expect(navPrefetch(item)).toBe(false);
  });
});

describe("the staff navs use it", () => {
  it("desktop sidebar (owner sees every entry)", () => {
    render(<Sidebar role="owner" tenantName="Club" />);
    const seen = new Map(h.links.map((l) => [l.href, l.prefetch]));
    for (const item of STAFF_NAV) {
      expect(seen.has(item.href), item.href).toBe(true);
      expect(seen.get(item.href), item.href).toBe(MAIN.includes(item.href) ? undefined : false);
    }
  });

  it("phone More sheet: secondary links off; bottom tabs keep the default", () => {
    render(<MobileNav role="owner" primaryColor="#3b82f6" />);
    const secondary = h.links.filter((l) => !MAIN.includes(l.href));
    const primary = h.links.filter((l) => MAIN.includes(l.href));
    expect(secondary.length).toBeGreaterThan(0);
    expect(secondary.every((l) => l.prefetch === false)).toBe(true);
    expect(primary.length).toBe(MAIN.length);
    expect(primary.every((l) => l.prefetch === undefined)).toBe(true);
  });
});
