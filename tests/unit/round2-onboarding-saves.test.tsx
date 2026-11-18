// Round 2 close-out (10 Nov 2026): the owner wizard advances only after the
// server confirms a save; a refused or unanswered save keeps the owner on the
// step with what they entered, and a second press while saving sends nothing.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }) }));
vi.mock("@/components/onboarding/TotpEnrollmentStep", () => ({ default: () => null }));

import OwnerOnboardingWizard from "@/components/onboarding/OwnerOnboardingWizard";

const TENANT = "Synthetic BJJ";
type Answer = () => Promise<unknown>;
let answer: Answer;
let patches: Record<string, unknown>[];

function ok(): Promise<unknown> {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
}

beforeEach(() => {
  sessionStorage.clear();
  patches = [];
  answer = ok;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/settings") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return answer();
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function startAt(step: number) {
  sessionStorage.setItem(`matflow.onboarding.step.${TENANT}`, String(step));
  render(<OwnerOnboardingWizard tenantName={TENANT} ownerName="Sam" primaryColor="#3b82f6" />);
}

describe("step 1 (club name and time zone)", () => {
  it("a refused save keeps the owner on the step, keeps the name, and says why", async () => {
    startAt(1);
    const name = (await screen.findByLabelText("Gym Name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Synthetic BJJ Kent" } });
    answer = () => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "Invalid data" }) });
    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
    const alert = await screen.findByTestId("onboarding-step-error");
    expect(alert.textContent).toBe("That wasn't saved: Invalid data. Check what you entered and try again.");
    expect((screen.getByLabelText("Gym Name") as HTMLInputElement).value).toBe("Synthetic BJJ Kent");
    // Still step 1, and the button is usable again.
    await waitFor(() => expect((screen.getByRole("button", { name: "Continue →" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("an unexpected server failure says it wasn't saved, without the server's internals", async () => {
    startAt(1);
    fireEvent.change(await screen.findByLabelText("Gym Name"), { target: { value: "X" } });
    answer = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "PrismaClientKnownRequestError P2002" }) });
    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
    const alert = await screen.findByTestId("onboarding-step-error");
    expect(alert.textContent).toBe("That wasn't saved. Everything you entered is still here; try again.");
    expect(alert.textContent).not.toContain("Prisma");
  });

  it("no reply: says the outcome is unknown, never 'nothing was saved', and stays", async () => {
    startAt(1);
    fireEvent.change(await screen.findByLabelText("Gym Name"), { target: { value: "X" } });
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Continue →" }));
    const alert = await screen.findByTestId("onboarding-step-error");
    expect(alert.textContent).toContain("it isn't known whether this was saved");
    expect(alert.textContent).not.toMatch(/nothing was saved/i);
    expect(screen.getByLabelText("Gym Name")).toBeTruthy();
  });

  it("a second press while the save is out sends nothing more; success advances", async () => {
    startAt(1);
    fireEvent.change(await screen.findByLabelText("Gym Name"), { target: { value: "X" } });
    let release!: () => void;
    answer = () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) }); });
    const btn = screen.getByRole("button", { name: "Continue →" }) as HTMLButtonElement;
    // Three presses in one batch, before React re-renders the button as
    // disabled (a fast double-tap or a held Enter): only one save may go out.
    act(() => {
      btn.click();
      btn.click();
      btn.click();
    });
    await waitFor(() => expect(patches.length).toBe(1));
    release();
    await waitFor(() => expect(screen.queryByLabelText("Gym Name")).toBeNull());
    expect(patches.length).toBe(1);
    expect(screen.queryByTestId("onboarding-step-error")).toBeNull();
  });
});

describe("step 6 (questionnaire)", () => {
  it("a refused save stays on the step with the answer still chosen", async () => {
    startAt(6);
    const size = await screen.findByRole("button", { name: "21–50" });
    fireEvent.click(size);
    answer = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect((await screen.findByTestId("onboarding-step-error")).textContent).toContain("wasn't saved");
    expect(screen.getByRole("button", { name: "21–50" })).toBeTruthy();
    expect(patches[0]).toMatchObject({ onboardingAnswers: { size: "21–50" } });
  });
});

describe("step 9 (finish)", () => {
  it("a refused completion does not show the finished screen", async () => {
    startAt(9);
    const manual = await screen.findByRole("button", { name: /add members myself|manually|later/i });
    fireEvent.click(manual);
    answer = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    fireEvent.click(screen.getByRole("button", { name: "Finish setup →" }));
    expect((await screen.findByTestId("onboarding-step-error")).textContent).toContain("wasn't saved");
    expect(patches).toEqual([{ onboardingCompleted: true }]);
    expect(screen.getByRole("button", { name: "Finish setup →" })).toBeTruthy();
  });
});
