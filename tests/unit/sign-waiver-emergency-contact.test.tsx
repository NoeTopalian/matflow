// @vitest-environment jsdom
//
// F-21 (customer simulation retest, 26 Sep): POST /api/waiver/sign refuses
// "Emergency contact name, phone, and relation are required before signing."
// when any of the three is missing, and the member's own waiver form offered no
// field for them — a dead end on the phone for anyone who skipped the welcome
// wizard. The form now asks for the missing contact and saves it through
// PATCH /api/member/me before signing. The server gate is unchanged.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/components/ui/SignaturePad", () => ({
  __esModule: true,
  default: React.forwardRef(function MockPad(
    props: { onChange?: (empty: boolean) => void },
    ref: React.Ref<{ getDataUrl: () => string }>,
  ) {
    React.useImperativeHandle(ref, () => ({ getDataUrl: () => "data:image/png;base64,iVBORw0KGgo=" }));
    return (
      <button type="button" data-testid="draw" onClick={() => props.onChange?.(false)}>
        draw
      </button>
    );
  }),
}));

import SignWaiverSection from "@/components/member/SignWaiverSection";

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/waiver") return { ok: true, json: async () => ({ title: "Waiver", content: "Text" }) };
      if (url === "/api/waiver/sign") return { ok: true, status: 201, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    }),
  );
});

// HARNESS FIX (30 Sep 2026): signing now waits until the club's waiver text
// is on screen (end-user review: a member signed while a placeholder showed).
// These cases signed synchronously, before the text loaded; they now wait for it.
async function signReady() {
  await screen.findByText("Text");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByTestId("draw"));
}

describe("SignWaiverSection — emergency contact (F-21)", () => {
  it("asks for a missing emergency contact and saves it before signing", async () => {
    const onSigned = vi.fn();
    render(
      <SignWaiverSection
        primaryColor="#123456"
        defaultName="Ana Link"
        emergencyContact={{ name: null, phone: null, relation: null }}
        onSigned={onSigned}
      />,
    );
    await signReady();
    const button = screen.getByRole("button", { name: "Sign waiver" });
    expect((button as HTMLButtonElement).disabled).toBe(true); // contact still empty

    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Maria Link" } });
    fireEvent.change(screen.getByLabelText("Their phone"), { target: { value: "07700 900123" } });
    fireEvent.change(screen.getByLabelText(/How you know them/), { target: { value: "Mother" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(onSigned).toHaveBeenCalled());

    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual(["PATCH /api/member/me", "POST /api/waiver/sign"]);
    expect(writes[0].body).toEqual({
      emergencyContactName: "Maria Link",
      emergencyContactPhone: "07700 900123",
      emergencyContactRelation: "Mother",
    });
  });

  it("does not sign when saving the contact fails, and says why", async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: undefined });
      if (url === "/api/member/me") return { ok: false, status: 400, json: async () => ({ error: "Phone is not valid" }) };
      if (url === "/api/waiver") return { ok: true, json: async () => ({ title: "Waiver", content: "Text" }) };
      return { ok: true, json: async () => ({}) };
    });
    const onSigned = vi.fn();
    render(<SignWaiverSection primaryColor="#123456" defaultName="Ana" emergencyContact={{ name: "M", phone: null, relation: "Mother" }} onSigned={onSigned} />);
    await signReady();
    fireEvent.change(screen.getByLabelText("Their phone"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Phone is not valid");
    expect(onSigned).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === "/api/waiver/sign")).toBe(false);
  });

  it("shows no contact fields and writes nothing extra when the contact is on file", async () => {
    const onSigned = vi.fn();
    render(
      <SignWaiverSection
        primaryColor="#123456"
        defaultName="Ben"
        emergencyContact={{ name: "Kay", phone: "07700 900456", relation: "Partner" }}
        onSigned={onSigned}
      />,
    );
    expect(screen.queryByLabelText("Their name")).toBeNull();
    await signReady();
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await waitFor(() => expect(onSigned).toHaveBeenCalled());
    expect(calls.filter((c) => c.method !== "GET").map((c) => c.url)).toEqual(["/api/waiver/sign"]);
  });

  // End-user review (30 Sep 2026): signing was possible while a placeholder
  // waiver showed, and the record then said the club's text was agreed.
  it("cannot sign until the club's waiver is on screen, and sends the text it showed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "/api/waiver") { await gate; return { ok: true, json: async () => ({ title: "Club waiver", content: "Club text" }) }; }
      if (url === "/api/waiver/sign") return { ok: true, status: 201, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({}) };
    });
    const onSigned = vi.fn();
    render(<SignWaiverSection primaryColor="#123456" defaultName="Ben" emergencyContact={{ name: "Kay", phone: "07700 900456", relation: "Partner" }} onSigned={onSigned} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("draw"));
    expect(screen.getByText("Loading your gym's waiver…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign waiver" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText("Club text");
    fireEvent.click(screen.getByRole("button", { name: "Sign waiver" }));
    await waitFor(() => expect(onSigned).toHaveBeenCalled());
    const sign = calls.find((c) => c.url === "/api/waiver/sign")!;
    expect(sign.body).toMatchObject({ shownTitle: "Club waiver", shownContent: "Club text" });
  });

  // Verifier lane 2 (30 Sep 2026): a contact saved in Profile's "Emergency &
  // medical" section must satisfy this form without a reload.
  it("stops asking once the page passes in a completed contact", () => {
    const { rerender } = render(
      <SignWaiverSection primaryColor="#123456" defaultName="Hal" emergencyContact={{ name: null, phone: null, relation: null }} />,
    );
    expect(screen.queryByLabelText("Their name")).not.toBeNull();
    rerender(
      <SignWaiverSection primaryColor="#123456" defaultName="Hal" emergencyContact={{ name: "Kay", phone: "07700 900456", relation: "Partner" }} />,
    );
    expect(screen.queryByLabelText("Their name")).toBeNull();
  });
});
