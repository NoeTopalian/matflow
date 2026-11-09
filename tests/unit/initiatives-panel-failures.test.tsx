// Round 1 (9 Nov 2026): the Initiatives panel says when a read or write
// fails, keeps what was typed, and never pretends an unknown outcome is known.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import React from "react";

// The destructive confirm is a dialog primitive; here it always confirms, so
// the test exercises what happens after the owner has agreed.
vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
  useConfirmDialog: () => ({ ask: async () => true, dialogProps: {} }),
}));

import InitiativesPanel from "@/components/dashboard/InitiativesPanel";

const ITEM = { id: "i1", type: "marketing", startDate: "2026-10-01T00:00:00.000Z", endDate: null, notes: "Flyers", attachments: [] };

let fetchMock: ReturnType<typeof vi.fn>;
const callsWith = (method?: string) =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? undefined) === method);

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  fetchMock = vi.fn(() => json([]));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("InitiativesPanel: reading", () => {
  it("shows a failed read as an error with Retry, never as 'No initiatives yet'", async () => {
    fetchMock.mockImplementationOnce(() => json({ error: "boom" }, 500));
    render(<InitiativesPanel primaryColor="#000" />);
    const alert = await screen.findByTestId("initiatives-load-error");
    expect(alert.textContent).toContain("Couldn't load initiatives.");
    expect(screen.queryByText(/No initiatives yet/)).toBeNull();

    // Retry re-reads and then shows the list.
    fetchMock.mockImplementationOnce(() => json([ITEM]));
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("Flyers");
    expect(callsWith(undefined).length).toBe(2);
  });

  it("shows a network failure the same way", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<InitiativesPanel primaryColor="#000" />);
    expect((await screen.findByTestId("initiatives-load-error")).textContent).toContain("Couldn't load");
  });

  it("still shows the empty state when the read succeeds with no rows", async () => {
    render(<InitiativesPanel primaryColor="#000" />);
    expect(await screen.findByText(/No initiatives yet/)).toBeTruthy();
  });
});

describe("InitiativesPanel: creating", () => {
  async function openFormAndType() {
    render(<InitiativesPanel primaryColor="#000" />);
    await screen.findByText(/No initiatives yet/);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "Open mat flyer" } });
  }

  it("keeps the draft and says why when the server rejects the save", async () => {
    await openFormAndType();
    fetchMock.mockImplementationOnce(() => json({ error: "Invalid data", details: { secret: "never shown" } }, 400));
    fireEvent.click(screen.getByRole("button", { name: "Save initiative" }));
    const alert = await screen.findByTestId("initiative-create-error");
    expect(alert.textContent).toBe("Couldn't save: Invalid data. Your entries are kept.");
    expect(alert.textContent).not.toContain("never shown");
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("Open mat flyer");
    expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-11-01");
    // The save button is usable again; nothing was retried on its own.
    expect(callsWith("POST").length).toBe(1);
    expect((screen.getByRole("button", { name: "Save initiative" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the outcome is unknown when no reply arrives, and does not claim nothing changed", async () => {
    await openFormAndType();
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    fireEvent.click(screen.getByRole("button", { name: "Save initiative" }));
    const alert = await screen.findByTestId("initiative-create-error");
    expect(alert.textContent).toContain("isn't known whether this was saved");
    expect(alert.textContent).not.toMatch(/nothing changed/i);
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe("Open mat flyer");
    expect(callsWith("POST").length).toBe(1);
  });

  it("closes and clears the form only after the server confirms", async () => {
    await openFormAndType();
    fetchMock.mockImplementationOnce(() => json({ ...ITEM, id: "i2", notes: "Open mat flyer" }, 201));
    fireEvent.click(screen.getByRole("button", { name: "Save initiative" }));
    await screen.findByText("Open mat flyer");
    expect(screen.queryByTestId("initiative-create-error")).toBeNull();
  });
});

describe("InitiativesPanel: deleting", () => {
  it("keeps the row and says so when deletion is refused", async () => {
    fetchMock.mockImplementationOnce(() => json([ITEM]));
    render(<InitiativesPanel primaryColor="#000" />);
    await screen.findByText("Flyers");
    fetchMock.mockImplementationOnce(() => json({ error: "Failed to delete initiative" }, 500));
    fireEvent.click(screen.getByRole("button", { name: /^Delete .*initiative/ }));
    const alert = await screen.findByTestId("initiative-delete-error");
    expect(alert.textContent).toContain("It is still here.");
    expect(screen.getByText("Flyers")).toBeTruthy();
    expect(callsWith("DELETE").length).toBe(1);
  });

  it("does not drop the row on a lost response; it offers a refresh instead", async () => {
    fetchMock.mockImplementationOnce(() => json([ITEM]));
    render(<InitiativesPanel primaryColor="#000" />);
    await screen.findByText("Flyers");
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    fireEvent.click(screen.getByRole("button", { name: /^Delete .*initiative/ }));
    const alert = await screen.findByTestId("initiative-delete-error");
    expect(alert.textContent).toContain("isn't known whether this was deleted");
    expect(screen.getByText("Flyers")).toBeTruthy();
    // "Refresh list" re-reads; it never repeats the DELETE.
    fetchMock.mockImplementationOnce(() => json([]));
    fireEvent.click(within(alert).getByRole("button", { name: "Refresh list" }));
    await waitFor(() => expect(screen.queryByText("Flyers")).toBeNull());
    expect(callsWith("DELETE").length).toBe(1);
  });

  it("removes the row only when the server confirms", async () => {
    fetchMock.mockImplementationOnce(() => json([ITEM]));
    render(<InitiativesPanel primaryColor="#000" />);
    await screen.findByText("Flyers");
    fetchMock.mockImplementationOnce(() => json({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete .*initiative/ }));
    await waitFor(() => expect(screen.queryByText("Flyers")).toBeNull());
  });
});
