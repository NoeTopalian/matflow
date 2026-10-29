// @vitest-environment jsdom
//
// The coach card scanner and a used-up plan allowance (owner decision,
// 27 Oct 2026): no "Admit anyway". The server answers the card with
// status "refused", reason "allowance_reached" and the staff sentence; the
// row shows that sentence and nothing else (the squad-list / membership hint
// is for those reasons only), the label reads "Allowance used", the screen
// reader hears "<name>, class allowance used. Can't be checked in.", and no
// card is ever resent with an acknowledgement. A "needs_confirmation" body
// from an old server is not a status the scanner accepts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import CardScanner, { type ScannerInstance } from "@/components/dashboard/CardScanner";
import { HOLD_GAP_MS } from "@/lib/scan-holds";

const INSTANCE: ScannerInstance = { id: "ci_1", name: "Fundamentals", startTime: "18:00", endTime: "19:00", location: null };

let inView: string[] = [];
class FakeDetector {
  static getSupportedFormats = async () => ["qr_code"];
  async detect() {
    return inView.map((rawValue) => ({ rawValue }));
  }
}

function okJson(body: unknown) {
  return { ok: true, status: 200, type: "basic", headers: { get: () => "application/json" }, json: async () => body };
}

let fetchMock: ReturnType<typeof vi.fn>;

async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function startCamera() {
  render(<CardScanner instance={INSTANCE} />);
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  await tick(0);
  await tick(0);
}

async function hold(token: string, ms = 500, gap = HOLD_GAP_MS + 250) {
  inView = [token];
  await tick(ms);
  inView = [];
  await tick(gap);
}

const STAFF_SENTENCE =
  "Ava Green has used all 4 classes this 4-week period (resets on Monday 26 October) and has no class-pack credit, so they can't be checked in.";
const TIER_SENTENCE = "Advanced isn't included in your Beginners Unlimited membership. For further information, please speak to a coach.";
const MEMBERSHIP_HINT = "Change their membership or the squad list to admit them.";

beforeEach(() => {
  vi.useFakeTimers();
  inView = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
});

describe("CardScanner - plan allowance used (no override)", () => {
  it("shows the staff sentence with no membership hint and no Admit anyway button, labels it, and announces it", async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      results: [{ index: 0, status: "refused", memberId: "m1", memberName: "Ava Green", reason: "allowance_reached", message: STAFF_SENTENCE }],
      recorded: 0, failed: 1,
    }));
    await startCamera();
    await hold("card-A");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).not.toHaveProperty("acknowledged");

    const sentence = screen.getByText(STAFF_SENTENCE);
    expect(sentence.textContent).toBe(STAFF_SENTENCE);
    expect(screen.queryByText(new RegExp(MEMBERSHIP_HINT))).toBeNull();
    expect(screen.queryByRole("button", { name: /Admit anyway/ })).toBeNull();
    expect(screen.getAllByText("Allowance used").length).toBeGreaterThan(0);
    expect(screen.getByRole("status").textContent).toBe("Ava Green, class allowance used. Can't be checked in.");

    // Holding the card again resends nothing new with a confirmation: a refusal is settled.
    await hold("card-A");
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse((call[1] as RequestInit).body as string)).not.toHaveProperty("acknowledged");
    }
  });

  it("a tier refusal keeps its remedy hint", async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      results: [{ index: 0, status: "refused", memberId: "m1", memberName: "Ava Green", reason: "tier_not_included", message: TIER_SENTENCE }],
      recorded: 0, failed: 1,
    }));
    await startCamera();
    await hold("card-B");
    expect(screen.getByText(`${TIER_SENTENCE} ${MEMBERSHIP_HINT}`)).toBeTruthy();
    expect(screen.getAllByText("Refused").length).toBeGreaterThan(0);
  });

  it("an old server's needs_confirmation is not a status the scanner accepts", async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      results: [{ index: 0, status: "needs_confirmation", memberName: "Ava Green", reason: "allowance_reached", question: "Admit anyway?" }],
    }));
    await startCamera();
    await hold("card-C");
    expect(screen.queryByRole("button", { name: /Admit anyway/ })).toBeNull();
    expect(screen.getAllByText("Didn't record").length).toBeGreaterThan(0);
  });
});
