// @vitest-environment jsdom
//
// The coach card scanner, end to end through the component with a fake camera,
// fake timers and a mocked fetch:
//   - the third-hold defect: after a second retryable failure (timed_out here)
//     the token stayed "seen", so a third hold did nothing while the row still
//     said to hold the card again. Every new hold after a retryable failure now
//     sends a fresh request;
//   - a card left still under the lens is one hold and is sent once, so a
//     retryable failure does not turn into a 4 Hz resubmit loop;
//   - the timeout copy never promises "Already in", and tells the coach what a
//     repeat means and what to do if it also fails.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import CardScanner, { type ScannerInstance } from "@/components/dashboard/CardScanner";
import { HOLD_GAP_MS } from "@/lib/scan-holds";

const INSTANCE: ScannerInstance = {
  id: "ci_1",
  name: "Fundamentals",
  startTime: "18:00",
  endTime: "19:00",
  location: null,
};

/** What the fake camera sees on each 250 ms tick. */
let inView: string[] = [];

class FakeDetector {
  static getSupportedFormats = async () => ["qr_code"];
  async detect() {
    return inView.map((rawValue) => ({ rawValue }));
  }
}

function timeoutError() {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    type: "basic",
    headers: { get: () => "application/json" },
    json: async () => body,
  };
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
  // getSupportedFormats, getUserMedia, play, wake lock: microtasks only.
  await tick(0);
  await tick(0);
  expect(screen.getByRole("button", { name: "Stop camera" })).toBeTruthy();
}

/** Holds the card under the lens for `ms`, then lifts it away for `gap`. */
async function hold(token: string, ms = 500, gap = HOLD_GAP_MS + 250) {
  inView = [token];
  await tick(ms);
  inView = [];
  await tick(gap);
}

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

describe("CardScanner holds after retryable failures", () => {
  it("first, second and third hold after timeouts each send a fresh request; the fourth records", async () => {
    fetchMock
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(okJson({ results: [{ index: 0, status: "duplicate", memberName: "Ada Example" }] }));
    await startCamera();

    await hold("card-A");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("No answer yet").length).toBeGreaterThan(0);

    await hold("card-A");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The defect: this third hold used to send nothing.
    await hold("card-A");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await hold("card-A");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByText(/Last: Ada Example — Already in/)).toBeTruthy();

    // Settled now: a further hold sends nothing.
    await hold("card-A");
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Every request was a single card, never a confirm resend.
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({ classInstanceId: "ci_1", tokens: ["card-A"] });
    }
  });

  it("a card left still under the lens through repeated failures is sent once, not at 4 Hz", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    await startCamera();
    inView = ["card-A"];
    await tick(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Lift it away and hold it again: one fresh request.
    inView = [];
    await tick(HOLD_GAP_MS + 250);
    inView = ["card-A"];
    await tick(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("network and server failures re-arm on every new hold too", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: false, status: 503, type: "basic", headers: { get: () => "text/plain" }, json: async () => null })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(okJson({ results: [{ index: 0, status: "success", memberName: "Ada Example" }] }));
    await startCamera();
    for (let i = 1; i <= 4; i++) {
      await hold("card-A");
      expect(fetchMock).toHaveBeenCalledTimes(i);
    }
    expect(screen.getByText(/Last: Ada Example — Checked in/)).toBeTruthy();
  });

  it("a non-retryable answer (rate limited) keeps the card settled", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, type: "basic", headers: { get: () => "text/plain" }, json: async () => null });
    await startCamera();
    await hold("card-A");
    await hold("card-A");
    await hold("card-A");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("CardScanner timeout copy", () => {
  it("never promises Already in, says what a repeat means and what to do if it fails again", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    await startCamera();
    await hold("card-A");
    const hint = screen.getByText(/MatFlow may still have recorded it/);
    expect(hint.textContent).toBe(
      "MatFlow may still have recorded it. Lift the card away and hold it again: Checked in or Already in means they're in. If there's still no answer, check the register before ticking them.",
    );
    expect(hint.textContent).not.toMatch(/will say Already in/);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("No answer yet for that card. It may still have been recorded. Lift it away and hold it again to check.");
  });

  it("the retry hints say lift-and-hold, matching what actually resends", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await startCamera();
    await hold("card-A");
    expect(
      screen.getByText("Check signal, then lift the card away and hold it again — if it fails twice, use the register."),
    ).toBeTruthy();
  });
});
