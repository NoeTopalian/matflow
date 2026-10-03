// @vitest-environment jsdom
// 3 Oct 2026: the guardian review queue on the Members page. An import may
// SUGGEST a parent link; the owner/manager confirms or rejects each one here,
// one at a time, through the same POST /api/members/[child]/guardian route the
// Family card uses. Pinned: the rows come from ?guardianReview=1; Confirm
// posts to the CHILD's route and the row leaves; an under-13 offers no reject
// (the database requires a guardian); a load failure is an error with retry,
// never "nothing to review"; and there is no bulk action.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
const toastMock = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import GuardianReviewQueue, { type GuardianSuggestion } from "@/components/dashboard/GuardianReviewQueue";

afterEach(cleanup);
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const s = (childId: string, childName: string, over: Partial<GuardianSuggestion> = {}): GuardianSuggestion => ({
  childId,
  childName,
  childAccountType: "kids",
  childDateOfBirth: null,
  childStatus: "active",
  guardianId: `g-${childId}`,
  guardianName: "Pat",
  guardianCanSignIn: false,
  source: "emergency_contact",
  sourceLabel: "Emergency contact",
  ...over,
});

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

describe("GuardianReviewQueue", () => {
  it("loads the review list and shows child, suggested guardian and source", async () => {
    fetchMock.mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit"), s("k2", "Jo", { childAccountType: "junior", guardianName: "Sam", guardianCanSignIn: true, sourceLabel: "Shared email address" })], total: 2, nextCursor: null }));
    const onTotal = vi.fn();
    render(<GuardianReviewQueue onTotalChange={onTotal} />);
    await screen.findByText("Kit");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/members?guardianReview=1");
    expect(screen.getByText("Guardian suggestions to review · 2")).toBeTruthy();
    expect(screen.getAllByTestId("guardian-review-row")).toHaveLength(2);
    expect(screen.getByText(/from shared email address/)).toBeTruthy();
    expect(screen.getByText(/Can sign in — confirming gives them access straight away/)).toBeTruthy();
    expect(onTotal).toHaveBeenLastCalledWith(2);
  });

  it("deciding every loaded row while more wait behind the cursor never shows the all-done message", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit")], total: 51, nextCursor: "c2" }))
      .mockResolvedValueOnce(ok({ ok: true, message: "Pat is confirmed as Kit's guardian." }))
      .mockResolvedValueOnce(ok({ suggestions: [s("k2", "Jo")], total: 50, nextCursor: null }));
    render(<GuardianReviewQueue />);
    await screen.findByText("Kit");
    fireEvent.click(screen.getByRole("button", { name: /^confirm/i }));
    await waitFor(() => expect(screen.queryByText("Kit")).toBeNull());
    expect(screen.queryByText(/No guardian suggestions to review/)).toBeNull();
    const next = await screen.findByRole("button", { name: /show the next suggestions/i });
    fireEvent.click(next);
    await screen.findByText("Jo");
    expect(String(fetchMock.mock.calls[2][0])).toContain("cursor=c2");
  });

  it("Confirm posts confirm to the CHILD's guardian route; the row leaves and the total drops", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit")], total: 1, nextCursor: null }))
      .mockResolvedValueOnce(ok({ ok: true, message: "Pat is confirmed as Kit's guardian." }));
    const onTotal = vi.fn();
    render(<GuardianReviewQueue onTotalChange={onTotal} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Pat as Kit's guardian" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/members/k1/guardian");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "confirm", adoptUnverifiedEmail: false });
    await waitFor(() => expect(screen.queryByText("Kit")).toBeNull());
    expect(onTotal).toHaveBeenLastCalledWith(0);
    expect(toastMock).toHaveBeenCalledWith("Pat is confirmed as Kit's guardian.", "success");
    expect(screen.getByText("No guardian suggestions to review")).toBeTruthy();
  });

  it("a refused confirm keeps the row and says why", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit")], total: 1, nextCursor: null }))
      .mockResolvedValueOnce(fail(409, { error: "The guardian link changed while you were looking at it — reload." }));
    render(<GuardianReviewQueue />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Pat as Kit's guardian" }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("The guardian link changed while you were looking at it — reload.", "error"));
    expect(screen.getByText("Kit")).toBeTruthy();
  });

  it("an under-13 offers no reject; a 13–17 rejects through a confirmation dialog", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit"), s("j1", "Jo", { childAccountType: "junior", guardianName: "Sam" })], total: 2, nextCursor: null }))
      .mockResolvedValueOnce(ok({ ok: true, message: "Sam is no longer linked to Jo." }));
    render(<GuardianReviewQueue />);
    await screen.findByText("Kit");
    expect(screen.queryByRole("button", { name: "Pat is not Kit's guardian" })).toBeNull();
    expect(screen.getByText(/Under 13 — if wrong, open the right guardian and use Link existing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sam is not Jo's guardian" }));
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing sent until the dialog is confirmed
    fireEvent.click(await screen.findByRole("button", { name: "Remove suggestion" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/members/j1/guardian");
    expect(JSON.parse(String(init.body)).action).toBe("reject");
    await waitFor(() => expect(screen.queryByText("Jo")).toBeNull());
  });

  it("a failed load is an error with retry — never 'nothing to review'", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(500, { error: "Couldn't load the guardian suggestions. Try again.", reference: "MF-ABC123" }))
      .mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit")], total: 1, nextCursor: null }));
    render(<GuardianReviewQueue />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Couldn't load the guardian suggestions. Try again.")).toBeTruthy();
    expect(screen.queryByText("No guardian suggestions to review")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Kit");
  });

  it("offers no bulk action — each confirmation is its own decision", async () => {
    fetchMock.mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit"), s("k2", "Kim")], total: 2, nextCursor: null }));
    render(<GuardianReviewQueue />);
    await screen.findByText("Kit");
    expect(screen.queryByRole("button", { name: /all/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Confirm .* guardian$/ })).toHaveLength(2);
  });

  it("Show more loads the next page with the cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ suggestions: [s("k1", "Kit")], total: 2, nextCursor: "k1" }))
      .mockResolvedValueOnce(ok({ suggestions: [s("k2", "Kim")], total: 2, nextCursor: null }));
    render(<GuardianReviewQueue />);
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    await screen.findByText("Kim");
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=k1");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});
