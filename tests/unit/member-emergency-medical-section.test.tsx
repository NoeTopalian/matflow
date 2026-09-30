// @vitest-environment jsdom
//
// Verifier lane 2, defect 4 (30 Sep 2026): a member could not see or change
// their emergency contact or medical notes after the welcome wizard. The
// Profile page now carries a card for both, read from GET /api/member/me and
// saved with PATCH /api/member/me.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

import EmergencyMedicalSection from "@/components/member/EmergencyMedicalSection";

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

const ME = {
  emergencyContactName: "Maria Link",
  emergencyContactPhone: "07700 900123",
  emergencyContactRelation: "Mother",
  medicalConditions: JSON.stringify(["Asthma", "None of the above"]),
};

function stubFetch(handler: (url: string, method: string) => { ok: boolean; status: number; body: unknown } | "throw") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = handler(url, method);
      if (r === "throw") throw new TypeError("Failed to fetch");
      return { ok: r.ok, status: r.status, json: async () => r.body };
    }),
  );
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EmergencyMedicalSection (lane 2, defect 4)", () => {
  it("shows the stored contact and medical notes, without 'None of the above'", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: ME }));
    render(<EmergencyMedicalSection />);
    expect(await screen.findByText("Maria Link")).toBeTruthy();
    expect(screen.getByText("07700 900123")).toBeTruthy();
    expect(screen.getByText("Mother")).toBeTruthy();
    expect(screen.getByText("Asthma")).toBeTruthy();
    expect(screen.queryByText(/None of the above/)).toBeNull();
  });

  it("Edit → change → Save sends the PATCH body and shows the new values", async () => {
    stubFetch((_url, method) => (method === "PATCH" ? { ok: true, status: 200, body: { ok: true } } : { ok: true, status: 200, body: ME }));
    const onSaved = vi.fn();
    render(<EmergencyMedicalSection onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit emergency contact/ }));

    fireEvent.change(screen.getByLabelText("Their phone"), { target: { value: "07700 900999" } });
    fireEvent.change(screen.getByLabelText(/Medical notes/), { target: { value: "Asthma\n  \nBad left knee " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/member/me");
    expect(patch?.body).toEqual({
      emergencyContactName: "Maria Link",
      emergencyContactPhone: "07700 900999",
      emergencyContactRelation: "Mother",
      medicalConditions: ["Asthma", "Bad left knee"],
    });
    expect(onSaved).toHaveBeenCalledWith({ name: "Maria Link", phone: "07700 900999", relation: "Mother" });
    expect(screen.getByText("07700 900999")).toBeTruthy();
    expect(screen.getByText("Asthma; Bad left knee")).toBeTruthy();
  });

  it("Cancel restores the stored values", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: ME }));
    render(<EmergencyMedicalSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit emergency contact/ }));
    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Someone Else" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Maria Link")).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("requires all three contact fields and says so", async () => {
    stubFetch(() => ({ ok: true, status: 200, body: ME }));
    render(<EmergencyMedicalSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit emergency contact/ }));
    fireEvent.change(screen.getByLabelText(/Relation/), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Enter all three/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("a 500 on load shows the error with retry, not an empty section", async () => {
    let fail = true;
    stubFetch(() => (fail ? { ok: false, status: 500, body: { error: "boom" } } : { ok: true, status: 200, body: ME }));
    render(<EmergencyMedicalSection />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load your emergency contact");
    expect(screen.queryByText(/No emergency contact on file/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit emergency contact/ })).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Maria Link")).toBeTruthy();
  });

  it("a failed save keeps the draft and shows the server's sentence", async () => {
    stubFetch((_url, method) =>
      method === "PATCH" ? { ok: false, status: 400, body: { error: "Phone is not valid" } } : { ok: true, status: 200, body: ME },
    );
    const onSaved = vi.fn();
    render(<EmergencyMedicalSection onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit emergency contact/ }));
    fireEvent.change(screen.getByLabelText("Their phone"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Phone is not valid");
    expect((screen.getByLabelText("Their phone") as HTMLInputElement).value).toBe("x");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a dropped request on save says nothing was saved and keeps the draft", async () => {
    stubFetch((_url, method) => (method === "PATCH" ? "throw" : { ok: true, status: 200, body: ME }));
    render(<EmergencyMedicalSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Edit emergency contact/ }));
    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Kay" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was saved");
    expect((screen.getByLabelText("Their name") as HTMLInputElement).value).toBe("Kay");
  });
});
