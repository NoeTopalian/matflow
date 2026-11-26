// @vitest-environment jsdom
//
// The scanner while the class picker is open (25 Nov 2026). A card read while
// the coach is choosing a class must not be marked into either class: not now,
// and not later when the picker closes. Fake camera, fake timers, mocked fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";
import CardScanner, { type ScannerInstance } from "@/components/dashboard/CardScanner";
import { HOLD_GAP_MS } from "@/lib/scan-holds";

const A: ScannerInstance = { id: "ci_a", name: "Fundamentals", startTime: "18:00", endTime: "19:00", location: null };
const B: ScannerInstance = { id: "ci_b", name: "Advanced", startTime: "18:00", endTime: "19:00", location: null };

let inView: string[] = [];
class FakeDetector {
  static getSupportedFormats = async () => ["qr_code"];
  async detect() {
    return inView.map((rawValue) => ({ rawValue }));
  }
}

const okJson = (body: unknown) => ({ ok: true, status: 200, type: "basic", headers: { get: () => "application/json" }, json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { classInstanceId: string; tokens: string[] });

async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function start() {
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  await tick(0);
  await tick(0);
  expect(screen.getByRole("button", { name: "Stop camera" })).toBeTruthy();
}

beforeEach(() => {
  vi.useFakeTimers();
  inView = [];
  fetchMock = vi.fn(async () => okJson({ results: [{ status: "checked_in", memberName: "Ada Example" }] }));
  vi.stubGlobal("fetch", fetchMock);
  (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("card scanner: paused while the class picker is open", () => {
  it("a card held while paused is not sent, and is not sent later when the pause ends", async () => {
    const { rerender } = render(<CardScanner instance={A} />);
    await start();
    rerender(<CardScanner instance={A} paused />);
    inView = ["card-1"];
    await tick(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    // Lifted away before the picker closes: nothing was held back to replay.
    inView = [];
    await tick(HOLD_GAP_MS + 250);
    rerender(<CardScanner instance={A} paused={false} />);
    await tick(1500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Scans")).toBeNull();
  });

  it("a scan after the pause goes in once, to the class on screen", async () => {
    const { rerender } = render(<CardScanner instance={A} paused />);
    await start();
    inView = ["card-1"];
    await tick(750);
    expect(fetchMock).not.toHaveBeenCalled();
    rerender(<CardScanner instance={A} paused={false} />);
    // Still under the lens: read now, as one hold.
    await tick(1500);
    expect(sent()).toEqual([{ classInstanceId: "ci_a", tokens: ["card-1"] }]);
  });

  it("another class is another scanner: the camera of the last one is stopped and its card is not carried over", async () => {
    // The page keys the scanner on the session id, as here.
    const { rerender } = render(<CardScanner key={A.id} instance={A} />);
    await start();
    inView = ["card-1"];
    rerender(<CardScanner key={B.id} instance={B} />);
    await tick(1500);
    // The new class's camera has not been started, so nothing is read into it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start camera" })).toBeTruthy();
    await start();
    await tick(750);
    expect(sent()).toEqual([{ classInstanceId: "ci_b", tokens: ["card-1"] }]);
  });

  it("a blocked camera offers the other method without leaving the class", async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const onUseName = vi.fn();
    render(<CardScanner instance={A} onUseName={onUseName} />);
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
    await tick(0);
    await tick(0);
    expect(screen.getByRole("alert").textContent).toContain("Camera access was blocked");
    fireEvent.click(screen.getByRole("button", { name: "Use name instead" }));
    expect(onUseName).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
