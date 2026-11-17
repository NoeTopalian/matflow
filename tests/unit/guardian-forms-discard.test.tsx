// @vitest-environment jsdom
//
// Round 11 (baseline 5.4, with 5.2): a guardian's Edit child form and the child waiver
// (a drawn signature) were thrown away by one stray tap on the backdrop; neither moved or
// kept focus, and the waiver had no Escape. Each now asks "Discard your changes?" once
// something is entered; a form nobody touched closes at once. Edit child is titled with the
// child's name.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import EditChildModal from "@/components/member/EditChildModal";
import KidPhotosAndWaiver from "@/components/member/KidPhotosAndWaiver";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = "";
});

globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

const question = () => screen.queryByRole("dialog", { name: "Discard your changes?" });
const backdrop = (dialog: HTMLElement) => dialog.parentElement as HTMLElement;
const KID = { id: "k1", name: "Mia Lee", dateOfBirth: null };

async function mountChild(kid: typeof KID | null = KID) {
  const onClose = vi.fn();
  render(<EditChildModal primaryColor="#3b82f6" kid={kid} onClose={onClose} onSaved={() => {}} />);
  await act(async () => {});
  return onClose;
}

describe("Edit child", () => {
  it("is titled with the child's name and starts on the name field", async () => {
    await mountChild();
    expect(screen.getByRole("dialog", { name: "Edit Mia Lee" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("untouched: a backdrop tap closes at once", async () => {
    const onClose = await mountChild();
    fireEvent.click(backdrop(screen.getByRole("dialog", { name: "Edit Mia Lee" })));
    expect(question()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("changed: the backdrop asks; Keep editing keeps the text", async () => {
    const onClose = await mountChild();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mia Lee-Smith" } });
    fireEvent.click(backdrop(screen.getByRole("dialog", { name: "Edit Mia Lee" })));
    expect(question()).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep editing" })); });
    expect(question()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Mia Lee-Smith");
  });

  it("changed: Escape asks, a second Escape keeps editing; × then Discard closes", async () => {
    const onClose = await mountChild(null);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sam" } });
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(question()).not.toBeNull();
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(question()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard changes" })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Child waiver", () => {
  async function openWaiver() {
    render(<KidPhotosAndWaiver childId="k1" childName="Mia Lee" waiverAccepted={false} initialPhotos={[]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Sign waiver/ }));
    await act(async () => {});
    return screen.getByRole("dialog", { name: "Sign waiver — Mia Lee" });
  }

  it("untouched: a backdrop tap closes it", async () => {
    const dialog = await openWaiver();
    fireEvent.click(backdrop(dialog));
    expect(question()).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Sign waiver — Mia Lee" })).toBeNull();
  });

  it("with a name typed: the backdrop asks and Keep editing keeps the waiver open with the name", async () => {
    const dialog = await openWaiver();
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ana Lee" } });
    fireEvent.click(backdrop(dialog));
    expect(question()).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Keep editing" })); });
    expect(screen.getByRole("dialog", { name: "Sign waiver — Mia Lee" })).toBeTruthy();
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Ana Lee");
  });

  it("Escape now closes an untouched waiver (it had none)", async () => {
    await openWaiver();
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(screen.queryByRole("dialog", { name: "Sign waiver — Mia Lee" })).toBeNull();
  });
});
