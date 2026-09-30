// @vitest-environment jsdom
// End-user round 3 (30 Sep 2026): right after the welcome flow the member's
// action list still said "Sign your waiver · Add an emergency contact" (it was
// fetched before both were done), and on reload showed "Couldn't load your
// action list" until Try again — which then worked. And the welcome question
// "Any children training here?" ignored children the desk had already linked.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import MemberActionsPanel from "@/components/member/MemberActionsPanel";
import { linkedChildNames, alreadyLinkedLine, duplicateOfLinked } from "@/lib/member-onboarding";

const ITEM = { id: "sys-waiver", kind: "system", title: "Sign your waiver", body: null, createdAt: null, createdBy: null, href: "/member/profile" };
const ok = (items: unknown[]) => ({ ok: true, status: 200, json: async () => ({ items }) });
const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: "x" }) });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MemberActionsPanel first load", () => {
  it("a first failure is re-read once before any error is shown", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(500)).mockResolvedValueOnce(ok([ITEM]));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemberActionsPanel mode="compact" />);
    await waitFor(() => expect(screen.getByText("Sign your waiver")).toBeTruthy(), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't load your action list/)).toBeNull();
  });

  it("two failures in a row are an error, never an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(500)));
    render(<MemberActionsPanel mode="compact" />);
    await waitFor(() => expect(screen.getByText(/Couldn't load your action list/)).toBeTruthy(), { timeout: 3000 });
  });

  it("a 401 is not retried", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(401));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemberActionsPanel mode="compact" />);
    await waitFor(() => expect(screen.getByText(/Couldn't load your action list/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("member home re-reads the action list when the welcome flow closes", () => {
  const src = readFileSync(path.join(process.cwd(), "app/member/home/page.tsx"), "utf8");
  it("the panel is keyed, and closing the welcome flow bumps the key", () => {
    expect(src).toMatch(/<MemberActionsPanel key=\{actionsKey\} mode="compact" \/>/);
    expect(src).toMatch(/onDone=\{\(\) => \{ setShowOnboarding\(false\); setActionsKey\(\(k\) => k \+ 1\); \}\}/);
  });
});

describe("the welcome question knows the children already linked", () => {
  it("reads names from GET /api/member/me/children", () => {
    expect(linkedChildNames([{ id: "1", name: "Kai" }, { id: "2", name: " Mia " }, { id: "3" }])).toEqual(["Kai", "Mia"]);
    expect(linkedChildNames({ error: "x" })).toEqual([]);
  });
  it("says who is already linked", () => {
    expect(alreadyLinkedLine(["Kai", "Mia"])).toBe("Already linked: Kai, Mia");
    expect(alreadyLinkedLine([])).toBeNull();
  });
  it("flags a typed name that is a child already linked", () => {
    expect(duplicateOfLinked(["kai", "Noor", "  Mia  "], ["Kai", "Mia"])).toEqual(["kai", "  Mia  "]);
    expect(duplicateOfLinked(["Noor", ""], ["Kai"])).toEqual([]);
  });
  it("the step fetches the linked children and refuses to continue on a duplicate", () => {
    const src = readFileSync(path.join(process.cwd(), "app/member/home/page.tsx"), "utf8");
    expect(src).toContain('fetch("/api/member/me/children")');
    expect(src).toContain("duplicates.length === 0");
    expect(src).toContain('data-testid="onboarding-linked-kids"');
  });
});
